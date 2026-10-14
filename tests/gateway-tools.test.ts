import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture, httpFixture } from './helpers.js';
import { toolClient, call, output } from './tool-client.js';
import { Gateway } from '../src/gateway/gateway.js';

test('all gateway catalogue tools preserve backend data and cancel resource/tool calls', async (t) => {
  const base = await fixture(t);
  await writeFile(
    base.config.serversFile,
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [path.resolve('tests/fixtures/backend.mjs')] },
      },
    }),
  );
  const instance = await httpFixture(t, base.config);
  const client = await toolClient(t, instance.url, instance.headers);
  const servers = await output(client, 'mcp_list_servers');
  const id = (servers.servers as { id: string }[])[0]!.id;
  async function settled(name: string, args: Record<string, unknown>) {
    let result = await call(client, name, args);
    for (let i = 0; i < 20 && result._meta?.['gateway/status'] === 'running'; i++)
      result = await call(client, 'mcp_read_call', {
        call_id: result.structuredContent?.call_id,
        wait_ms: 1000,
      });
    assert.notEqual(result._meta?.['gateway/status'], 'running');
    return result;
  }
  const tools = await settled('mcp_list_tools', { server_id: id, query: 'echo' });
  assert.equal((tools.structuredContent?.tools as { name: string }[])[0]?.name, 'echo');
  const echo = await settled('mcp_call_tool', {
    server_id: id,
    tool: 'echo',
    arguments: { text: 'protocol verified' },
  });
  assert.deepEqual(echo.structuredContent, { echoed: 'protocol verified' });
  const resources = await settled('mcp_list_resources', { server_id: id });
  assert(
    (resources.structuredContent?.resources as { uri: string }[]).some(
      (r) => r.uri === 'fixture://hello',
    ),
  );
  const templates = await settled('mcp_list_resources', { server_id: id, templates: true });
  assert.equal(
    (templates.structuredContent?.resourceTemplates as { uriTemplate: string }[])[0]?.uriTemplate,
    'fixture://item/{id}',
  );
  const read = await settled('mcp_read_resource', { server_id: id, uri: 'fixture://item/42' });
  assert.equal((read.structuredContent?.contents as { text: string }[])[0]?.text, 'item 42');
  const prompts = await settled('mcp_list_prompts', { server_id: id });
  assert.equal((prompts.structuredContent?.prompts as { name: string }[])[0]?.name, 'greet');
  const prompt = await settled('mcp_get_prompt', {
    server_id: id,
    name: 'greet',
    arguments: { name: 'AI' },
  });
  assert.equal(
    (prompt.structuredContent?.messages as { content: { text: string } }[])[0]?.content.text,
    'Hello AI',
  );
  for (const [name, args] of [
    [
      'mcp_call_tool',
      { server_id: id, tool: 'echo', arguments: { text: 'cancel', delay_ms: 30000 }, wait_ms: 0 },
    ],
    ['mcp_read_resource', { server_id: id, uri: 'fixture://slow', wait_ms: 0 }],
  ] as const) {
    const pending = await output(client, name, args);
    assert.equal(pending.status, 'running');
    const cancelled = await output(client, 'mcp_cancel_call', { call_id: pending.call_id });
    assert.equal(cancelled.cancellation_requested, true);
    const final = await call(
      client,
      'mcp_read_call',
      { call_id: pending.call_id, wait_ms: 1000 },
      true,
    );
    assert.equal(final._meta?.['gateway/status'], 'cancelled');
    assert.equal(
      (await output(client, 'mcp_cancel_call', { call_id: pending.call_id }))
        .cancellation_requested,
      false,
    );
  }
  await output(client, 'mcp_reload_servers');
  await writeFile(base.config.serversFile, '{"mcpServers":{}}');
  assert.equal(((await output(client, 'mcp_reload_servers')).servers as unknown[]).length, 0);
  await call(
    client,
    'mcp_call_tool',
    { server_id: id, tool: 'echo', arguments: { text: 'removed' } },
    true,
  );
});

test('cancellation while a shared backend connects finishes immediately and names fit AI provider limits', async (t) => {
  const { config } = await fixture(t, {
    MCP_BACKEND_CONNECT_TIMEOUT_MS: '30000',
    MCP_GATEWAY_MODE: 'namespaced',
  });
  await writeFile(
    config.serversFile,
    JSON.stringify({
      mcpServers: {
        ['long_server_'.repeat(5)]: {
          command: process.execPath,
          args: [path.resolve('tests/fixtures/backend.mjs')],
          env: { FIXTURE_START_DELAY: '3000' },
        },
      },
    }),
  );
  const gateway = new Gateway(config, () => undefined);
  t.after(() => gateway.close());
  await gateway.reload(false);
  const id = gateway.listServers().servers[0]!.id;
  const pending = await gateway.callTool('one', id, 'echo', { text: 'cancel' }, 0);
  const start = performance.now();
  gateway.cancelCall('one', String(pending.structuredContent?.call_id));
  const result = await gateway.readCall('one', String(pending.structuredContent?.call_id), 1000);
  assert.equal(result.isError, true);
  assert(performance.now() - start < 1500);
  await gateway.warmup();
  assert(gateway.namespacedTools().length > 0);
  for (const tool of gateway.namespacedTools()) assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
  const completed = await gateway.callTool('one', id, 'echo', { text: 'expire' }, 1000);
  const callId = String(completed._meta?.['gateway/call_id']);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 10 * 60 * 1000 + 1);
  await assert.rejects(gateway.readCall('one', callId, 0), /expired/);
  assert.throws(() => gateway.cancelCall('one', callId), /Unknown/);
  t.mock.restoreAll();
});
