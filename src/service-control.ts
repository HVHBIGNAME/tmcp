import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { config as dotenv } from 'dotenv';
import { readConfig, type Config } from './config.js';
import { atomicWrite, isErrno, token } from './utils.js';
import { isAlive } from './runtime.js';

export async function initialize(
  projectDir: string,
  root = os.homedir(),
  port = 18787,
): Promise<void> {
  await mkdir(path.join(projectDir, '.mcp-tunnel'), { recursive: true, mode: 0o700 });
  try {
    await access(path.join(projectDir, '.env'));
    return;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  const workspace = await realpath(root);
  const text = [
    `MCP_PORT=${port}`,
    'MCP_CONTROL_PORT=18790',
    `MCP_TOKEN=${token()}`,
    `MCP_ADMIN_TOKEN=${token()}`,
    `MCP_ROOTS=${JSON.stringify([workspace.split(path.sep).join('/')])}`,
    'MCP_ENABLE_SHELL=true',
    'MCP_ENABLE_SCREENSHOTS=true',
    'MCP_GATEWAY_DISCOVER=true',
    'MCP_GATEWAY_MODE=catalog',
    '',
  ].join('\n');
  await writeFile(path.join(projectDir, '.env'), text, { flag: 'wx', mode: 0o600 });
}

export function configAt(projectDir: string): Config {
  const env: NodeJS.ProcessEnv = { ...process.env };
  dotenv({ path: path.join(projectDir, '.env'), processEnv: env, quiet: true });
  return readConfig(env, projectDir);
}

export async function control(config: Config, route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${config.controlPort}/_control/api${route}`, {
    method,
    signal: AbortSignal.timeout(route.includes('tunnel') ? 105000 : 15000),
    headers: { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.message ?? `Control API: HTTP ${response.status}`);
  return data;
}

export async function serviceStatus(config: Config): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${config.localUrl}/_control/status`, {
      headers: { Authorization: `Bearer ${config.adminToken}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return body.service === 'pc-mcp-tunnel' ? body : null;
  } catch {
    return null;
  }
}

export async function supervisorAlive(config: Config): Promise<boolean> {
  try {
    const pid = Number(await readFile(path.join(config.dataDir, 'daemon.lock'), 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function startService(config: Config, wait = true): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await rm(path.join(config.dataDir, 'stop.request'), { force: true });
  if (!(await supervisorAlive(config))) {
    const log = await open(path.join(config.dataDir, 'daemon.log'), 'a', 0o600);
    try {
      const child = spawn(
        process.execPath,
        [path.join(config.projectDir, 'dist', 'src', 'daemon.js')],
        {
          cwd: config.projectDir,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  if (!wait) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await serviceStatus(config)) return;
    await delay(500);
  }
  throw new Error('Server did not become ready. Run tmcp logs to inspect the startup error.');
}

export async function stopService(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(config.dataDir, 'stop.request'), new Date().toISOString());
  const status = await serviceStatus(config);
  if (status) {
    const response = await fetch(`${config.localUrl}/_control/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.adminToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Stop failed: HTTP ${response.status}`);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!(await serviceStatus(config)) && !(await supervisorAlive(config))) return;
    await delay(300);
  }
  throw new Error('Shutdown is taking longer than expected. See tmcp logs.');
}

export async function stopRequested(config: Config): Promise<boolean> {
  try {
    await access(path.join(config.dataDir, 'stop.request'), constants.F_OK);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}
