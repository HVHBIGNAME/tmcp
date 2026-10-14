import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Gateway } from './gateway.js';
import type { TrafficSpan } from '../traffic.js';
import { jsonResult, toolError } from '../tool-result.js';

const serverId = z.string().min(1).max(100).describe('Exact id returned by mcp_list_servers');
const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const mutable = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const wait = z.number().int().min(0).max(10000).default(1000);

export function registerGatewayTools(
  server: McpServer,
  gateway: Gateway,
  owner: string,
  traffic?: TrafficSpan,
  signal?: AbortSignal,
): string[] {
  const names: string[] = [];
  const register: typeof server.registerTool = (name, definition, callback) => {
    names.push(name);
    return server.registerTool(name, definition, callback);
  };
  async function execute(
    operation: () => Promise<CallToolResult>,
    target?: string,
  ): Promise<CallToolResult> {
    traffic?.running(undefined, target);
    try {
      signal?.throwIfAborted();
      const result = await operation();
      traffic?.result(Boolean(result.isError));
      return result;
    } catch (error) {
      traffic?.result(true);
      return toolError(error);
    }
  }
  const json = (operation: () => Promise<Record<string, unknown>> | Record<string, unknown>) =>
    execute(async () => {
      const result = await operation();
      return jsonResult(result);
    });
  const catalog = (
    id: string,
    name: string,
    operation: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    waitMs = 1000,
  ) =>
    execute(
      () => gateway.catalogCall(owner, id, name, operation, waitMs, signal),
      `${id} · ${name}`,
    );

  register(
    'mcp_list_servers',
    {
      description:
        'Discover MCP servers configured on this PC (OpenCode, Claude, Cursor, VS Code, Windsurf, Trae and explicit configs). Returns server IDs and connection status without credentials. Servers connect on demand.',
      inputSchema: {},
      annotations: readonly,
    },
    () => json(() => gateway.listServers()),
  );

  register(
    'mcp_list_tools',
    {
      description:
        "Get a backend MCP server's tool names, descriptions and exact JSON input schemas before calling them. query filters name/description. Follow next_offset within a page, then next_cursor for the next backend page (reset offset=0). A cold startup may return status=running: poll mcp_read_call with call_id.",
      inputSchema: {
        server_id: serverId,
        query: z.string().max(200).default(''),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
        wait_ms: wait,
      },
      annotations: readonly,
    },
    (args) =>
      catalog(
        args.server_id,
        'tools/list',
        (signal) =>
          gateway.listTools(
            args.server_id,
            args.cursor,
            args.query,
            args.offset,
            args.limit,
            signal,
          ),
        args.wait_ms,
      ),
  );

  register(
    'mcp_call_tool',
    {
      description:
        'Call ANY tool on a configured backend MCP server using its original name and JSON arguments from mcp_list_tools. Preserves text, images, structured content and errors. May return status=running with call_id; poll mcp_read_call without repeating the original operation. Calls are never automatically retried.',
      inputSchema: {
        server_id: serverId,
        tool: z.string().min(1).max(512),
        arguments: z.record(z.string(), z.unknown()).default({}),
        wait_ms: wait,
      },
      annotations: mutable,
    },
    (args) =>
      execute(
        () =>
          gateway.callTool(owner, args.server_id, args.tool, args.arguments, args.wait_ms, signal),
        `${args.server_id} · ${args.tool}`,
      ),
  );

  register(
    'mcp_read_call',
    {
      description:
        'Poll an in-flight backend MCP call. Returns the original result when complete, including MCP images. Results are retained in memory for up to 10 minutes within a bounded cache.',
      inputSchema: { call_id: z.string().uuid(), wait_ms: wait },
      annotations: readonly,
    },
    (args) => execute(() => gateway.readCall(owner, args.call_id, args.wait_ms, signal)),
  );

  register(
    'mcp_cancel_call',
    {
      description:
        'Request cancellation of your in-flight backend call. The backend decides whether cancellation is supported; already completed changes are not reverted.',
      inputSchema: { call_id: z.string().uuid() },
      annotations: mutable,
    },
    (args) => json(() => gateway.cancelCall(owner, args.call_id)),
  );

  register(
    'mcp_reload_servers',
    {
      description:
        'Re-read local MCP configs after changing them. Removed backends are disconnected. New backends become available through mcp_list_servers.',
      inputSchema: {},
      annotations: mutable,
    },
    () =>
      json(async () => {
        await gateway.reload(false);
        return gateway.listServers();
      }),
  );

  register(
    'mcp_list_resources',
    {
      description:
        "List a backend's resources or resource templates. Use cursor for backend pagination. If running, poll mcp_read_call.",
      inputSchema: {
        server_id: serverId,
        templates: z.boolean().default(false),
        cursor: z.string().optional(),
        wait_ms: wait,
      },
      annotations: readonly,
    },
    (args) =>
      catalog(
        args.server_id,
        'resources/list',
        async (signal) => {
          const client = await gateway.client(args.server_id);
          return args.templates
            ? client.listResourceTemplates({ cursor: args.cursor }, { timeout: 20000, signal })
            : client.listResources({ cursor: args.cursor }, { timeout: 20000, signal });
        },
        args.wait_ms,
      ),
  );

  register(
    'mcp_read_resource',
    {
      description:
        'Read a backend MCP resource by its original URI from mcp_list_resources. Resource text/blobs are returned without public file URLs. If running, poll mcp_read_call.',
      inputSchema: { server_id: serverId, uri: z.string().min(1).max(8192), wait_ms: wait },
      annotations: readonly,
    },
    (args) =>
      catalog(
        args.server_id,
        'resources/read',
        async (signal) =>
          (await gateway.client(args.server_id)).readResource(
            { uri: args.uri },
            { timeout: 30000, signal },
          ),
        args.wait_ms,
      ),
  );

  register(
    'mcp_list_prompts',
    {
      description:
        'List reusable prompts exposed by a backend MCP server. If running, poll mcp_read_call.',
      inputSchema: { server_id: serverId, cursor: z.string().optional(), wait_ms: wait },
      annotations: readonly,
    },
    (args) =>
      catalog(
        args.server_id,
        'prompts/list',
        async (signal) =>
          (await gateway.client(args.server_id)).listPrompts(
            { cursor: args.cursor },
            { timeout: 20000, signal },
          ),
        args.wait_ms,
      ),
  );

  register(
    'mcp_get_prompt',
    {
      description:
        'Retrieve a backend MCP prompt with its required string arguments. If running, poll mcp_read_call.',
      inputSchema: {
        server_id: serverId,
        name: z.string().min(1).max(512),
        arguments: z.record(z.string(), z.string()).default({}),
        wait_ms: wait,
      },
      annotations: readonly,
    },
    (args) =>
      catalog(
        args.server_id,
        'prompts/get',
        async (signal) =>
          (await gateway.client(args.server_id)).getPrompt(
            { name: args.name, arguments: args.arguments },
            { timeout: 20000, signal },
          ),
        args.wait_ms,
      ),
  );

  for (const tool of gateway.namespacedTools()) {
    register(
      tool.name,
      {
        title: tool.original.title,
        description: `${tool.original.description ?? tool.original.name}\nProxied through PC MCP. If status=running, poll mcp_read_call using call_id.`,
        inputSchema: tool.schema,
        annotations: { ...mutable, ...tool.original.annotations, openWorldHint: true },
      },
      (args) =>
        execute(
          () =>
            gateway.callTool(
              owner,
              tool.serverId,
              tool.original.name,
              z.record(z.string(), z.unknown()).parse(args),
              1000,
              signal,
            ),
          `${tool.serverId} · ${tool.original.name}`,
        ),
    );
  }
  return names;
}
