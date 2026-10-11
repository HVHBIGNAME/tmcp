import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { version } from '../version.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { childEnvironment, type Config } from '../config.js';
import { errorMessage, hash, isErrno, SerialQueue } from '../utils.js';
import type { Logger } from '../tools.js';
import { redactedStream } from '../redaction.js';
import {
  discoverServers,
  publicServer,
  redact,
  backendSecrets,
  type Discovery,
  type ServerSpec,
} from './discovery.js';

interface Backend {
  spec: ServerSpec;
  client?: Client;
  transport?: Transport;
  connecting?: Promise<Client>;
  connectionAbort?: AbortController;
  error?: string;
  tools?: Tool[];
}

interface RemoteCall {
  id: string;
  owner: string;
  serverId: string;
  tool: string;
  startedAt: number;
  finishedAt?: number;
  result?: CallToolResult;
  done: Promise<void>;
  abort: AbortController;
  bytes: number;
}

export class Gateway {
  private readonly backends = new Map<string, Backend>();
  private readonly calls = new Map<string, RemoteCall>();
  private readonly reloads = new SerialQueue();
  private discovery: Discovery = { servers: [], sources: [], diagnostics: [] };
  private closing = false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  async reload(warmup = true): Promise<void> {
    await this.reloads.run(async () => {
      if (this.closing) throw new Error('Gateway is shutting down');
      const discovery = await discoverServers(this.config);
      const next = new Set(discovery.servers.map((spec) => spec.id));
      for (const [id, backend] of this.backends) {
        if (!next.has(id)) {
          await this.disconnect(backend);
          this.backends.delete(id);
        }
      }
      for (const spec of discovery.servers) {
        const existing = this.backends.get(spec.id);
        if (existing) existing.spec = spec;
        else this.backends.set(spec.id, { spec });
      }
      this.discovery = discovery;
      if (warmup && this.config.gatewayMode === 'namespaced') await this.warmup();
    });
  }

  listServers() {
    return {
      mode: this.config.gatewayMode,
      activeCalls: [...this.calls.values()].filter((call) => !call.finishedAt).length,
      sources: this.discovery.sources,
      diagnostics: this.discovery.diagnostics,
      servers: [...this.backends.values()].map((backend) => ({
        ...publicServer(backend.spec),
        status: backend.client
          ? 'connected'
          : backend.connecting
            ? 'connecting'
            : backend.error
              ? 'error'
              : 'not_connected',
        tools_cached: backend.tools?.length,
        error: backend.error,
      })),
    };
  }

  private backend(id: string): Backend {
    const backend = this.backends.get(id);
    if (!backend) throw new Error('Unknown server_id; call mcp_list_servers');
    return backend;
  }

  private makeTransport(spec: ServerSpec, forceSse = false): Transport {
    if (spec.kind === 'stdio') {
      const env = Object.fromEntries(
        Object.entries(childEnvironment()).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: { ...env, ...spec.env },
        stderr: 'pipe',
        maxBufferSize: 20 * 1024 * 1024,
      });
      const output = redactedStream(backendSecrets(spec), (text) => {
        if (text.trim())
          this.log({
            event: 'backend_stderr',
            server: spec.id,
            message: text.trim().slice(0, 2000),
          });
      });
      transport.stderr?.on('data', (chunk: Buffer) => output.write(chunk));
      transport.stderr?.once('end', () => output.end());
      return transport;
    }
    if (spec.kind === 'sse' || forceSse) {
      return new SSEClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
        eventSourceInit: {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            for (const [key, value] of Object.entries(spec.headers)) headers.set(key, value);
            return fetch(input, { ...init, headers });
          },
        },
      });
    }
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    });
  }

  private async open(backend: Backend, forceSse = false): Promise<Client> {
    const transport = this.makeTransport(backend.spec, forceSse);
    const client = new Client(
      { name: 'pc-mcp-gateway', version },
      { capabilities: { roots: { listChanged: false } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: this.config.roots.map((root) => ({ uri: pathToFileURL(root).href, name: root })),
    }));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      backend.tools = undefined;
    });
    client.onclose = () => {
      if (backend.client === client) {
        backend.client = undefined;
        backend.transport = undefined;
      }
    };
    client.onerror = (error) => {
      const message = errorMessage(error);
      backend.error = message.startsWith('Received a response for an unknown message ID')
        ? 'Backend sent a late or unmatched response'
        : redact(backend.spec, message);
    };
    backend.transport = transport;
    const controller = new AbortController();
    backend.connectionAbort = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error('MCP connection timed out')),
      this.config.backendConnectTimeoutMs,
    );
    try {
      await Promise.race([
        client.connect(transport, {
          timeout: this.config.backendConnectTimeoutMs,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          }),
        ),
      ]);
      if (this.closing) throw new Error('Gateway is shutting down');
      backend.client = client;
      backend.error = undefined;
      return client;
    } catch (error) {
      await this.closeTransport(transport, client);
      backend.transport = undefined;
      if (
        !forceSse &&
        backend.spec.kind === 'http' &&
        error instanceof StreamableHTTPError &&
        [404, 405].includes(error.code ?? 0)
      )
        return this.open(backend, true);
      backend.error = redact(backend.spec, errorMessage(error));
      throw new Error(`MCP server ${backend.spec.name}: ${backend.error}`);
    } finally {
      clearTimeout(timeout);
      if (backend.connectionAbort === controller) backend.connectionAbort = undefined;
    }
  }

  async client(id: string): Promise<Client> {
    if (this.closing) throw new Error('Gateway is shutting down');
    const backend = this.backend(id);
    if (backend.client) return backend.client;
    if (!backend.connecting)
      backend.connecting = this.open(backend).finally(() => {
        backend.connecting = undefined;
      });
    return backend.connecting;
  }

  async listTools(
    id: string,
    cursor: string | undefined,
    query: string,
    offset: number,
    limit: number,
  ) {
    const backend = this.backend(id);
    const client = await this.client(id);
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20000 });
    if (!cursor && !page.nextCursor) backend.tools = page.tools;
    const matches = page.tools.filter((tool) =>
      `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query.toLowerCase()),
    );
    const tools = matches
      .slice(offset, offset + limit)
      .map((tool) => ({ ...tool, gateway_name: this.toolName(backend.spec, tool.name) }));
    return {
      server_id: id,
      server_info: client.getServerVersion(),
      server_instructions: client.getInstructions(),
      tools,
      total_in_page: matches.length,
      next_offset: offset + limit < matches.length ? offset + limit : null,
      next_cursor: page.nextCursor ?? null,
    };
  }

  private toolName(spec: ServerSpec, name: string): string {
    return `${spec.id}__${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}_${hash(name).slice(0, 6)}`;
  }

  async warmup(): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map(async (backend) => {
        try {
          const client = await this.client(backend.spec.id);
          const tools: Tool[] = [];
          let cursor: string | undefined;
          for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (!cursor) {
              backend.tools = tools;
              return;
            }
          }
          throw new Error('Tool catalogue exceeds 20 pages; use mcp_list_tools pagination');
        } catch (error) {
          backend.error = redact(backend.spec, errorMessage(error));
        }
      }),
    );
  }

  namespacedTools() {
    if (this.config.gatewayMode !== 'namespaced') return [];
    const tools: { name: string; serverId: string; original: Tool; schema: z.ZodType }[] = [];
    for (const backend of this.backends.values()) {
      for (const original of backend.tools ?? []) {
        try {
          tools.push({
            name: this.toolName(backend.spec, original.name),
            serverId: backend.spec.id,
            original,
            schema: z.fromJSONSchema(
              original.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
            ),
          });
        } catch (error) {
          this.log({
            event: 'tool_schema_not_convertible',
            server: backend.spec.id,
            tool: original.name,
            message: errorMessage(error),
          });
        }
      }
    }
    return tools;
  }

  private pruneCalls(): void {
    let bytes = [...this.calls.values()].reduce((total, call) => total + call.bytes, 0);
    for (const [id, call] of this.calls) {
      if (
        call.finishedAt &&
        (Date.now() - call.finishedAt > 10 * 60 * 1000 ||
          this.calls.size > 100 ||
          bytes > 64 * 1024 * 1024)
      ) {
        this.calls.delete(id);
        bytes -= call.bytes;
      }
    }
  }

  async callTool(
    owner: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
    waitMs: number,
  ): Promise<CallToolResult> {
    return this.runCall(
      owner,
      id,
      name,
      (client, signal) =>
        client
          .callTool({ name, arguments: args }, CallToolResultSchema, {
            timeout: this.config.backendTimeoutMs,
            signal,
          })
          .then((result) => CallToolResultSchema.parse(result)),
      waitMs,
    );
  }

  async catalogCall(
    owner: string,
    id: string,
    name: string,
    operation: () => Promise<Record<string, unknown>>,
    waitMs = 1000,
  ): Promise<CallToolResult> {
    return this.runCall(
      owner,
      id,
      name,
      async () => {
        const result = await operation();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
      waitMs,
    );
  }

  private async runCall(
    owner: string,
    id: string,
    name: string,
    operation: (client: Client, signal: AbortSignal) => Promise<CallToolResult>,
    waitMs: number,
  ): Promise<CallToolResult> {
    if (this.closing) throw new Error('Gateway is shutting down');
    this.pruneCalls();
    if ([...this.calls.values()].filter((call) => !call.finishedAt).length >= 16)
      throw new Error('Maximum of 16 in-flight MCP calls reached');
    const backend = this.backend(id);
    const call: RemoteCall = {
      id: randomUUID(),
      owner,
      serverId: id,
      tool: name,
      startedAt: Date.now(),
      abort: new AbortController(),
      bytes: 0,
      done: Promise.resolve(),
    };
    this.calls.set(call.id, call);
    call.done = (async () => {
      try {
        const client = await this.client(id);
        call.abort.signal.throwIfAborted();
        const result = await operation(client, call.abort.signal);
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > 16 * 1024 * 1024)
          throw new Error('Backend result exceeds 16 MiB; request a smaller result');
        call.result = result;
        call.bytes = bytes;
      } catch (error) {
        call.result = {
          isError: true,
          content: [{ type: 'text', text: redact(backend.spec, errorMessage(error)) }],
        };
      } finally {
        call.finishedAt = Date.now();
        this.log({
          event: 'backend_tool',
          server: id,
          tool: name,
          client: owner,
          ok: !call.result?.isError,
          duration_ms: call.finishedAt - call.startedAt,
        });
        this.pruneCalls();
      }
    })();
    return this.readCall(owner, call.id, waitMs);
  }

  async readCall(owner: string, id: string, waitMs: number): Promise<CallToolResult> {
    const call = this.calls.get(id);
    if (!call || call.owner !== owner)
      throw new Error('Unknown or expired MCP call_id for this client');
    if (!call.finishedAt && waitMs > 0) {
      const abort = new AbortController();
      try {
        await Promise.race([call.done, delay(waitMs, undefined, { signal: abort.signal })]);
      } finally {
        abort.abort();
      }
    }
    if (call.result)
      return {
        ...call.result,
        _meta: {
          ...call.result._meta,
          'gateway/call_id': id,
          'gateway/server_id': call.serverId,
          'gateway/status': 'completed',
        },
      };
    const status = {
      call_id: id,
      server_id: call.serverId,
      tool: call.tool,
      status: 'running',
      next: 'Poll mcp_read_call with this call_id. Do not repeat the original call.',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(status) }],
      structuredContent: status,
      _meta: { 'gateway/status': 'running', 'gateway/call_id': id },
    };
  }

  cancelCall(owner: string, id: string) {
    const call = this.calls.get(id);
    if (!call || call.owner !== owner) throw new Error('Unknown MCP call_id for this client');
    call.abort.abort();
    return {
      call_id: id,
      cancellation_requested: true,
      note: 'Cancellation is cooperative; a backend may already have completed side effects.',
    };
  }

  private async closeTransport(transport: Transport, client?: Client): Promise<void> {
    if (
      process.platform === 'win32' &&
      transport instanceof StdioClientTransport &&
      transport.pid
    ) {
      const pid = transport.pid;
      try {
        await promisify(execFile)('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
          windowsHide: true,
          timeout: 10000,
        });
      } catch (error) {
        try {
          process.kill(pid, 0);
        } catch (checkError) {
          if (isErrno(checkError, 'ESRCH')) {
            await transport.close();
            return;
          }
          throw checkError;
        }
        throw error;
      }
    }
    if (client) await client.close();
    else await transport.close();
  }

  private async disconnect(backend: Backend): Promise<void> {
    backend.connectionAbort?.abort(new Error('MCP backend disconnected'));
    if (backend.transport) await this.closeTransport(backend.transport, backend.client);
    backend.client = undefined;
    backend.transport = undefined;
    backend.tools = undefined;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const call of this.calls.values()) if (!call.finishedAt) call.abort.abort();
    const results = await Promise.allSettled(
      [...this.backends.values()].map((backend) => this.disconnect(backend)),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Failed to close MCP backends',
      );
  }
}
