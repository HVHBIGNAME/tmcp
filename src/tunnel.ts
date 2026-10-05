import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config.js';
import { childEnvironment } from './config.js';
import { terminateTree } from './processes.js';
import { atomicWrite, errorMessage } from './utils.js';
import type { Logger } from './tools.js';

export interface CloudflareTunnel {
  url: string;
  process: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

const registrationLost =
  /Tunnel not found|Unauthorized|Invalid tunnel credentials|Connection terminated|Register tunnel error|failed to serve incoming request/i;
const registered = /Registered tunnel connection/i;

export interface RegistrationWatch {
  readonly failures: number;
  readonly reported: boolean;
  feed(text: string): void;
}

/**
 * Tracks consecutive registration errors from cloudflared output.
 *
 * cloudflared retries a lost registration forever instead of exiting, so process exit
 * alone cannot detect this failure. A transient reconnect prints the same error, so
 * several consecutive failures are required before the tunnel counts as lost.
 */
export function createRegistrationWatch(confirmations: number): RegistrationWatch {
  let failures = 0;
  let reported = false;
  return {
    get failures() {
      return failures;
    },
    get reported() {
      return reported;
    },
    feed(text: string) {
      if (registered.test(text)) {
        failures = 0;
        reported = false;
      } else if (registrationLost.test(text)) {
        failures += 1;
        if (failures >= confirmations) reported = true;
      }
    },
  };
}

function watchRegistration(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal | undefined,
  confirmations: number,
  interval: number,
  onLost: (message: string) => void,
): () => void {
  const watch = createRegistrationWatch(confirmations);
  let announced = false;
  const timer = setInterval(() => {
    if (!watch.reported || announced) return;
    announced = true;
    onLost('Tunnel registration was lost and is not recovering');
  }, interval);
  timer.unref();
  const onAbort = () => clearInterval(timer);
  signal?.addEventListener('abort', onAbort, { once: true });
  const onData = (chunk: Buffer) => watch.feed(chunk.toString('utf8'));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return () => {
    clearInterval(timer);
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
    signal?.removeEventListener('abort', onAbort);
  };
}

export async function startTunnel(
  config: Config,
  mode: 'quick' | 'named',
  log: Logger,
  onExit: (message: string) => void,
  signal?: AbortSignal,
  watch: { confirmations?: number; interval?: number } = {},
): Promise<CloudflareTunnel> {
  signal?.throwIfAborted();
  if (mode === 'named' && (!config.tunnelToken || !config.publicUrl.startsWith('https://')))
    throw new Error(
      'Named tunnel requires CLOUDFLARE_TUNNEL_TOKEN and HTTPS MCP_PUBLIC_URL in .env',
    );
  const configFile = path.join(config.dataDir, 'cloudflared-empty.yml');
  await atomicWrite(
    configFile,
    '# Managed by PC MCP; ignore unrelated user cloudflared configuration.\n',
  );
  const args = [
    'tunnel',
    '--config',
    configFile,
    '--no-autoupdate',
    '--protocol',
    'http2',
    '--metrics',
    '127.0.0.1:0',
  ];
  if (mode === 'quick') args.push('--url', config.localUrl);
  else args.push('run');
  signal?.throwIfAborted();
  const child = spawn(config.cloudflaredBin, args, {
    stdio: 'pipe',
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: {
      ...childEnvironment(),
      ...(mode === 'named' ? { TUNNEL_TOKEN: config.tunnelToken } : {}),
    },
  });
  child.stdin.end();
  let stopping = false;
  let ready = false;
  let registered = false;
  let publicUrl = mode === 'named' ? config.publicUrl : '';
  let tail = '';
  let unwatch: (() => void) | undefined;

  const stop = async () => {
    stopping = true;
    unwatch?.();
    await terminateTree(child);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error('Cloudflare did not connect within 90 seconds; see .mcp-tunnel/server.log'),
          ),
        90000,
      );
      const cancel = () => {
        clearTimeout(timeout);
        reject(new Error('Cloudflare startup cancelled'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const consume = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log({ event: 'cloudflared', message: text.trim() });
        tail = (tail + text).slice(-16384);
        publicUrl ||= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(tail)?.[0] ?? '';
        registered ||= tail.includes('Registered tunnel connection');
        if (!ready && publicUrl && registered) {
          ready = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', cancel);
          unwatch = watchRegistration(
            child,
            signal,
            watch.confirmations ?? 3,
            watch.interval ?? 20000,
            (message) => {
              if (!stopping) onExit(message);
            },
          );
          resolve();
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('error', (error) => {
        clearTimeout(timeout);
        if (ready && !stopping) onExit(errorMessage(error));
        else reject(error);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        if (stopping) return;
        const message = `cloudflared exited (code=${code}, signal=${signal})`;
        if (ready) onExit(message);
        else reject(new Error(message));
      });
    });
    return { url: publicUrl, process: child, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
