import assert from 'node:assert/strict';
import test from 'node:test';
import { httpFixture } from './helpers.js';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestCancellations } from '../src/request-cancellations.js';
import { toolClient, call, output } from './tool-client.js';
import { fixture } from './helpers.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

test('system_info reflects token permissions and live owner settings', async (t) => {
  const instance = await httpFixture(t);
  const reader = await instance.service.tokens.create({
    name: 'Capabilities reader',
    permissions: ['files:read'],
  });
  const response = await fetch(`${instance.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${reader.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'system_info', arguments: {} },
    }),
  });
  const body = await response.json();
  assert.equal(body.result.structuredContent.shell_enabled, false);
  assert.deepEqual(body.result.structuredContent.permissions, ['files:read']);
});

test('disconnecting a request cancels its pending command approval', async (t) => {
  const instance = await httpFixture(t);
  await instance.service.settings.update({ approval: { policy: 'once' } });
  const controller = new AbortController();
  const pending = fetch(`${instance.url}/mcp`, {
    method: 'POST',
    headers: {
      ...instance.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'run_command', arguments: { command: 'echo cancelled', wait_ms: 0 } },
    }),
  });
  const rejected = assert.rejects(pending);
  for (let n = 0; !instance.service.approvals.list().length && n < 100; n++) await delay(20);
  assert.equal(instance.service.approvals.list().length, 1);
  controller.abort();
  await rejected;
  for (let n = 0; instance.service.approvals.list().length && n < 100; n++) await delay(20);
  assert.equal(instance.service.approvals.list().length, 0);
  assert.equal(instance.service.processes.listAll().length, 0);
});

test('cancellation identifiers are owner-scoped and ambiguous shared-key IDs are not broadcast', () => {
  const registry = new RequestCancellations();
  const first = registry.track('a', 7),
    other = registry.track('b', 7);
  assert.equal(registry.cancel('b', 7), true);
  assert.equal(first.signal.aborted, false);
  assert.equal(other.signal.aborted, true);
  const duplicate = registry.track('a', 7);
  assert.equal(registry.cancel('a', 7), false);
  assert.equal(duplicate.signal.aborted, false);
  duplicate.finish();
  assert.equal(registry.cancel('a', 7), true);
  assert.equal(first.signal.aborted, true);
  registry.close();
});

test('MCP cancellation notification withdraws a pending command before execution', async (t) => {
  const instance = await httpFixture(t);
  await instance.service.settings.update({ approval: { policy: 'once' } });
  const headers = {
    ...instance.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const pending = fetch(instance.url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'run_command', arguments: { command: 'echo should-not-run' } },
    }),
  });
  for (let n = 0; instance.service.approvals.list().length === 0 && n < 100; n++) await delay(20);
  assert.equal(instance.service.approvals.list().length, 1);
  const cancelled = await fetch(instance.url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 99 },
    }),
  });
  assert.equal(cancelled.status, 202);
  const result = await (await pending).json();
  assert.equal(result.result.isError, true);
  assert.equal(result.result._meta['tmcp/error'].code, 'cancelled');
  assert.equal(instance.service.approvals.list().length, 0);
  assert.equal(instance.service.processes.listAll().length, 0);
});

test('gateway credential configuration is protected and live disabled capabilities are not advertised', async (t) => {
  const base = await fixture(t);
  base.config.serversFile = path.join(base.root, 'backend.json');
  await writeFile(base.config.serversFile, '{"mcpServers":{}}');
  const instance = await httpFixture(t, base.config);
  await instance.service.settings.update({ shell: { enabled: false } });
  const client = await toolClient(t, instance.url, instance.headers);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert(!names.includes('run_command'));
  assert(!names.includes('write_command_input'));
  assert(names.includes('stop_command'));
  assert.equal((await output(client, 'system_info')).shell_enabled, false);
  await call(client, 'read_file', { path: 'backend.json' }, true);
  await call(client, 'write_file', { path: 'backend.json', content: '{}', overwrite: true }, true);
  await call(client, 'delete_path', { path: 'backend.json' }, true);
});
