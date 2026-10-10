import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config.js';
import { childEnvironment } from './config.js';
import { terminateTree } from './processes.js';
import { atomicWrite, errorMessage } from './utils.js';
import type { Logger } from './tools.js';
import { redactedStream } from './redaction.js';

export interface CloudflareTunnel {
  url: string;
  process: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

const registrationFailed =
  /Tunnel not found|Unauthorized|Invalid tunnel credentials|Register tunnel error/i;
const connectionLost =
  /Connection terminated|Serve tunnel error|Failed to (?:dial|serve tunnel connection|accept incoming stream requests)/i;
const registered = /Registered tunnel connection/i;

export interface RegistrationWatch {
  readonly failures: number;
  readonly reported: boolean;
  feed(text: string): void;
}

// A cloudflared process owns several edge connections; one reconnect is not a tunnel loss.
export function createRegistrationWatch(
  confirmations: number,
  recoveryMs = 20000,
  now = () => performance.now(),
): RegistrationWatch {
  let failures = 0;
  let reported = false;
  let lostSince: number | undefined;
  const healthy = new Set<string>();
  return {
    get failures() {
      return failures;
    },
    get reported() {
      return reported || (lostSince !== undefined && now() - lostSince >= recoveryMs);
    },
    feed(text: string) {
      for (const line of text.split(/\r?\n/)) {
        const connection = /\bconnIndex=(\d+)\b/.exec(line)?.[1] ?? '0';
        if (registered.test(line)) {
          healthy.add(connection);
          failures = 0;
          reported = false;
          lostSince = undefined;
          continue;
        }
        if (registrationFailed.test(line)) healthy.clear();
        else if (connectionLost.test(line)) healthy.delete(connection);
        else continue;
        if (healthy.size) continue;
        lostSince ??= now();
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
  isReady: () => boolean,
): () => void {
  const watch = createRegistrationWatch(confirmations);
  let announced = false;
  const timer = setInterval(() => {
    if (!isReady() || !watch.reported || announced) return;
    announced = true;
    onLost('Tunnel registration was lost and is not recovering');
  }, interval);
  timer.unref();
  const onAbort = () => clearInterval(timer);
  signal?.addEventListener('abort', onAbort, { once: true });
  const listeners = [child.stdout, child.stderr].map((stream) => {
    let tail = '';
    const onData = (chunk: Buffer) => {
      const lines = (tail + chunk.toString('utf8')).split(/\r?\n/);
      tail = lines.pop()!.slice(-16384);
      for (const line of lines) watch.feed(line);
    };
    stream.on('data', onData);
    return { stream, onData };
  });
  return () => {
    clearInterval(timer);
    for (const { stream, onData } of listeners) stream.off('data', onData);
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
    '# Managed by PC MCP; ignore unrelated user cloudflared configuration.\nno-autoupdate: true\n',
  );
  const args = [
    'tunnel',
    '--config',
    configFile,
    '--no-autoupdate',
    '--protocol',
    config.tunnelProtocol,
    '--edge-ip-version',
    config.tunnelEdgeIpVersion,
    '--metrics',
    '127.0.0.1:0',
  ];
  if (mode === 'quick') args.push('--url', config.localUrl);
  else args.push('run');
  signal?.throwIfAborted();
  const child = spawn(config.cloudflaredBin, args, {
    cwd: config.projectDir,
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
  for (const stream of [child.stdout, child.stderr]) {
    const output = redactedStream([config.tunnelToken], (message) => {
      if (message.trim()) log({ event: 'cloudflared', message: message.trim() });
    });
    stream.on('data', (chunk: Buffer) => output.write(chunk));
    stream.once('end', () => output.end());
  }

  const stop = async () => {
    stopping = true;
    unwatch?.();
    await terminateTree(child);
  };
  try {
    unwatch = watchRegistration(
      child,
      signal,
      watch.confirmations ?? 3,
      watch.interval ?? 20000,
      onExit,
      () => ready && !stopping,
    );
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
        tail = (tail + text).slice(-16384);
        publicUrl ||= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(tail)?.[0] ?? '';
        registered ||= tail.includes('Registered tunnel connection');
        if (!ready && publicUrl && registered) {
          ready = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', cancel);
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
