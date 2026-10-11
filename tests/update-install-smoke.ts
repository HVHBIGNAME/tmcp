import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { ipcFetch } from '../src/ipc.js';
import { windowsPowerShell } from '../src/windows.js';

if (process.platform !== 'win32') throw new Error('Update installation smoke requires Windows.');
const run = promisify(execFile);
const base = await mkdtemp(path.join(os.tmpdir(), 'tmcp-update-install-'));
const home = path.join(base, 'home');
const executable = path.join(base, 'TMCP.exe');
await cp(path.resolve(process.env.TMCP_TEST_EXE ?? 'release/TMCP.exe'), executable);
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(MCP_|PC_MCP_|TMCP_|WEBVIEW2_)/i.test(name)),
);
Object.assign(env, {
  MCP_LOCAL_ONLY: 'true',
  MCP_PORT: String(port),
  MCP_GATEWAY_DISCOVER: 'false',
  TMCP_DISABLE_UPDATES: 'true',
});
const data = path.join(home, '.mcp-tunnel');
let app: { node: string; cli: string; project: string; envFile: string } | undefined;
let success = false;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function stop() {
  if (app)
    await run(app.node, [app.cli, 'stop'], {
      cwd: app.project,
      env: { ...env, MCP_DATA_DIR: data, MCP_ENV_FILE: app.envFile },
      timeout: 30000,
    });
}
async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await ipcFetch(data, '/_control/api/state', {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      /* The replacement process has not opened IPC yet. */
    }
    await delay(250);
  }
  throw new Error('Updated or restored backend did not become ready');
}
async function authorized(key: string) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 405, 'Existing key must still be recognized');
}
async function install(candidate: Buffer, version: string, failure = false, abort = false) {
  assert(app);
  const stage = await mkdtemp(path.join(home, '.updates', 'case-'));
  const candidateFile = path.join(stage, 'TMCP.exe');
  await writeFile(candidateFile, candidate);
  const manifest = path.join(stage, 'plan.json');
  await writeFile(
    manifest,
    JSON.stringify({
      home,
      candidate: candidateFile,
      sha256: hash(candidate),
      version,
      oldPid: 2147483647,
      oldExecutable: executable,
      node: app.node,
      cli: app.cli,
      envFile: app.envFile,
      data,
      show: false,
      local: true,
      headless: true,
    }),
  );
  if (abort) await writeFile(path.join(stage, 'abort'), 'abort');
  const operation = run(
    windowsPowerShell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve('ui/update-install.ps1'),
      '-Manifest',
      manifest,
    ],
    { env, timeout: 360000, windowsHide: true },
  );
  if (failure)
    await assert.rejects(operation, (error: unknown) => (error as { code: number }).code === 1);
  else await operation;
  return stage;
}
try {
  await run(executable, ['--prepare-only', '--home', home], { env, timeout: 300000 });
  app = JSON.parse(await readFile(path.join(home, 'application.json'), 'utf8'));
  assert(app);
  await run(executable, ['--headless', '--local', '--home', home], { env, timeout: 30000 });
  await ready();
  const response = await ipcFetch(data, '/_control/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'Update preservation test', permissions: ['files:read'] }),
  });
  assert.equal(response.status, 201);
  const { token: key } = await response.json();
  await stop();
  const keys = await readFile(path.join(data, 'tokens.json'), 'utf8');
  const configuration = await readFile(app.envFile, 'utf8');
  const target = path.join(home, 'TMCP.exe');
  const bytes = await readFile(executable);
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await mkdir(path.join(home, '.updates'), { recursive: true });
  await install(bytes, version, false, true);
  assert.equal(
    hash(await readFile(target)),
    hash(bytes),
    'Aborted installation changed the executable',
  );
  await writeFile(target, 'previous executable fixture');
  const installed = await install(bytes, version);
  assert.equal(
    await readFile(path.join(installed, 'previous.exe'), 'utf8'),
    'previous executable fixture',
  );
  assert.equal(hash(await readFile(target)), hash(bytes));
  assert.equal(
    JSON.parse(await readFile(path.join(home, '.updates/status.json'), 'utf8')).status,
    'installed',
  );
  await ready();
  await authorized(key);
  await stop();
  await install(Buffer.from('MZ-invalid-executable'), '99.0.0', true);
  assert.equal(
    hash(await readFile(target)),
    hash(bytes),
    'Rollback did not restore the executable',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(home, '.updates/status.json'), 'utf8')).status,
    'failed',
  );
  await ready();
  await authorized(key);
  assert.equal(await readFile(app.envFile, 'utf8'), configuration);
  const identities = (text: string) =>
    JSON.parse(text).tokens.map(
      ({ lastUsedAt: _time, ...identity }: Record<string, unknown>) => identity,
    );
  assert.deepEqual(
    identities(await readFile(path.join(data, 'tokens.json'), 'utf8')),
    identities(keys),
  );
  success = true;
  console.log(
    'Update installer verified: abort before swap, atomic replacement, startup handshake, failed executable rollback, restarted backend and preserved configuration/client key.',
  );
} finally {
  try {
    await stop();
  } catch (error) {
    if (success) throw error;
    console.error('Update installer cleanup:', error);
  }
  if (success) await rm(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
  else console.error(`Update installer diagnostics retained: ${base}`);
}
