import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthStore } from '../src/auth/store.js';
import { AuthProvider, type AccessBinding } from '../src/auth/provider.js';
import { TokenStore } from '../src/auth/tokens.js';
import { hash, token } from '../src/utils.js';
import { fixture, httpFixture, jsonBody } from './helpers.js';

function issuedAccess(tokens: TokenStore): AccessBinding {
  return {
    resolve: (presented) => {
      const found = tokens.find(presented);
      return found
        ? { tokenId: found.id, tokenHash: hash(presented), name: 'Issued test key' }
        : undefined;
    },
    verify: (binding) => tokens.activeById(binding.tokenId, binding.tokenHash),
  };
}

test('OAuth requires an issued key, CSRF session and PKCE; codes are one-use and bound to the client', async (t) => {
  const { config, url, key } = await httpFixture(t);
  const register = () =>
    fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example/callback?keep=yes'],
        client_name: '<script>example</script>',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
  const client = OAuthClientInformationFullSchema.parse(await (await register()).json());
  const other = OAuthClientInformationFullSchema.parse(await (await register()).json());
  const verifier = token();
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: client.redirect_uris[0]!,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'pc:access',
    resource: `${url}/mcp`,
  });
  const page = await fetch(`${url}/authorize?${query}`, { redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes('&lt;script&gt;example&lt;/script&gt;'));
  assert(!html.includes('MCP_ADMIN_TOKEN'));
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert(requestId);
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const approve = (key: string, session = cookie) =>
    fetch(`${url}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session },
      body: new URLSearchParams({
        request_id: requestId,
        access_token: key,
        approve: 'yes',
      }),
      redirect: 'manual',
    });
  assert(html.includes('name="access_token"'));
  assert(!html.includes(key));
  assert.equal((await approve(key, '')).status, 400);
  const approved = await approve(key);
  assert.equal(approved.status, 303);
  const redirect = new URL(approved.headers.get('location')!);
  assert.equal(redirect.searchParams.get('keep'), 'yes');
  assert.equal(redirect.searchParams.get('state'), 'state-123');
  const code = redirect.searchParams.get('code');
  assert(code);
  const exchange = (clientId: string, proof: string, resource = `${url}/mcp`) =>
    fetch(`${url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: proof,
        redirect_uri: client.redirect_uris[0]!,
        resource,
      }),
    });
  assert.equal((await exchange(client.client_id, token())).status, 400);
  assert.equal((await exchange(other.client_id, verifier)).status, 400);
  assert.equal(
    (await exchange(client.client_id, verifier, 'https://other.example/mcp')).status,
    400,
  );
  const redeemed = await exchange(client.client_id, verifier);
  assert.equal(redeemed.status, 200);
  const tokens = OAuthTokensSchema.parse(await redeemed.json());
  assert(tokens.refresh_token);
  assert.equal((await exchange(client.client_id, verifier)).status, 400);
  assert.equal(
    (await fetch(`${url}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }))
      .status,
    405,
  );

  const reopened = await AuthStore.open(config.dataDir);
  const provider = new AuthProvider(
    config,
    reopened,
    issuedAccess(await TokenStore.open(config.dataDir)),
  );
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  assert.equal(
    (await provider.verifyAccessToken(refreshed.access_token)).clientId,
    client.client_id,
  );
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), /reuse/);
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token), /Invalid/);
});

test('OAuth rejects unsafe redirect URIs; rotating the issued key revokes bound grants', async (t) => {
  const { config, url, service, key } = await httpFixture(t);
  for (const redirect of [
    'http://untrusted.example/callback',
    'javascript:alert(1)',
    'https://safe.example/callback#fragment',
  ]) {
    assert.equal(
      (
        await fetch(`${url}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [redirect] }),
        })
      ).status,
      400,
    );
  }
  const metadata = await jsonBody(await fetch(`${url}/.well-known/oauth-authorization-server`));
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  const store = await AuthStore.open(config.dataDir);
  const access = issuedAccess(service.tokens);
  const grantToken = token();
  await store.transaction((draft) =>
    draft.grants.push({
      id: 'test',
      clientId: 'test',
      scopes: ['pc:access'],
      resource: `${url}/mcp`,
      expiresAt: Date.now() + 60000,
      accessHash: hash(grantToken),
      accessExpiresAt: Date.now() + 60000,
      refreshHash: hash(token()),
      usedRefreshHashes: [],
      binding: access.resolve(key),
    }),
  );
  assert.equal(
    (await new AuthProvider(config, store, access).verifyAccessToken(grantToken)).clientId,
    'test',
  );
  await service.tokens.rotate(service.tokens.find(key)!.id);
  const rotatedStore = await AuthStore.open(config.dataDir);
  await assert.rejects(
    new AuthProvider(config, rotatedStore, access).verifyAccessToken(grantToken),
  );
  service.setPublicUrl('https://gateway.example');
  const updated = await jsonBody(await fetch(`${url}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(updated.resource, 'https://gateway.example/mcp');
});

async function beginConsent(instance: Awaited<ReturnType<typeof httpFixture>>) {
  const redirectUri = 'http://127.0.0.1:5599/callback';
  const registration = await fetch(`${instance.url}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://chatgpt.com' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const registered = await registration.text();
  assert.equal(registration.status, 201, registered);
  const clientId = (JSON.parse(registered) as { client_id: string }).client_id;
  const verifier = token();
  const url = new URL(`${instance.url}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'live',
    resource: `${instance.url}/mcp`,
  }).toString();
  const page = await fetch(url, { redirect: 'manual', headers: { Origin: 'https://chatgpt.com' } });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(id);
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  return { clientId, redirectUri, verifier, id, cookie, url: instance.url };
}

function submitConsent(
  session: Awaited<ReturnType<typeof beginConsent>>,
  form: Record<string, string> = {},
  origin?: string,
) {
  return fetch(`${session.url}/oauth/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookie,
      ...(origin ? { Origin: origin } : {}),
    },
    body: new URLSearchParams({ request_id: session.id, approve: 'yes', ...form }).toString(),
  });
}

test('an embedder origin completes consent and registration for browser clients', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const approved = await submitConsent(
    session,
    { access_token: instance.key },
    'https://chatgpt.com',
  );
  assert.equal(approved.status, 303, await approved.text());
  assert.equal(new URL(approved.headers.get('location')!).searchParams.get('state'), 'live');

  const denied = await submitConsent(session, { deny: 'yes' });
  assert.equal(denied.status, 400);
});

test('consent requires a valid access token, the CSRF session and a single use', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const missing = await submitConsent(session, {});
  assert.equal(missing.status, 401);
  assert.match(await missing.text(), /Токен не подошёл/);

  const wrong = await submitConsent(await beginConsent(instance), {
    access_token: 'x'.repeat(43),
  });
  assert.equal(wrong.status, 401);

  const paused = await instance.service.tokens.create({
    name: 'Paused',
    permissions: ['files:read'],
  });
  await instance.service.tokens.update(paused.id, { enabled: false });
  const refused = await submitConsent(await beginConsent(instance), { access_token: paused.token });
  assert.equal(refused.status, 401);

  const first = await submitConsent(await beginConsent(instance), {
    access_token: instance.key,
  });
  assert.equal(first.status, 303);

  const other = await beginConsent(instance);
  const withoutCookie = await fetch(`${other.url}/oauth/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      request_id: other.id,
      approve: 'yes',
      access_token: instance.key,
    }).toString(),
  });
  assert.equal(withoutCookie.status, 400);
  assert.match(await withoutCookie.text(), /Сессия браузера не совпала/);
});

function exchangeConsent(session: Awaited<ReturnType<typeof beginConsent>>, code: string) {
  return fetch(`${session.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.verifier,
      resource: `${session.url}/mcp`,
    }).toString(),
  });
}

test('legacy master and admin secrets cannot approve OAuth consent', async (t) => {
  const legacy = { MCP_TOKEN: token(), MCP_ADMIN_TOKEN: token() };
  const base = await fixture(t, legacy);
  const instance = await httpFixture(t, base.config);
  const session = await beginConsent(instance);
  for (const presented of Object.values(legacy))
    assert.equal((await submitConsent(session, { access_token: presented })).status, 401);
  assert.equal((await submitConsent(session, { access_token: instance.key })).status, 303);
});

test('consent and issued codes survive independent restarts at the same resource', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  await instance.restart();
  const approved = await submitConsent(session, { access_token: instance.key });
  assert.equal(approved.status, 303, await approved.text());
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  await instance.restart();
  const exchanged = await exchangeConsent(session, code);
  assert.equal(exchanged.status, 200, await exchanged.text());
  await instance.restart();
  assert.equal((await exchangeConsent(session, code)).status, 400);
});

test('concurrent approval and redemption consume each authorization exactly once', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () => submitConsent(session, { access_token: instance.key })),
  );
  assert.deepEqual(attempts.map((response) => response.status).sort(), [303, 400, 400, 400]);
  const approved = attempts.find((response) => response.status === 303)!;
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const exchanged = await Promise.all(
    Array.from({ length: 4 }, () => exchangeConsent(session, code)),
  );
  assert.deepEqual(exchanged.map((response) => response.status).sort(), [200, 400, 400, 400]);
  await instance.restart();
  assert.equal((await exchangeConsent(session, code)).status, 400);
});

test('denial is durable and pending consent never changes its resource after restart', async (t) => {
  const instance = await httpFixture(t);
  const denied = await beginConsent(instance);
  assert.equal((await submitConsent(denied, { deny: 'yes' })).status, 303);
  const pending = await beginConsent(instance);
  await instance.restart();
  assert.equal((await submitConsent(denied, { access_token: instance.key })).status, 400);
  instance.service.setPublicUrl('https://different.example');
  assert.equal((await submitConsent(pending, { access_token: instance.key })).status, 400);
});

test('key rotation invalidates issued codes and requires a fresh key at pending consent', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const approved = await submitConsent(session, { access_token: instance.key });
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const pending = await beginConsent(instance);
  const rotated = await instance.service.tokens.rotate(
    instance.service.tokens.find(instance.key)!.id,
  );
  await instance.restart();
  assert.equal((await exchangeConsent(session, code)).status, 400);
  assert.equal((await submitConsent(pending, { access_token: instance.key })).status, 401);
  assert.equal((await submitConsent(pending, { access_token: rotated.token })).status, 303);
});

test('a failed OAuth write never sends a success redirect or consumes consent', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const moved = `${instance.config.dataDir}-unavailable`;
  await rename(instance.config.dataDir, moved);
  try {
    const failed = await submitConsent(session, { access_token: instance.key });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('location'), null);
  } finally {
    await rename(moved, instance.config.dataDir);
  }
  assert.equal((await submitConsent(session, { access_token: instance.key })).status, 303);
});

test('an expired or foreign attempt shows a readable page, not a JSON error', async (t) => {
  const instance = await httpFixture(t);
  const stale = await fetch(`${instance.url}/oauth/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'pc_mcp_stale=value' },
    body: new URLSearchParams({ request_id: 'unknown', approve: 'yes' }).toString(),
  });
  assert.equal(stale.status, 400);
  assert.match(stale.headers.get('content-type') ?? '', /text\/html/);
  const page = await stale.text();
  assert.match(page, /Подключение истекло/);
  assert.doesNotMatch(page, /Authorization expired/);

  const session = await beginConsent(instance);
  const wrongToken = await submitConsent(session, { access_token: 'nope' });
  assert.equal(wrongToken.status, 401);
  assert.match(wrongToken.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await wrongToken.text(), /Токен не подошёл/);
});

test('an OAuth grant inherits the permissions of the token that authorized it', async (t) => {
  const instance = await httpFixture(t);
  await writeFile(path.join(instance.config.roots[0]!, 'note.txt'), 'bound by the token');
  const limited = await instance.service.tokens.create({
    name: 'Read only',
    permissions: ['files:read'],
  });
  const session = await beginConsent(instance);
  const approved = await submitConsent(session, { access_token: limited.token });
  assert.equal(approved.status, 303, await approved.text());
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const exchange = await fetch(`${instance.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.verifier,
      resource: `${instance.url}/mcp`,
    }).toString(),
  });
  const granted = await exchange.text();
  assert.equal(exchange.status, 200, granted);
  const grant = OAuthTokensSchema.parse(JSON.parse(granted));
  const access = grant.access_token;
  const call = (name: string, args: Record<string, unknown>) =>
    fetch(`${instance.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  const read = await call('read_file', { path: 'note.txt' });
  assert.equal(read.status, 200);
  assert.match(await read.text(), /bound by the token/);

  const shell = await call('run_command', { command: 'echo hi' });
  const shellBody = await shell.text();
  assert.match(shellBody, /needs the \\"shell\\" permission/);
  assert.doesNotMatch(shellBody, /"job_id"/);

  await instance.service.tokens.update(limited.id, { enabled: false });
  const revoked = await call('read_file', { path: 'note.txt' });
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), { error: 'invalid_token' });
  const client = await instance.service.auth.clientsStore.getClient(session.clientId);
  assert.ok(client && grant.refresh_token);
  await assert.rejects(
    instance.service.auth.exchangeRefreshToken(client, grant.refresh_token),
    /no longer active/,
  );
});

test('a granted access token works on /mcp and stops working after revocation', async (t) => {
  const instance = await httpFixture(t);
  const session = await beginConsent(instance);
  const approved = await submitConsent(session, { access_token: instance.key });
  const code = new URL(approved.headers.get('location')!).searchParams.get('code');
  assert.ok(code);
  const exchange = await fetch(`${instance.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.verifier,
      resource: `${instance.url}/mcp`,
    }).toString(),
  });
  const granted = await exchange.text();
  assert.equal(exchange.status, 200, granted);
  const access = (JSON.parse(granted) as OAuthTokens).access_token;
  const call = async () =>
    fetch(`${instance.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.equal((await call()).status, 200);
  const revoke = await fetch(`${instance.url}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: session.clientId, token: access }).toString(),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await call()).status, 401);
});
