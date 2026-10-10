import { createServer, request, type RequestListener, type Server } from 'node:http';
import { chmod, lstat, mkdir, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWrite, hash, isErrno } from './utils.js';
import { isAlive } from './runtime.js';
import { windowsPowerShell } from './windows.js';

const descriptorSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  endpoint: z.string().min(1),
});
const pipePrefix = '\\\\.\\pipe\\tmcp-';
const run = promisify(execFile);

export function controlDescriptor(dataDir: string): string {
  return path.join(dataDir, 'ipc', 'control.json');
}

export async function controlPrivatePaths(dataDir: string): Promise<string[]> {
  return process.platform === 'win32'
    ? []
    : [
        path.join(
          await realpath(os.tmpdir()),
          `tmcp-${process.getuid!()}-${hash(path.resolve(dataDir)).slice(0, 16)}`,
        ),
      ];
}

async function privateDirectory(directory: string, create = false): Promise<void> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('IPC directory must not be a link');
  if (process.platform === 'win32') return;
  if (info.uid !== process.getuid!()) throw new Error('IPC directory belongs to another user');
  if (create) await chmod(directory, 0o700);
  else if (info.mode & 0o077) throw new Error('IPC directory must be private (mode 0700)');
}

async function protectPipe(directory: string, endpoint: string): Promise<void> {
  const relative = import.meta.url.endsWith('.ts') ? '../scripts/' : '../../scripts/';
  const filename = fileURLToPath(new URL(`${relative}secure-control-pipe.ps1`, import.meta.url));
  await run(
    windowsPowerShell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      filename,
      '-Directory',
      directory,
      '-PipeName',
      endpoint.slice('\\\\.\\pipe\\'.length),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
}

async function unpublish(descriptor: string, endpoint: string): Promise<void> {
  try {
    const saved = descriptorSchema.parse(JSON.parse(await readFile(descriptor, 'utf8')));
    if (saved.endpoint === endpoint) await rm(descriptor, { force: true });
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

async function closeListener(
  server: Server,
  sockets: Set<Socket>,
  endpoint: string,
  directory?: string,
) {
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 1500);
  deadline.unref();
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    clearTimeout(deadline);
  }
  if (directory) {
    await rm(endpoint, { force: true });
    try {
      await rmdir(directory);
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) throw error;
    }
  }
}

function controlListener(handler: RequestListener) {
  const sockets = new Set<Socket>();
  const bootstrapSockets = new Set<Socket>();
  let accepting = false;
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    if (!accepting || bootstrapSockets.has(req.socket)) {
      res.writeHead(503, { Connection: 'close' });
      res.end();
      return;
    }
    handler(req, res);
  });
  server.maxConnections = 64;
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    if (!accepting) bootstrapSockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      bootstrapSockets.delete(socket);
    });
  });
  return {
    server,
    sockets,
    activate() {
      for (const socket of bootstrapSockets) socket.destroy();
      accepting = true;
    },
    deactivate() {
      accepting = false;
    },
  };
}

/** HTTP framing over an OS-protected IPC endpoint. */
export async function listenControl(dataDir: string, handler: RequestListener) {
  const descriptor = controlDescriptor(dataDir);
  const directory = path.dirname(descriptor);
  await privateDirectory(directory, true);
  const [socketDirectory] = await controlPrivatePaths(dataDir);
  if (socketDirectory) await privateDirectory(socketDirectory, true);
  const endpoint = socketDirectory
    ? path.join(socketDirectory, `p${randomUUID().slice(0, 8)}`)
    : `${pipePrefix}${randomUUID()}`;
  const listener = controlListener(handler);
  const { server, sockets } = listener;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      listener.deactivate();
      const errors: unknown[] = [];
      try {
        await unpublish(descriptor, endpoint);
      } catch (error) {
        errors.push(error);
      }
      try {
        await closeListener(server, sockets, endpoint, socketDirectory);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'IPC shutdown failed');
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (process.platform === 'win32') await protectPipe(directory, endpoint);
    else await chmod(endpoint, 0o600);
    listener.activate();
    await atomicWrite(descriptor, JSON.stringify({ version: 1, pid: process.pid, endpoint }));
    return { endpoint, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'IPC startup failed');
    }
    throw error;
  }
}

export async function readControlEndpoint(dataDir: string): Promise<string> {
  const filename = controlDescriptor(dataDir);
  await privateDirectory(path.dirname(filename));
  const file = await lstat(filename);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Invalid IPC descriptor');
  if (process.platform !== 'win32' && (file.uid !== process.getuid!() || file.mode & 0o077))
    throw new Error('IPC descriptor must be private (mode 0600)');
  const saved = descriptorSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  if (!isAlive(saved.pid)) throw new Error('The IPC server is no longer running');
  if (process.platform === 'win32') {
    if (
      !saved.endpoint.startsWith(pipePrefix) ||
      !z.uuid().safeParse(saved.endpoint.slice(pipePrefix.length)).success
    )
      throw new Error('Invalid local pipe name');
  } else {
    if (!path.isAbsolute(saved.endpoint)) throw new Error('Invalid Unix socket path');
    await privateDirectory(path.dirname(saved.endpoint));
    const socket = await lstat(saved.endpoint);
    if (!socket.isSocket() || socket.uid !== process.getuid!() || socket.mode & 0o077)
      throw new Error('Unix control socket must be private (mode 0600)');
  }
  return saved.endpoint;
}

export interface IpcRequest {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  signal?: AbortSignal;
}

export async function ipcFetch(
  dataDir: string,
  route: string,
  options: IpcRequest = {},
): Promise<Response> {
  if (!/^\/_control\/[A-Za-z0-9_/?=&.-]+$/.test(route) || route.includes('..'))
    throw new Error('Invalid control route');
  const socketPath = await readControlEndpoint(dataDir);
  const headers = new Headers(options.headers);
  headers.set('Host', 'tmcp.local');
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    headers.set('Content-Length', String(Buffer.byteLength(options.body)));
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        path: route,
        method: options.method ?? 'GET',
        headers: Object.fromEntries(headers),
        signal: options.signal ?? AbortSignal.timeout(15000),
        agent: false,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value])
            responseHeaders.append(name, entry);
        const status = incoming.statusCode ?? 500;
        const empty = [204, 304].includes(status) || options.method === 'HEAD';
        if (empty) incoming.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}
