import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { httpFixture, jsonBody } from './helpers.js';

test('HTTP auth, Host/Origin validation, metadata and stateless JSON transport', async (t) => {
  const { url, config, headers } = await httpFixture(t);
  const rejected = await fetch(`${url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/);
  assert.equal(
    (await fetch(`${url}/mcp?token=${config.bearerToken}`, { method: 'POST' })).status,
    401,
  );
  assert.equal(
    (await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer invalid' } }))
      .status,
    401,
  );
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    request(`${url}/health`, { headers: { Host: 'rebind.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on('error', reject)
      .end();
  });
  assert.equal(rebound, 403);
  assert.equal(
    (
      await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
  const metadata = await jsonBody(
    await fetch(`${url}/.well-known/oauth-protected-resource/mcp`, {
      headers: { 'X-Forwarded-Host': 'evil.example' },
    }),
  );
  assert.equal(metadata.resource, `${url}/mcp`);
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.equal((await jsonBody(response)).id, 1);
  const malformed = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
});

test('control state reports Telegram only once the token and chat list are saved', async (t) => {
  const telegramApi = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        result: req.url?.endsWith('/getMe') ? { username: 'tmcp_test' } : [],
      }),
    );
  });
  await new Promise<void>((resolve) => telegramApi.listen(0, '127.0.0.1', resolve));
  const telegramAddress = telegramApi.address();
  if (!telegramAddress || typeof telegramAddress === 'string')
    throw new Error('Expected TCP address');
  const { service, config } = await httpFixture(t, undefined, {
    telegramApiBase: `http://127.0.0.1:${telegramAddress.port}`,
  });
  t.after(() => {
    telegramApi.closeAllConnections();
    telegramApi.close();
  });
  const control = createServer((req, res) => {
    service.controlApp(req, res);
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    control.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const admin = { Authorization: `Bearer ${config.adminToken}` };
  assert.equal((await fetch(`${base}/_control/api/state`)).status, 401);

  const before = await jsonBody(await fetch(`${base}/_control/api/state`, { headers: admin }));
  assert.deepEqual(before.telegram, { ok: false, message: 'Not configured' });
  assert.equal(before.telegramControl, false);

  // Token alone is not enough: without an allowed chat there is nobody to answer.
  await fetch(`${base}/_control/api/settings`, {
    method: 'PATCH',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram: { token: '123456:TEST', allowedChats: [] } }),
  });
  const tokenOnly = await jsonBody(await fetch(`${base}/_control/api/state`, { headers: admin }));
  assert.equal(tokenOnly.telegramControl, false, 'a token without chats must not report control');

  await fetch(`${base}/_control/api/settings`, {
    method: 'PATCH',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram: { token: '123456:TEST', allowedChats: ['42'] } }),
  });
  await service.telegram?.check();
  const ready = await jsonBody(await fetch(`${base}/_control/api/state`, { headers: admin }));
  assert.equal(ready.telegramControl, true, 'saving the token must not require a restart');
  assert.equal((ready.telegram as { ok: boolean }).ok, true);
  assert.equal((ready.telegram as { username: string }).username, 'tmcp_test');

  // Clearing the chats must take the bot back offline without a restart.
  await fetch(`${base}/_control/api/settings`, {
    method: 'PATCH',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram: { token: '', allowedChats: [] } }),
  });
  const cleared = await jsonBody(await fetch(`${base}/_control/api/state`, { headers: admin }));
  assert.equal(cleared.telegramControl, false);
  assert.equal((cleared.telegram as { status: string }).status, 'incomplete');
});

test('official MCP clients independently initialize and call native and gateway tools', async (t) => {
  const { url, headers } = await httpFixture(t);
  const clients = await Promise.all(
    [1, 2].map(async (index) => {
      const client = new Client({ name: `integration-${index}`, version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }),
      );
      return client;
    }),
  );
  t.after(() => Promise.all(clients.map((client) => client.close())));
  for (const client of clients) {
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === 'edit_file'));
    assert(listed.tools.some((tool) => tool.name === 'mcp_call_tool'));
    assert(!listed.tools.some((tool) => tool.name === 'take_screenshot'));
    const result = await client.callTool({ name: 'system_info', arguments: {} });
    assert(!result.isError);
    const forbidden = await client.callTool({
      name: 'read_file',
      arguments: { path: '../outside' },
    });
    assert.equal(forbidden.isError, true);
  }
});
