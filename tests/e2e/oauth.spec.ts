import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createUiFixture } from '../ui-fixture.js';

test('browser consent reaches the registered external callback on the first click', async ({
  page,
  request,
}) => {
  const fixture = await createUiFixture();
  let callbackCode = '';
  const callback = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/callback') callbackCode = url.searchParams.get('code') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Подключено</h1>');
  });
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));
  try {
    const address = callback.address();
    if (!address || typeof address === 'string') throw new Error('Expected callback listener');
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const key = await fixture.service.tokens.create({
      name: 'Browser client',
      permissions: ['files:read'],
    });
    const registration = await request.post(`${fixture.publicUrl}/register`, {
      data: {
        client_name: 'Browser client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    });
    expect(registration.status()).toBe(201);
    const { client_id } = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'browser-state',
      resource: `${fixture.publicUrl}/mcp`,
    });
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy'))
        violations.push(message.text().split('http')[0]!);
    });
    await page.goto(`${fixture.publicUrl}/authorize?${query}`);
    await page.getByLabel(/Токен доступа/).fill(key.token);
    await page.getByRole('button', { name: 'Разрешить доступ' }).click();
    expect(violations, 'The browser must allow the registered OAuth callback').toEqual([]);
    await expect
      .poll(() => Boolean(callbackCode), {
        timeout: 5000,
        message: 'OAuth callback must receive the code after one click',
      })
      .toBe(true);
    await expect(page.getByRole('heading', { name: 'Подключено' })).toBeVisible();
    expect(violations).toEqual([]);
    expect(new URL(page.url()).searchParams.get('state')).toBe('browser-state');
    const exchange = await request.post(`${fixture.publicUrl}/token`, {
      form: {
        grant_type: 'authorization_code',
        client_id,
        code: callbackCode,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${fixture.publicUrl}/mcp`,
      },
    });
    expect(exchange.status()).toBe(200);
  } finally {
    callback.closeAllConnections();
    await new Promise<void>((resolve) => callback.close(() => resolve()));
    await fixture.close();
  }
});
