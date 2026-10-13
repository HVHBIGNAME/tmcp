import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { ipcFetch } from '../src/ipc.js';

if (process.platform !== 'win32')
  throw new Error('Live automatic update smoke requires Windows desktop.');
const run = promisify(execFile);
const base = await mkdtemp(path.join(os.tmpdir(), 'tmcp-auto-update-'));
const home = path.join(base, 'home');
const download = path.join(base, 'download');
await mkdir(download);
const oldExe = path.join(download, 'TMCP.exe');
await cp(
  path.resolve(
    process.env.TMCP_TEST_PREVIOUS_EXE ?? '.mcp-tunnel/update-fixture/published/PcMcp.exe',
  ),
  oldExe,
);
const data = path.join(home, '.mcp-tunnel');
async function port() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
const mcpPort = await port(),
  debugPort = await port();
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(MCP_|PC_MCP_|TMCP_|WEBVIEW2_)/i.test(name)),
);
Object.assign(environment, {
  MCP_PORT: String(mcpPort),
  MCP_LOCAL_ONLY: 'true',
  MCP_GATEWAY_DISCOVER: 'false',
  MCP_ENABLE_SCREENSHOTS: 'false',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
});
let child: ChildProcess | undefined, browser: Browser | undefined;
let page!: Page;
let updatedPid: number | undefined;
let success = false;
async function connect() {
  for (let i = 0; i < 600; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 });
      break;
    } catch {
      await delay(500);
    }
  }
  assert(browser, 'Updated desktop did not open its browser');
  const context = browser.contexts()[0]!;
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForURL('https://tmcp.local/index.html');
  await expect(page.locator('nav [data-view="tokens"]')).toBeVisible();
}
try {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const releaseResponse = await fetch(
    'https://api.github.com/repos/HVHBIGNAME/tmcp/releases/latest',
    { headers: { 'User-Agent': 'TMCP-live-update-test' } },
  );
  assert(releaseResponse.ok);
  const release = await releaseResponse.json();
  assert.equal(
    release.tag_name,
    'v' + version,
    'Publish the current version before running the live update test',
  );
  const digest = release.assets.find((asset: { name: string }) => asset.name === 'TMCP.exe').digest;
  child = spawn(oldExe, ['--home', home, '--show', '--local'], {
    cwd: download,
    env: environment,
    stdio: 'ignore',
  });
  await connect();
  await page!.evaluate(
    `window.__observedUpdate = null; chrome.webview.addEventListener('message', event => { if (event.data.type === 'update-status') window.__observedUpdate = event.data.update; });`,
  );
  const created = await ipcFetch(data, '/_control/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'Automatic update preservation', permissions: ['files:read'] }),
  });
  assert.equal(created.status, 201);
  const { token: key } = await created.json();
  const saved = await ipcFetch(data, '/_control/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ ui: { theme: 'light', startMinimized: true } }),
  });
  assert.equal(saved.status, 200);
  await saved.json();
  const configuration = await readFile(path.join(home, '.env'), 'utf8');
  const settings = await readFile(path.join(data, 'settings.json'), 'utf8');
  await page!.locator('nav [data-view="tokens"]').click();
  await page!.getByRole('button', { name: 'Новый токен' }).click();
  await expect
    .poll(async () => page!.evaluate('window.__observedUpdate?.status'), {
      timeout: 600000,
      intervals: [1000],
    })
    .toBe('waiting');
  assert.equal(child.exitCode, null, 'Automatic update must wait while a token dialog is open');
  await page!.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect.poll(() => child?.exitCode, { timeout: 60000 }).toBe(0);
  await browser?.close();
  browser = undefined;
  const statusFile = path.join(home, '.updates/status.json');
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(statusFile, 'utf8')).status;
        } catch {
          return '';
        }
      },
      { timeout: 360000, intervals: [500] },
    )
    .toBe('installed');
  const receipt = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(receipt.version, version);
  assert(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
  updatedPid = receipt.pid;
  await connect();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(home, 'TMCP.exe'))) hash.update(chunk);
  assert.equal('sha256:' + hash.digest('hex'), digest);
  assert.equal(
    JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8')).version,
    version,
  );
  assert.equal(await readFile(path.join(home, '.env'), 'utf8'), configuration);
  assert.equal(await readFile(path.join(data, 'settings.json'), 'utf8'), settings);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        headers: { Authorization: `Bearer ${key}` },
      })
    ).status,
    405,
  );
  await page!.locator('nav [data-view="settings"]').click();
  await page!.getByRole('button', { name: 'Завершить работу', exact: true }).click();
  await page!.getByRole('button', { name: 'Остановить и выйти', exact: true }).click();
  await expect
    .poll(
      () => {
        try {
          process.kill(updatedPid!, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      },
      { timeout: 15000 },
    )
    .toBe(false);
  success = true;
  console.log(
    'Automatic GitHub update verified: no manual check/install action, idle-dialog deferral, verified release download, complete EXE replacement, new GUI/backend startup, preserved key/configuration.',
  );
} finally {
  await browser?.close();
  try {
    const app = JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8'));
    await run(app.node, [app.cli, 'stop'], {
      cwd: app.project,
      env: { ...environment, MCP_DATA_DIR: data, MCP_ENV_FILE: app.envFile },
      timeout: 30000,
    });
  } catch (error) {
    if (success) throw error;
    console.error('Update test cleanup:', error);
  }
  if (child?.exitCode === null) child.kill();
  if (updatedPid && !success) {
    try {
      process.kill(updatedPid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error('Updated desktop cleanup:', error);
    }
  }
  if (success) await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`Automatic update diagnostics retained: ${base}`);
}
