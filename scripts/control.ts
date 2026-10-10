import { spawn } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { isAlive, runtimeSchema, type RuntimeInfo } from '../src/runtime.js';
import { terminateTree } from '../src/processes.js';
import { errorMessage } from '../src/utils.js';
import { serviceStatus } from '../src/service-control.js';
import { ipcFetch } from '../src/ipc.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { mode: { type: 'string', default: 'quick' } },
});
const action = positionals[0];
if (!['up', 'down', 'status'].includes(action ?? ''))
  throw new Error('Usage: control up|down|status [--mode quick|named|local]');
if (!['quick', 'named', 'local'].includes(values.mode))
  throw new Error('Mode must be quick, named or local');
const config = loadConfig();

async function liveStatus(): Promise<RuntimeInfo | undefined> {
  let health: Response;
  try {
    health = await fetch(`${config.localUrl}/health`, { signal: AbortSignal.timeout(1500) });
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
      return undefined;
    }
    throw error;
  }
  if (health.status === 503) return undefined;
  if (!health.ok || !health.headers.get('content-type')?.includes('application/json')) {
    throw new Error(
      `Port ${config.port} is occupied by another service. Set a free MCP_PORT in .env.`,
    );
  }
  const identity: unknown = await health.json();
  if (
    identity === null ||
    typeof identity !== 'object' ||
    !('service' in identity) ||
    identity.service !== 'pc-mcp-tunnel'
  ) {
    throw new Error(
      `Port ${config.port} is occupied by another service. Set a free MCP_PORT in .env.`,
    );
  }
  const status = await serviceStatus(config);
  return status ? runtimeSchema.parse(status) : undefined;
}

function printStatus(status: RuntimeInfo) {
  console.log(
    JSON.stringify(
      {
        ...status,
        config_file: path.join(config.projectDir, '.env'),
        log_file: path.join(config.dataDir, 'server.log'),
      },
      null,
      2,
    ),
  );
}

async function up() {
  const current = await liveStatus();
  if (current) {
    printStatus(current);
    return;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const entry = path.join(config.projectDir, 'dist', 'src', 'main.js');
  await access(entry);
  const log = await open(path.join(config.dataDir, 'server.log'), 'a', 0o600);
  const args = [entry, ...(values.mode === 'local' ? [] : ['--tunnel', values.mode])];
  const child = spawn(process.execPath, args, {
    cwd: config.projectDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.unref();
  await log.close();
  try {
    const deadline =
      Date.now() +
      150000 +
      (config.gatewayMode === 'namespaced' ? config.backendConnectTimeoutMs : 0);
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error(
          `Server exited with code ${child.exitCode}. See ${path.join(config.dataDir, 'server.log')}`,
        );
      const status = await liveStatus();
      if (status && status.pid === child.pid && status.ready) {
        printStatus(status);
        return;
      }
      await delay(500);
    }
    throw new Error(`Startup timed out. See ${path.join(config.dataDir, 'server.log')}`);
  } catch (error) {
    const status = await liveStatus();
    if (status && status.pid === child.pid)
      await ipcFetch(config.dataDir, '/_control/shutdown', {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
    else await terminateTree(child);
    throw error;
  }
}

async function down() {
  const current = await liveStatus();
  if (!current) {
    console.log('PC MCP gateway is not running on the configured port.');
    return;
  }
  const response = await ipcFetch(config.dataDir, '/_control/shutdown', {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Shutdown failed: HTTP ${response.status}`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!isAlive(current.pid)) {
      console.log('PC MCP gateway, its tunnel and owned child processes have stopped.');
      return;
    }
    await delay(250);
  }
  throw new Error('Shutdown is taking longer than 15 seconds; inspect server.log');
}

try {
  if (action === 'up') await up();
  else if (action === 'down') await down();
  else {
    const status = await liveStatus();
    if (status) printStatus(status);
    else {
      console.log('PC MCP gateway is not running on the configured port.');
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
