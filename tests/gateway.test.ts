import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Gateway } from '../src/gateway/gateway.js';
import { discoverServers } from '../src/gateway/discovery.js';
import { fixture, httpFixture } from './helpers.js';

const backendFile = path.resolve('tests/fixtures/backend.mjs');

test('cold backend catalogues return a job and initialization has a hard deadline', async (t) => {
  const { config } = await fixture(t, { MCP_BACKEND_CONNECT_TIMEOUT_MS: '1000' });
  await writeFile(
    config.serversFile,
    JSON.stringify({
      mcpServers: {
        delayed: {
          command: process.execPath,
          args: [backendFile],
          env: { FIXTURE_START_DELAY: '30000' },
        },
      },
    }),
  );
  const gateway = new Gateway(config, () => undefined);
  t.after(() => gateway.close());
  await gateway.reload();
  const id = gateway.listServers().servers[0]!.id;
  const started = Date.now();
  const initial = await gateway.catalogCall(
    'owner',
    id,
    'tools/list',
    () => gateway.listTools(id, undefined, '', 0, 10),
    0,
  );
  assert.equal(initial.structuredContent?.status, 'running');
  assert(Date.now() - started < 500);
  let result = initial;
  while (result._meta?.['gateway/status'] === 'running' && Date.now() - started < 10000)
    result = await gateway.readCall('owner', String(initial.structuredContent?.call_id), 1000);
  assert.equal(result.isError, true);
  assert(Date.now() - started < 10000);
});

test('discovery accepts JSONC, OpenCode command arrays and standard MCP config; deduplicates secrets privately', async (t) => {
  const { config, directory } = await fixture(t);
  const other = path.join(directory, 'opencode.jsonc');
  await writeFile(
    other,
    JSON.stringify({
      mcp: {
        example: {
          type: 'local',
          command: [process.execPath, backendFile],
          environment: { TEST: 'a-secret-value' },
        },
      },
    }),
  );
  await writeFile(
    config.serversFile,
    `// comment\n${JSON.stringify({ mcpServers: { duplicate: { command: process.execPath, args: [backendFile], env: { TEST: 'a-secret-value' } }, disabled: { command: 'unavailable', disabled: true }, bad: { command: 'node', env: { SECRET: '${env:PC_MCP_TEST_MISSING_ENV_12345}' } } } })}`,
  );
  config.configPaths = [other];
  const found = await discoverServers(config);
  assert.equal(found.servers.length, 1);
  assert.equal(found.servers[0]?.sources.length, 2);
  assert.equal(found.diagnostics.length, 1);
  const gateway = new Gateway(config, () => undefined);
  t.after(() => gateway.close());
  await gateway.reload();
  assert(!JSON.stringify(gateway.listServers()).includes('a-secret-value'));
});

test('stdio gateway preserves text/images/errors/resources/prompts, polls calls and isolates owners', async (t) => {
  const { config } = await fixture(t);
  await writeFile(
    config.serversFile,
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [backendFile] } } }),
  );
  const gateway = new Gateway(config, () => undefined);
  t.after(() => gateway.close());
  await gateway.reload();
  const id = gateway.listServers().servers[0]!.id;
  const [first, second] = await Promise.all([gateway.client(id), gateway.client(id)]);
  assert.equal(first, second);
  const tools = await gateway.listTools(id, undefined, 'echo', 0, 10);
  assert.equal(tools.tools[0]?.name, 'echo');
  const initial = await gateway.callTool('alice', id, 'echo', { text: 'hello', delay_ms: 200 }, 0);
  const callId = initial.structuredContent?.call_id;
  assert.equal(typeof callId, 'string');
  await assert.rejects(gateway.readCall('bob', String(callId), 0), /Unknown/);
  const result = await gateway.readCall('alice', String(callId), 2000);
  assert.deepEqual(result.structuredContent, { echoed: 'hello' });
  const image = await gateway.callTool('alice', id, 'tiny_image', {}, 2000);
  assert.equal(image.content[0]?.type, 'image');
  const failed = await gateway.callTool('alice', id, 'fail', {}, 2000);
  assert.equal(failed.isError, true);
  const resources = await first.listResources();
  assert.equal(resources.resources[0]?.uri, 'fixture://hello');
  const resource = (await first.readResource({ uri: 'fixture://hello' })).contents[0];
  assert(resource && 'text' in resource);
  assert.equal(resource.text, 'resource text');
  assert.equal(
    (await first.getPrompt({ name: 'greet', arguments: { name: 'MCP' } })).messages[0]?.content
      .type,
    'text',
  );
});

test('a dropped destructive backend call is not retried; a later call reconnects', async (t) => {
  const { config, directory } = await fixture(t);
  await writeFile(
    config.serversFile,
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [backendFile] } } }),
  );
  const gateway = new Gateway(config, () => undefined);
  t.after(() => gateway.close());
  await gateway.reload();
  const id = gateway.listServers().servers[0]!.id;
  const counter = path.join(directory, 'counter');
  const result = await gateway.callTool('owner', id, 'drop_after_increment', { counter }, 5000);
  assert.equal(result.isError, true);
  assert.equal(await readFile(counter, 'utf8'), '1');
  const reconnected = await gateway.callTool('owner', id, 'echo', { text: 'reconnected' }, 5000);
  assert.deepEqual(reconnected.structuredContent, { echoed: 'reconnected' });
});

test('namespaced mode exposes backend schemas over the public MCP interface', async (t) => {
  const { config } = await fixture(t, { MCP_GATEWAY_MODE: 'namespaced' });
  await writeFile(
    config.serversFile,
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [backendFile] } } }),
  );
  const { url, headers } = await httpFixture(t, config);
  const client = new Client({ name: 'namespace-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }),
  );
  t.after(() => client.close());
  const tools = await client.listTools();
  const echo = tools.tools.find((tool) => tool.name.includes('__echo_'));
  assert(echo);
  assert(echo.inputSchema.properties?.text);
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: echo.name, arguments: { text: 'forwarded' } }),
  );
  assert.deepEqual(result.structuredContent, { echoed: 'forwarded' });
});
