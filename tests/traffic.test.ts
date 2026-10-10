import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Traffic } from '../src/traffic.js';
import { httpFixture } from './helpers.js';
import { createUiFixture } from './ui-fixture.js';

test('traffic follows real MCP responses, including denied and protocol-error results', async (t) => {
  const instance = await httpFixture(t);
  const issued = await instance.service.tokens.create({
    name: 'Reader',
    permissions: ['files:read'],
  });
  await writeFile(path.join(instance.config.roots[0]!, 'note.txt'), 'private-response-content');
  const call = async (name: string, args: object, key = issued.token) => {
    const response = await fetch(`${instance.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    await response.arrayBuffer();
    return instance.service.traffic.snapshot().records![0]!;
  };
  const success = await call('read_file', { path: 'note.txt' });
  assert.equal(success.tokenId, issued.id);
  assert.equal(success.tokenName, 'Reader');
  assert.equal(success.phase, 'returned');
  assert.deepEqual(
    success.stages.map((stage) => stage.phase),
    ['received', 'authorized', 'running', 'returned'],
  );
  const denied = await call('write_file', {
    path: 'note.txt',
    content: 'private-argument-content',
  });
  assert.equal(denied.phase, 'denied');
  assert.equal(denied.httpStatus, 200, 'MCP tool refusals use an HTTP 200 error result');
  const unknown = await call('unknown_tool', {});
  assert.equal(unknown.phase, 'failed');
  const anonymous = await call('system_info', {}, 'invalid-key');
  assert.equal(anonymous.phase, 'denied');
  assert.equal(anonymous.tokenId, null);
  const view = instance.service.traffic.snapshot();
  assert.equal(view.stats.received, 4);
  assert.equal(view.stats.active, 0);
  assert.equal(view.stats.completed, 1);
  assert.equal(view.stats.denied, 2);
  assert.equal(view.stats.failed, 1);
  const serialized = JSON.stringify(view);
  for (const secret of [
    issued.token,
    'private-response-content',
    'private-argument-content',
    'invalid-key',
  ])
    assert(!serialized.includes(secret));
});

test('traffic retention and repeated close notifications do not inflate counters', () => {
  const traffic = new Traffic(3);
  for (let index = 0; index < 8; index++) {
    const span = traffic.begin('POST');
    span.finish(401, true);
    span.finish(401, false);
  }
  assert.equal(traffic.snapshot().records!.length, 3);
  assert.equal(traffic.snapshot().stats.received, 8);
  assert.equal(traffic.snapshot().stats.denied, 8);
  assert.equal(traffic.snapshot().stats.active, 0);
});

test('only the protected IPC listener streams activity, and shutdown closes the stream', async (t) => {
  const instance = await createUiFixture();
  t.after(() => instance.close());
  const base = new URL(instance.url).origin;
  assert.equal((await fetch(`${base}/_control/api/events`)).status, 404);
  assert.equal((await fetch(`${instance.publicUrl}/_control/api/events`)).status, 404);
  const stream = await instance.control('/_control/api/events', {
    signal: AbortSignal.timeout(5000),
  });
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"snapshot"/);
  await instance.service.close();
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});
