import { chromium, expect, request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { token } from '../src/utils.js';

const endpoint = process.env.TMCP_CHECK_URL;
const key = process.env.TMCP_CHECK_KEY;
if (!endpoint || !key)
  throw new Error('Set TMCP_CHECK_URL and TMCP_CHECK_KEY for this explicit live check.');
const origin = new URL(endpoint).origin;
const api = await request.newContext({ timeout: 25000 });
const browser = await chromium.launch();
let callbackCode = '';
let callbackState = '';
let clientId = '';
let grant: OAuthTokens | undefined;
let revoked = false;
const callback = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/callback') {
    callbackCode = url.searchParams.get('code') ?? '';
    callbackState = url.searchParams.get('state') ?? '';
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end('<h1>OAuth callback verified</h1>');
});
await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));
let step = 'registration';
const started = performance.now();
try {
  const address = callback.address();
  if (!address || typeof address === 'string') throw new Error('Callback listener is missing');
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const registration = await api.post(`${origin}/register`, {
    data: {
      client_name: 'TMCP browser verification',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registration.status()).toBe(201);
  clientId = OAuthClientInformationFullSchema.parse(await registration.json()).client_id;
  const verifier = token();
  const state = token();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    resource: `${origin}/mcp`,
  });
  const page = await browser.newPage();
  let cspViolations = 0;
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      cspViolations++;
  });
  step = 'browser consent';
  await page.goto(`${origin}/authorize?${query}`, { timeout: 25000 });
  await page.getByLabel(/Токен доступа/).fill(key);
  await page.getByRole('button', { name: 'Разрешить доступ' }).click();
  await expect.poll(() => Boolean(callbackCode), { timeout: 20000 }).toBe(true);
  expect(callbackState === state).toBe(true);
  expect(cspViolations).toBe(0);
  step = 'token exchange';
  const exchange = await api.post(`${origin}/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callbackCode,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${origin}/mcp`,
    },
  });
  expect(exchange.status()).toBe(200);
  grant = OAuthTokensSchema.parse(await exchange.json());
  step = 'authenticated MCP';
  const response = await api.post(`${origin}/mcp`, {
    headers: {
      Authorization: `Bearer ${grant.access_token}`,
      Accept: 'application/json, text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'system_info', arguments: {} },
    },
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(
    Boolean(result.result && !result.result.isError && result.result.structuredContent?.platform),
  ).toBe(true);
  step = 'revocation';
  const revoke = await api.post(`${origin}/revoke`, {
    form: { client_id: clientId, token: grant.access_token },
  });
  expect(revoke.status()).toBe(200);
  revoked = true;
  const denied = await api.get(`${origin}/mcp`, {
    headers: { Authorization: `Bearer ${grant.access_token}` },
  });
  expect(denied.status()).toBe(401);
  console.log(
    JSON.stringify({
      endpoint: origin,
      firstClickCallback: true,
      cspViolations,
      tokenExchange: 200,
      authenticatedMcp: 200,
      revokedToken: 401,
      durationMs: Math.round(performance.now() - started),
    }),
  );
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(key, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[value]');
  console.error(`Live OAuth check failed during ${step}: ${message}`);
  process.exitCode = 1;
} finally {
  if (grant && !revoked)
    await api
      .post(`${origin}/revoke`, { form: { client_id: clientId, token: grant.access_token } })
      .catch(() => console.error('OAuth probe cleanup failed; revoke the test key.'));
  await browser.close();
  await api.dispose();
  callback.closeAllConnections();
  await new Promise<void>((resolve) => callback.close(() => resolve()));
}
