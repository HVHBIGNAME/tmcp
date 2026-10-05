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
const child = spawn(path.resolve('dist-ui/PcMcp.exe'), [], {
  cwd: process.cwd(),
  stdio: 'ignore',
  env: {
    ...process.env,
    PC_MCP_UI_CONTROL_URL: new URL(fixture.url).origin,
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
  await page.waitForURL('**/ui/');
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue('');
  fixture.connect('https://desktop-test.example.com');
  await expect(page.getByLabel('Внешний адрес MCP')).toHaveValue(
    'https://desktop-test.example.com/mcp',
    { timeout: 7000 },
  );
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Новый токен' }).click();
  await expect(page.getByRole('dialog', { name: 'Новый токен' })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
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
  await page.screenshot({ path: path.resolve('.mcp-tunnel/desktop-verified.png') });
  console.log(
    'Desktop verified: external URL update, navigation, custom dialog, Russian input-language notification.',
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
