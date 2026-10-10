import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ipcFetch } from '../src/ipc.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const base = path.resolve('.mcp-tunnel', 'tests');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, 'lifecycle-'));
const project = path.join(directory, 'app');
await mkdir(path.join(project, 'dist'), { recursive: true });
await mkdir(path.join(project, 'scripts'));
await cp(
  path.resolve(process.env.TMCP_TEST_DIST ?? 'dist/src'),
  path.join(project, 'dist', 'src'),
  { recursive: true },
);
await cp(
  path.resolve('scripts/secure-control-pipe.ps1'),
  path.join(project, 'scripts', 'secure-control-pipe.ps1'),
);
await writeFile(
  path.join(project, 'package.json'),
  JSON.stringify({ name: 'pc-mcp-tunnel', type: 'module' }),
);
const port = await freePort();
const dataDir = path.join(directory, 'data');
await mkdir(dataDir);
const start = performance.now();
const daemon = spawn(process.execPath, [path.join(project, 'dist/src/daemon.js')], {
  cwd: project,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    MCP_PORT: String(port),
    MCP_ROOTS: JSON.stringify([directory]),
    MCP_DATA_DIR: dataDir,
    MCP_PUBLIC_URL: '',
    MCP_GATEWAY_DISCOVER: 'false',
    MCP_SERVERS_FILE: path.join(directory, 'servers.json'),
    MCP_CONFIG_PATHS: '[]',
    MCP_ENABLE_SCREENSHOTS: 'false',
    CLOUDFLARED_BIN: process.execPath,
    CLOUDFLARE_TUNNEL_TOKEN: '',
  },
});
let exited = false;
const done = new Promise<void>((resolve, reject) => {
  daemon.once('error', reject);
  daemon.once('exit', () => {
    exited = true;
    resolve();
  });
});
try {
  let ready = false;
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const response = await ipcFetch(dataDir, '/_control/status', {
        signal: AbortSignal.timeout(500),
      });
      ready = response.ok;
      await response.arrayBuffer();
      if (ready) break;
    } catch {
      /* The listener is not up yet. */
    }
    await delay(100);
  }
  assert(ready, 'Isolated daemon must start its listener');
  console.log(`Isolated startup: ${Math.round(performance.now() - start)} ms`);
  const stop = performance.now();
  await writeFile(path.join(dataDir, 'stop.request'), new Date().toISOString());
  const response = await ipcFetch(dataDir, '/_control/shutdown', {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  await response.arrayBuffer();
  const deadline = new AbortController();
  try {
    await Promise.race([
      done,
      delay(25000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Daemon shutdown exceeded 25 seconds');
      }),
    ]);
  } finally {
    deadline.abort();
  }
  const elapsed = Math.round(performance.now() - stop);
  console.log(`Isolated complete shutdown: ${elapsed} ms`);
  if (process.argv.includes('--check'))
    assert(elapsed < 5000, `Shutdown took ${elapsed} ms; expected under 5 seconds`);
} finally {
  if (!exited) daemon.kill();
  await rm(directory, { recursive: true, force: true });
}
