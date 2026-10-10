import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createUiFixture } from './ui-fixture.js';

if (process.platform !== 'win32') throw new Error('Desktop smoke test requires Windows.');
const fixture = await createUiFixture();
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
if (!address || typeof address === 'string') throw new Error('Expected TCP address');
const debugPort = address.port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const child = spawn(path.resolve(process.env.PC_MCP_UI_EXE ?? 'dist-ui/PcMcp.exe'), [], {
  cwd: process.cwd(),
  stdio: 'ignore',
  env: {
    ...process.env,
    PC_MCP_UI_DATA_DIR: fixture.config.dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
});
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1500 });
      break;
    } catch {
      await delay(500);
    }
  }
  if (!browser) throw new Error('Desktop WebView2 did not become ready.');
  const context = browser.contexts()[0];
  if (!context) throw new Error('WebView2 context not found');
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForURL('https://tmcp.local/index.html');
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue('');
  fixture.connect('https://desktop-test.example.com');
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://desktop-test.example.com/mcp',
    { timeout: 7000 },
  );
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Новый токен' }).click();
  await expect(page.getByRole('dialog', { name: 'Новый токен' })).toBeVisible();
  await page.getByLabel('Имя интеграции').fill('Native IPC test');
  await page.getByRole('button', { name: 'Создать токен', exact: true }).click();
  const key = await page.getByRole('textbox', { name: 'Новый токен', exact: true }).inputValue();
  expect(fixture.service.tokens.find(key)?.permissions).toEqual(['files:read']);
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  if (!child.pid) throw new Error('Missing process id');
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve('tests/input-language.ps1'),
      '-ProcessId',
      String(child.pid),
    ],
    { windowsHide: true },
  );
  await page.locator('nav [data-view="overview"]').click();
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://desktop-test.example.com/mcp',
  );
  await expect(page.locator('.traffic-panel')).toHaveAttribute('data-connected', 'true');
  const call = await fetch(`${fixture.publicUrl}/mcp`, {
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
      params: { name: 'system_info', arguments: {} },
    }),
  });
  expect(call.status).toBe(200);
  await call.arrayBuffer();
  await expect(page.locator('.traffic-panel')).toHaveAttribute('data-phase', 'returned');
  await expect(page.locator('.flow-token.selected')).toContainText('Native IPC test');
  const invalidDestination = await page.evaluate(`new Promise(resolve => {
    const id = crypto.randomUUID();
    const receive = event => {
      if (event.data.id !== id) return;
      chrome.webview.removeEventListener('message', receive);
      resolve(event.data.status);
    };
    chrome.webview.addEventListener('message', receive);
    chrome.webview.postMessage({ type: 'control-request', id, path: 'https://outside.example/', method: 'POST' });
  })`);
  expect(invalidDestination).toBe(400);
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить токен', exact: true }).click();
  await expect.poll(() => fixture.service.tokens.find(key)).toBeUndefined();
  expect(
    (await fetch(`${fixture.publicUrl}/mcp`, { headers: { Authorization: `Bearer ${key}` } }))
      .status,
  ).toBe(401);
  await page.locator('nav [data-view="overview"]').click();
  await page.screenshot({ path: path.resolve('.mcp-tunnel/desktop-verified.png') });
  await page.locator('nav [data-view="settings"]').click();
  await page.getByRole('button', { name: 'Завершить работу', exact: true }).click();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const started = performance.now();
  await page.getByRole('button', { name: 'Остановить и выйти', exact: true }).click();
  const deadline = new AbortController();
  try {
    await Promise.race([
      exited,
      delay(5000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Desktop exit exceeded five seconds');
      }),
    ]);
  } finally {
    deadline.abort();
  }
  console.log(`Desktop exit: ${Math.round(performance.now() - started)} ms`);
  console.log(
    'Desktop verified: owner-checked IPC, native key creation/revocation, live event stream, destination validation, URL updates, Russian input-language notification, clean exit.',
  );
} finally {
  await browser?.close();
  if (child.pid && child.exitCode === null) {
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`,
      ],
      { windowsHide: true },
    ).catch(() => undefined);
    await delay(500);
    if (child.exitCode === null) child.kill();
  }
  await fixture.close();
}
