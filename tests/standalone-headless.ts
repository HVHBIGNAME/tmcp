import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ipcFetch } from '../src/ipc.js';

if (process.platform !== 'win32') throw new Error('Standalone runtime smoke requires Windows.');
const run = promisify(execFile);
const base = await mkdtemp(path.join(os.tmpdir(), 'tmcp headless '));
const home = path.join(base, 'home');
const download = path.join(base, 'download');
await mkdir(download);
const executable = path.join(download, 'TMCP.exe');
await cp(path.resolve(process.env.TMCP_TEST_EXE ?? 'release/TMCP.exe'), executable);
const data = path.join(home, '.mcp-tunnel');
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(MCP_|PC_MCP_|TMCP_|WEBVIEW2_|CLOUDFLARED_|CLOUDFLARE_)/i.test(name),
  ),
);
Object.assign(env, {
  PATH: path.join(process.env.SystemRoot!, 'System32'),
  MCP_PORT: String(port),
  MCP_LOCAL_ONLY: 'true',
  MCP_GATEWAY_DISCOVER: 'false',
  MCP_ENABLE_SCREENSHOTS: 'false',
});
let installed:
  { project: string; node: string; cli: string; envFile: string; data: string } | undefined;
let registration: string | undefined;
let success = false;
async function api(route: string, method = 'GET', body?: unknown) {
  const response = await ipcFetch(data, '/_control/api' + route, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  assert(response.ok, `${route}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function ready() {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    try {
      return await api('/state');
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Standalone server failed to become ready: ${base}`);
}
async function stop() {
  if (!installed) return;
  await run(installed.node, [installed.cli, 'stop'], {
    cwd: installed.project,
    env: { ...env, MCP_ENV_FILE: installed.envFile, MCP_DATA_DIR: installed.data },
    timeout: 30000,
  });
}
async function call(key: string) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert(result.result && !result.result.isError && !result.error);
}
try {
  assert.deepEqual(await readdir(download), ['TMCP.exe']);
  await run(executable, ['--prepare-only', '--home', home], {
    cwd: download,
    env,
    timeout: 120000,
  });
  installed = JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8'));
  assert(installed && installed.node.startsWith(home));
  assert.match((await run(installed.node, ['--version'], { env })).stdout, /v24\./);
  await run(
    installed.node,
    ['-e', 'require("sharp");require("@modelcontextprotocol/sdk/server/mcp.js")'],
    { cwd: installed.project, env },
  );
  assert.match(
    (await run(path.join(installed.project, 'bin', 'cloudflared.exe'), ['--version'], { env }))
      .stdout,
    /cloudflared version/,
  );
  await run(executable, ['--headless', '--local', '--home', home], {
    cwd: download,
    env,
    timeout: 30000,
  });
  const state = await ready();
  assert.equal(state.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  const issued = await api('/tokens', 'POST', {
    name: 'CI standalone runtime',
    permissions: ['files:read'],
  });
  await call(issued.token);
  const startup = await api('/autostart', 'PATCH', { enabled: true });
  registration = startup.registrationName;
  assert(registration && registration.startsWith('TMCP-'));
  assert.equal(startup.executable, path.join(home, 'TMCP.exe'));
  const registry = await run('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v',
    registration,
  ]);
  assert(
    registry.stdout.includes(`"${startup.executable}" --autostart --headless --home "${home}"`),
  );
  await stop();
  const keys = await readFile(path.join(data, 'tokens.json'), 'utf8');
  await rm(download, { recursive: true });
  await run(startup.executable, ['--autostart', '--headless', '--local', '--home', home], {
    cwd: home,
    env,
    timeout: 30000,
  });
  await ready();
  assert.equal(await readFile(path.join(data, 'tokens.json'), 'utf8'), keys);
  await call(issued.token);
  await api('/autostart', 'PATCH', { enabled: false });
  registration = undefined;
  await stop();
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) }),
  );
  success = true;
  console.log(
    'Standalone runtime verified: single EXE, preparation, private Node/sharp/cloudflared, real MCP, installed headless autostart, preserved key after source removal, complete stop.',
  );
} finally {
  if (registration)
    await run('reg.exe', [
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      registration,
      '/f',
    ]);
  await stop();
  if (success) await rm(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
  else console.error(`Standalone diagnostics retained: ${base}`);
}
