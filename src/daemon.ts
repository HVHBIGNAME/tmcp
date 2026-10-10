import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SettingsStore, settingsPath } from './settings.js';
import { acquireLock } from './runtime.js';
import { configAt, serviceStatus, stopRequested } from './service-control.js';
import { errorMessage } from './utils.js';
import { ipcFetch } from './ipc.js';

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const config = configAt(projectDir);
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
if (process.argv.includes('--autostart'))
  await rm(path.join(config.dataDir, 'stop.request'), { force: true });
let unlock: (() => Promise<void>) | undefined;
try {
  unlock = await acquireLock(config.dataDir, 'daemon.lock');
} catch (error) {
  console.error(errorMessage(error));
  process.exit(0);
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let child: ChildProcess | undefined;
let failures = 0;
try {
  while (!abort.signal.aborted && !(await stopRequested(config))) {
    const status = await serviceStatus(config);
    if (status) failures = 0;
    else if (!child || child.exitCode !== null || child.signalCode !== null) {
      const settings = new SettingsStore(settingsPath(config.dataDir));
      await settings.load();
      const log = await open(path.join(config.dataDir, 'server.log'), 'a', 0o600);
      try {
        child = spawn(
          process.execPath,
          [
            path.join(projectDir, 'dist', 'src', 'main.js'),
            ...(process.env.MCP_LOCAL_ONLY === 'true'
              ? []
              : ['--tunnel', settings.get().tunnel.mode]),
          ],
          {
            cwd: projectDir,
            windowsHide: true,
            stdio: ['ignore', log.fd, log.fd],
          },
        );
        await new Promise<void>((resolve, reject) => {
          child!.once('spawn', resolve);
          child!.once('error', reject);
        });
        console.log(
          JSON.stringify({
            time: new Date().toISOString(),
            event: 'server_started',
            pid: child.pid,
          }),
        );
        failures++;
      } finally {
        await log.close();
      }
    }
    try {
      const nextAttempt = performance.now() + Math.min(30000, 2000 * Math.max(1, failures));
      while (performance.now() < nextAttempt && !(await stopRequested(config))) {
        await delay(Math.max(1, Math.min(500, nextAttempt - performance.now())), undefined, {
          signal: abort.signal,
        });
      }
    } catch {
      break;
    }
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  const live = await serviceStatus(config);
  if (live && (abort.signal.aborted || (await stopRequested(config)))) {
    await ipcFetch(config.dataDir, '/_control/shutdown', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    }).catch((error: unknown) => console.error(errorMessage(error)));
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const current = child;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill();
      }, 15000);
      current.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await unlock?.();
}
