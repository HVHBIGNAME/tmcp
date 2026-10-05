import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthStore } from '../src/auth/store.js';
import { AuthProvider } from '../src/auth/provider.js';
import { token } from '../src/utils.js';
import { httpFixture, jsonBody } from './helpers.js';

test('OAuth requires owner approval, CSRF session and PKCE; codes are one-use and bound to the client', async (t) => {
  const { config, url } = await httpFixture(t);
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
  assert(!html.includes(config.adminToken));
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
      body: new URLSearchParams({ request_id: requestId, admin_token: key, approve: 'yes' }),
      redirect: 'manual',
    });
  assert.equal((await approve(config.adminToken, '')).status, 400);
  assert.equal((await approve('bad-key')).status, 401);
  const approved = await approve(config.adminToken);
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

  const reopened = await AuthStore.open(config.dataDir, config.adminToken);
  const provider = new AuthProvider(config, reopened);
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

test('OAuth rejects unsafe redirect URIs and scope escalation; credential rotation revokes grants', async (t) => {
  const { config, url, service } = await httpFixture(t);
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
  const store = await AuthStore.open(config.dataDir, config.adminToken);
  const grantToken = token();
  const { hash } = await import('../src/utils.js');
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
    }),
  );
  assert.equal(
    (await new AuthProvider(config, store).verifyAccessToken(grantToken)).clientId,
    'test',
  );
  const rotated = { ...config, adminToken: token() };
  const rotatedStore = await AuthStore.open(config.dataDir, rotated.adminToken);
  await assert.rejects(new AuthProvider(rotated, rotatedStore).verifyAccessToken(grantToken));
  service.setPublicUrl('https://gateway.example');
  const updated = await jsonBody(await fetch(`${url}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(updated.resource, 'https://gateway.example/mcp');
});
