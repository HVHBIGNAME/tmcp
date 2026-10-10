import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fixture, httpFixture } from './helpers.js';
import { token } from '../src/utils.js';
import { controlDescriptor, readControlEndpoint } from '../src/ipc.js';

test('TCP never serves control routes, even with an issued key or an accidentally mounted control app', async (t) => {
  const instance = await httpFixture(t);
  const headers = instance.headers;
  assert.equal((await fetch(`${instance.url}/_control/status`, { headers })).status, 404);
  assert.equal(
    (await fetch(`${instance.url}/_control/shutdown`, { method: 'POST', headers })).status,
    404,
  );
  assert.equal((await fetch(`${instance.url}/_control/api/state`, { headers })).status, 404);

  const control = createServer(instance.service.controlApp);
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  t.after(() => {
    control.closeAllConnections();
    control.close();
  });
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/_control/bootstrap`);
  assert.equal(bootstrap.status, 403);
  assert.equal((await fetch(`${base}/_control/status`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/_control/status`)).status, 403);
  assert.equal(
    (
      await fetch(`${base}/_control/status`, {
        headers: { Host: 'tmcp.local', ...headers },
      })
    ).status,
    403,
  );
  assert.deepEqual(await (await instance.control('/_control/bootstrap')).json(), {
    service: 'pc-mcp-tunnel',
  });
});

test('legacy environment secrets have no MCP authority', async (t) => {
  const legacy = { MCP_TOKEN: token(), MCP_ADMIN_TOKEN: token() };
  const base = await fixture(t, legacy);
  const instance = await httpFixture(t, base.config);
  assert.equal('bearerToken' in instance.config, false);
  assert.equal('adminToken' in instance.config, false);
  for (const key of Object.values(legacy)) {
    const response = await fetch(`${instance.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(response.status, 401);
    await assert.rejects(instance.service.auth.verifyAccessToken(key), /Invalid/);
  }
  assert.equal((await fetch(`${instance.url}/mcp`, { headers: instance.headers })).status, 405);
});

test('credentials are not readable through MCP file tools', async (t) => {
  const base = await fixture(t);
  await writeFile(path.join(base.directory, '.env'), 'CLOUDFLARE_TUNNEL_TOKEN=super-secret\n');
  await writeFile(path.join(base.config.dataDir, 'stored-secret.txt'), 'tg-secret');
  await writeFile(path.join(base.root, 'note.txt'), 'ordinary file');
  // The realistic setup: a workspace root that also contains the installation.
  const instance = await httpFixture(t, {
    ...base.config,
    roots: [base.directory],
    projectDir: base.directory,
    port: 0,
  });
  const call = (name: string, args: Record<string, unknown>) =>
    fetch(`${instance.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${instance.key}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  const read = async (target: string) => (await call('read_file', { path: target })).text();

  const env = await read(path.join(base.directory, '.env'));
  assert.match(env, /not readable through MCP tools/);
  assert.doesNotMatch(env, /super-secret/);

  const settings = await read(path.join(base.config.dataDir, 'stored-secret.txt'));
  assert.doesNotMatch(settings, /tg-secret/);

  const searched = await (
    await call('search_text', { path: base.directory, query: 'super-secret' })
  ).text();
  assert.doesNotMatch(searched, /super-secret/);

  const note = await read(path.join(base.root, 'note.txt'));
  assert.match(note, /ordinary file/);
});

test('file tools cannot read or replace control descriptors or Unix sockets', async (t) => {
  const base = await fixture(t);
  const instance = await httpFixture(t, { ...base.config, roots: [base.directory, os.tmpdir()] });
  const targets = [controlDescriptor(instance.config.dataDir)];
  if (process.platform !== 'win32')
    targets.push(await readControlEndpoint(instance.config.dataDir));
  for (const target of targets) {
    for (const name of ['read_file', 'write_file', 'delete_path']) {
      const response = await fetch(`${instance.url}/mcp`, {
        method: 'POST',
        headers: {
          ...instance.headers,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { path: target, content: 'blocked' } },
        }),
      });
      const result = await response.json();
      assert.equal(result.result?.isError, true, name);
    }
  }
  assert.equal((await instance.control('/_control/bootstrap')).status, 200);
});

test('a forged X-Forwarded-For cannot reset a rate limit', async (t) => {
  const instance = await httpFixture(t);
  const redirectUri = 'http://127.0.0.1:5599/callback';
  const registration = await fetch(`${instance.url}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const clientId = ((await registration.json()) as { client_id: string }).client_id;
  const authorize = async () => {
    const url = new URL(`${instance.url}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'x',
      resource: `${instance.url}/mcp`,
    }).toString();
    const page = await fetch(url, { redirect: 'manual' });
    const id = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1];
    return {
      id,
      cookie: page.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; '),
    };
  };
  const limited = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const session = await authorize();
    const response = await fetch(`${instance.url}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookie,
        'CF-Connecting-IP': '203.0.113.9',
        'X-Forwarded-For': `198.51.100.${attempt}`,
      },
      body: new URLSearchParams({
        request_id: session.id!,
        access_token: instance.key,
        approve: 'yes',
      }).toString(),
    });
    limited.push(response.status);
  }
  assert.equal(limited.filter((status) => status === 429).length, 2, `got ${limited.join(',')}`);

  const other = await authorize();
  const elsewhere = await fetch(`${instance.url}/oauth/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: other.cookie,
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: new URLSearchParams({
      request_id: other.id!,
      access_token: instance.key,
      approve: 'yes',
    }).toString(),
  });
  assert.equal(elsewhere.status, 303);
});

test('the OAuth endpoints stay rate limited behind the tunnel', async (t) => {
  const instance = await httpFixture(t);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    const response = await fetch(`${instance.url}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'CF-Connecting-IP': '203.0.113.44',
        'X-Forwarded-For': `198.51.100.${attempt}`,
      },
      body: 'grant_type=authorization_code',
    });
    statuses.push(response.status);
  }
  assert.equal(statuses.at(0), 400);
  assert.equal(statuses.at(-1), 429);
});

test('client registration is rate limited', async (t) => {
  const instance = await httpFixture(t);
  const register = () =>
    fetch(`${instance.url}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.30' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 22; attempt++) statuses.push((await register()).status);
  assert.equal(statuses.at(0), 201);
  assert.equal(statuses.at(-1), 429);
});
