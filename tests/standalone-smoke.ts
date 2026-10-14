import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { ipcFetch } from '../src/ipc.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.platform !== 'win32') throw new Error('Standalone smoke requires Windows.');
const run = promisify(execFile);
const base = await mkdtemp(path.join(os.tmpdir(), 'tmcp single exe '));
const home = path.join(base, 'installed home');
const download = path.join(base, 'download');
await mkdir(download);
const executable = path.join(download, 'TMCP.exe');
await cp(path.resolve(process.env.TMCP_TEST_EXE ?? 'release/TMCP.exe'), executable);
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
  PATH: path.join(process.env.SystemRoot!, 'System32'),
  MCP_PORT: String(mcpPort),
  MCP_LOCAL_ONLY: 'true',
  TMCP_DISABLE_UPDATES: 'true',
  MCP_GATEWAY_DISCOVER: 'false',
  MCP_ENABLE_SCREENSHOTS: 'true',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
});
let child: ChildProcess | undefined, browser: Browser | undefined;
let page!: Page;
async function connect() {
  for (let i = 0; i < 600; i++) {
    if (child?.exitCode !== null) throw new Error(`Standalone exited: ${child?.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 });
      break;
    } catch {
      await delay(500);
    }
  }
  if (!browser)
    throw new Error(`Standalone did not open its bundled WebView2. Diagnostics: ${data}`);
  const context = browser.contexts()[0]!;
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForURL('https://tmcp.local/index.html');
  await expect(page.locator('nav [data-view="tokens"]')).toBeVisible({ timeout: 15000 });
}
async function api(route: string, body?: object) {
  const response = await ipcFetch(
    data,
    '/_control/api' + route,
    body
      ? {
          method: 'PATCH',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(65000),
        }
      : {},
  );
  assert.equal(response.status, 200, route);
  return response.json();
}
async function native(action: string, name?: string) {
  assert(child?.pid);
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve('tests/desktop-window.ps1'),
      '-ProcessId',
      String(child.pid),
      '-Action',
      action,
      ...(name ? ['-Name', name] : []),
    ],
    { windowsHide: true, timeout: 20000 },
  );
}
async function quit() {
  await page.locator('nav [data-view="settings"]').click();
  await page.getByRole('button', { name: 'Завершить работу', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить и выйти', exact: true }).click();
  await expect.poll(() => child?.exitCode, { timeout: 8000 }).toBe(0);
  await browser?.close();
  browser = undefined;
}
let registration: string | undefined,
  success = false;
try {
  assert.deepEqual(await readdir(download), ['TMCP.exe']);
  child = spawn(executable, ['--home', home], { cwd: download, env: environment, stdio: 'ignore' });
  await connect();
  const installed = JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8'));
  const state = await api('/state');
  assert.equal(state.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  await assert.rejects(
    run(executable, ['--prepare-only', '--home', home], {
      cwd: download,
      env: environment,
      timeout: 10000,
    }),
    (error: unknown) => {
      const result = error as { code?: number; killed?: boolean; stderr?: string };
      assert.equal(result.code, 1);
      assert(!result.killed);
      assert.match(result.stderr ?? '', /Another TMCP/);
      return true;
    },
  );
  assert(installed.node.startsWith(home));
  assert.match((await run(installed.node, ['--version'], { env: environment })).stdout, /v24\./);
  assert.equal(
    (
      await run(installed.node, ['-e', 'require("sharp");process.stdout.write(process.execPath)'], {
        cwd: installed.project,
        env: environment,
      })
    ).stdout,
    installed.node,
  );
  await page.locator('nav [data-view="tokens"]').click();
  await page.getByRole('button', { name: 'Новый токен' }).click();
  await page.getByLabel('Имя интеграции').fill('Standalone smoke');
  await page.getByRole('button', { name: 'Создать токен', exact: true }).click();
  const key = await page.getByRole('textbox', { name: 'Новый токен', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
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
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const issued = await ipcFetch(data, '/_control/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bundled capture audit', permissions: ['screen'] }),
  });
  assert.equal(issued.status, 201);
  const captureKey = await issued.json();
  const captureClient = new Client({ name: 'bundled-capture-smoke', version: '1' });
  try {
    await captureClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${captureKey.token}` } },
      }),
    );
    await captureClient.listTools();
    const displays = CallToolResultSchema.parse(
      await captureClient.callTool({ name: 'list_displays', arguments: {} }),
    );
    assert(!displays.isError, JSON.stringify(displays.content));
    const image = CallToolResultSchema.parse(
      await captureClient.callTool({
        name: 'take_screenshot',
        arguments: { display: 0, max_size: 640 },
      }),
    );
    assert(!image.isError, JSON.stringify(image.content.filter((item) => item.type === 'text')));
    assert.equal(image.content[0]?.type, 'image');
    assert(Number(image.structuredContent?.width) <= 640);
  } finally {
    await captureClient.close();
  }
  await page.locator('nav [data-view="settings"]').click();
  await page.getByRole('checkbox', { name: 'Запускать свёрнутым в трей' }).check();
  await expect.poll(async () => (await api('/state')).settings.ui.startMinimized).toBe(true);
  await api('/settings', { ui: { theme: 'dark' } });
  assert.equal((await api('/state')).settings.ui.startMinimized, true);
  await page.getByRole('button', { name: 'Меню трея', exact: true }).click();
  await native('invoke', 'Доступ и ключи');
  await expect(page.getByRole('button', { name: 'Новый токен' })).toBeVisible();
  const startup = await api('/autostart', { enabled: true });
  registration = startup.registrationName;
  assert(registration && registration.startsWith('TMCP-'));
  assert.equal(startup.enabled, true);
  assert.equal(startup.executable, path.join(home, 'TMCP.exe'));
  const registered = await run('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v',
    registration,
  ]);
  assert(registered.stdout.includes(`"${startup.executable}" --autostart --home "${home}"`));
  const keysBefore = await readFile(path.join(data, 'tokens.json'), 'utf8');
  await quit();
  await rm(download, { recursive: true });
  child = spawn(startup.executable, ['--autostart', '--home', home], {
    cwd: home,
    env: environment,
    stdio: 'ignore',
  });
  await connect();
  assert.equal(
    JSON.parse((await native('state')).stdout).visible,
    0,
    'Minimized startup must not show a window',
  );
  assert.equal(await readFile(path.join(data, 'tokens.json'), 'utf8'), keysBefore);
  await run(installed.node, [installed.cli, 'ui'], {
    cwd: installed.project,
    env: {
      ...environment,
      MCP_ENV_FILE: installed.envFile,
      MCP_DATA_DIR: data,
      MCP_DESKTOP_EXE: startup.executable,
    },
    timeout: 10000,
  });
  assert(
    JSON.parse((await native('state')).stdout).visible > 0,
    'Second launch must restore the window',
  );
  await api('/autostart', { enabled: false });
  registration = undefined;
  await page.locator('nav [data-view="settings"]').click();
  await page.getByRole('button', { name: 'Меню трея', exact: true }).click();
  await native('post-click', 'Остановить сервер и выйти из TMCP…');
  await native('invoke', 'Отмена');
  assert.equal(child.exitCode, null);
  await page.getByRole('button', { name: 'Меню трея', exact: true }).click();
  await native('post-click', 'Остановить сервер и выйти из TMCP…');
  await native('invoke', 'Остановить и выйти');
  await expect.poll(() => child?.exitCode, { timeout: 8000 }).toBe(0);
  await assert.rejects(fetch(`http://127.0.0.1:${mcpPort}/health`));
  success = true;
  console.log(
    'Standalone verified: one EXE, private Node/sharp/Fixed WebView2, native key and MCP, installed autostart after source removal, preserved keys, hidden startup, second-launch restore, tray navigation and confirmed full shutdown.',
  );
} finally {
  await browser?.close();
  if (registration)
    await run(
      'reg.exe',
      [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        registration,
        '/f',
      ],
      { windowsHide: true },
    );
  try {
    const installed = JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8'));
    await run(installed.node, [installed.cli, 'stop'], {
      cwd: installed.project,
      env: { ...environment, MCP_ENV_FILE: installed.envFile, MCP_DATA_DIR: installed.data },
      timeout: 30000,
    });
  } catch (error) {
    if (success) throw error;
    console.error('Cleanup after failed standalone smoke:', error);
  } finally {
    if (child?.exitCode === null) child.kill();
    if (success) await rm(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
    else console.error(`Standalone diagnostics retained: ${base}`);
  }
}
