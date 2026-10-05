import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createApp } from './http.js';
import { acquireLock, type RuntimeInfo } from './runtime.js';
import { TunnelManager } from './tunnel-manager.js';
import { atomicWrite, errorMessage, SerialQueue } from './utils.js';
import { generateSecret, rotateEnvToken } from './secrets.js';
import type { Logger } from './tools.js';

const { values } = parseArgs({
  options: {
    tunnel: { type: 'string' },
    // Internal: the desktop shell starts the server and reads the admin token back.
    ui: { type: 'boolean' },
  },
});
if (values.tunnel && !['quick', 'named'].includes(values.tunnel))
  throw new Error('--tunnel must be quick or named');
const config = loadConfig();
const uiPort = config.controlPort;
if (uiPort === config.port) throw new Error('MCP_CONTROL_PORT must differ from MCP_PORT');
const mode = values.tunnel === 'quick' ? 'quick' : values.tunnel === 'named' ? 'named' : 'local';
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const unlock = await acquireLock(config.dataDir);
const log: Logger = (event) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
const runtime: RuntimeInfo = {
  service: 'pc-mcp-tunnel',
  instanceId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ready: false,
  mode,
  localUrl: config.localUrl,
  publicUrl: config.publicUrl,
  mcpUrl: `${config.publicUrl}/mcp`,
};
const stateFile = path.join(config.dataDir, 'runtime.json');
let service: Awaited<ReturnType<typeof createApp>> | undefined;
let tunnels: TunnelManager | undefined;
const runtimeWrites = new SerialQueue();
const persistRuntime = () =>
  runtimeWrites.run(() => atomicWrite(stateFile, JSON.stringify(runtime, null, 2)));
let stopping: Promise<void> | undefined;
const startup = new AbortController();
const server = createServer((req, res) => {
  if (service) service.app(req, res);
  else {
    res.writeHead(503, { 'Retry-After': '1' });
    res.end('Starting');
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;

/**
 * Separate listener for the desktop shell.
 *
 * The control API can rotate credentials and stop the server, so it never shares the port
 * that the tunnel exposes. This listener binds to loopback only.
 */
const controlServer = createServer((req, res) => {
  if (service) service.controlApp(req, res);
  else {
    res.writeHead(503, { 'Retry-After': '1' });
    res.end('Starting');
  }
});

function stop(code: number): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    runtime.ready = false;
    startup.abort(new Error('Server startup cancelled'));
    const force = setTimeout(() => process.exit(code || 1), 15000);
    force.unref();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const disconnect = setTimeout(() => server.closeAllConnections(), 3000);
    disconnect.unref();
    const controlClosed = controlServer
      ? new Promise<void>((resolve) => controlServer.close(() => resolve()))
      : Promise.resolve();
    const results = await Promise.allSettled([
      service?.close(),
      tunnels?.stop(),
      closed,
      controlClosed,
      persistRuntime(),
    ]);
    clearTimeout(disconnect);
    for (const result of results)
      if (result.status === 'rejected') {
        log({ event: 'shutdown_error', message: errorMessage(result.reason) });
        code = 1;
      }
    await unlock();
    process.exitCode = code;
    log({ event: 'stopped', code });
  })();
  return stopping;
}

process.once('SIGINT', () => {
  void stop(0);
});
process.once('SIGTERM', () => {
  void stop(0);
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  service = await createApp(config, {
    log,
    deferGatewayWarmup: true,
    startedAt: runtime.startedAt,
    status: () => ({ ...runtime, gateway: service?.gateway.listServers() }),
    shutdown: () => {
      void stop(0);
    },
    rotateToken: async (kind, current) => {
      // Rotating writes the new secret to .env; it takes effect on the next start.
      const generated = generateSecret();
      await rotateEnvToken(
        path.join(config.projectDir, '.env'),
        kind === 'owner' ? { ownerToken: generated } : { adminToken: generated },
      );
      log({ event: 'token_rotated', kind, note: 'Restart the app to apply' });
      void current;
      return generated;
    },
    restartTunnel: async (target) => {
      if (!tunnels) throw new Error('A tunnel restart is already running');
      const replaced = await tunnels.restart(target);
      return { url: replaced };
    },
    restartServer: () => {
      void stop(0);
    },
  });
  const running = service;
  tunnels = new TunnelManager(
    config,
    () => running.settings.get().tunnel,
    (url) => {
      running.setPublicUrl(url);
      runtime.publicUrl = url;
      runtime.mcpUrl = `${url}/mcp`;
    },
    async (state) => {
      Object.assign(runtime, state);
      await persistRuntime();
    },
    log,
  );
  if (startup.signal.aborted) {
    await service.close();
    startup.signal.throwIfAborted();
  }
  if (controlServer) {
    await new Promise<void>((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(uiPort, '127.0.0.1', () => {
        controlServer.removeListener('error', reject);
        resolve();
      });
    });
  }
  if (config.gatewayMode === 'namespaced') await service.gateway.warmup();
  startup.signal.throwIfAborted();

  if (mode !== 'local') {
    void tunnels.restart(mode).catch((error: unknown) => {
      log({ event: 'tunnel_start_error', message: errorMessage(error) });
      if (runtime.connectionStatus !== 'reconnecting') {
        runtime.connectionStatus = 'error';
        runtime.lastError = errorMessage(error);
        void persistRuntime().catch((failure: unknown) =>
          log({ event: 'runtime_write_error', message: errorMessage(failure) }),
        );
      }
    });
  } else {
    runtime.ready = true;
    runtime.connectionStatus = 'local';
    await persistRuntime();
  }
  log({ event: 'listener_ready', localUrl: config.localUrl });
  console.log(`Credentials: ${path.join(config.projectDir, '.env')} (MCP_TOKEN / MCP_ADMIN_TOKEN)`);
  if (mode !== 'local' && mode === 'quick')
    console.log(
      'Quick Tunnel: the URL changes when the tunnel is recreated. Reconnect Notion after reading this line.',
    );
} catch (error) {
  log({ event: 'startup_error', message: errorMessage(error) });
  await stop(1);
}
