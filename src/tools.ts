import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Files } from './files.js';
import type { Processes } from './processes.js';
import { captureScreen, listDisplays, readImage } from './images.js';
import { errorMessage } from './utils.js';
import type { Gateway } from './gateway/gateway.js';
import { registerGatewayTools } from './gateway/tools.js';
import type { Approvals, AuditLog } from './approvals.js';
import type { SettingsStore } from './settings.js';
import type { Permission } from './permissions.js';

export type Logger = (event: Record<string, unknown>) => void;

export interface ToolServices {
  config: Config;
  files: Files;
  processes: Processes;
  log: Logger;
  gateway: Gateway;
  approvals: Approvals;
  audit: AuditLog;
  settings: SettingsStore;
}

/** Identifies the authenticated caller and what it is allowed to do. */
export interface Caller {
  id: string;
  permissions: Permission[];
  /** Set for shared tokens, so the audit log can name the token instead of a client ID. */
  tokenName?: string;
}

const pathInput = z
  .string()
  .min(1)
  .max(4096)
  .describe('Absolute path in MCP_ROOTS, or a path relative to the first root');
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional()
  .describe('Expected SHA-256 from read_file; detects concurrent changes');
const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const mutation = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const shellMutation = { ...mutation, openWorldHint: true };
const wait = z.number().int().min(0).max(10000).default(1000);
const imageSize = z.number().int().min(320).max(2560).default(1600);

/**
 * Permission required by each tool.
 *
 * A tool missing from this table is refused rather than allowed, so adding a tool
 * without deciding its permission fails closed instead of exposing it by accident.
 */
const toolPermission = {
  system_info: null,
  list_directory: 'files:read',
  find_files: 'files:read',
  search_text: 'files:read',
  file_info: 'files:read',
  read_file: 'files:read',
  read_image: 'files:read',
  write_file: 'files:write',
  edit_file: 'files:write',
  create_directory: 'files:write',
  move_path: 'files:write',
  delete_path: 'files:write',
  run_command: 'shell',
  read_command: 'shell',
  list_commands: 'shell',
  write_command_input: 'shell',
  stop_command: 'shell',
  list_displays: 'screen',
  take_screenshot: 'screen',
  read_audit: 'log',
} as const satisfies Record<string, Permission | null>;

export function createMcpServer(services: ToolServices, caller: Caller): McpServer {
  const { config, files, processes, log, approvals, audit, settings } = services;
  const owner = caller.id;
  const server = new McpServer(
    { name: 'pc-mcp-tunnel', version: '1.1.0' },
    {
      instructions:
        "Development tools on the owner's PC. Call system_info first. Relative paths use the first workspace root. Read files before editing; use sha256 for conflict detection. run_command returns a job_id: poll read_command using its output cursors until completion. Commands execute as the OS user, not in a sandbox, and may require the owner's approval. Screenshots are MCP image content. Do not assume the client can display images. Only act within the user's requested task.",
    },
  );

  function refusal(name: string, permission: Permission): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Access denied: ${name} needs the "${permission}" permission, which this token does not have. The owner can grant it in the PC MCP app under Access.`,
        },
      ],
    };
  }

  async function record(
    name: string,
    detail: string,
    outcome: 'allowed' | 'denied' | 'executed' | 'failed',
    durationMs: number | null,
  ): Promise<void> {
    if (!settings.get().logging.enabled) return;
    await audit
      .write({
        at: new Date().toISOString(),
        actor: caller.tokenName ?? owner,
        clientId: owner,
        kind: name.startsWith('mcp_') ? 'mcp' : name.startsWith('run_command') ? 'command' : 'file',
        action: name,
        detail,
        outcome,
        durationMs,
      })
      .catch(() => undefined);
  }

  async function execute(
    name: string,
    operation: () => Promise<CallToolResult>,
    /**
     * Runs after the permission check but before the tool body.
     *
     * Used by run_command so a caller without shell rights is refused immediately instead
     * of being asked to approve a command it may never run.
     */
    gate?: () => Promise<void>,
  ): Promise<CallToolResult> {
    if (!(name in toolPermission)) {
      await record(name, '', 'denied', null);
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    const required = toolPermission[name as keyof typeof toolPermission];
    if (required && !caller.permissions.includes(required)) {
      await record(name, '', 'denied', null);
      return refusal(name, required);
    }
    const start = Date.now();
    try {
      if (name === 'run_command' && !settings.get().shell.enabled)
        throw new Error('Command execution is disabled by the owner in PC MCP settings.');
      if (
        (name === 'take_screenshot' || name === 'list_displays') &&
        !settings.get().screenshots.enabled
      )
        throw new Error('Screenshots are disabled by the owner in PC MCP settings.');
      if (gate) await gate();
      const result = await operation();
      log({
        event: 'tool',
        tool: name,
        client: owner,
        ok: !result.isError,
        duration_ms: Date.now() - start,
      });
      if (!result.isError) await record(name, '', 'executed', Date.now() - start);
      return result;
    } catch (error) {
      log({ event: 'tool', tool: name, client: owner, ok: false, duration_ms: Date.now() - start });
      await record(name, '', 'failed', Date.now() - start);
      return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
    }
  }

  /**
   * Asks the owner to approve a command.
   *
   * Throws when the command is refused, which the tool wrapper turns into an error result.
   */
  async function approveCommand(command: string, cwd: string): Promise<void> {
    const started = Date.now();
    const resolved = await files.workspace.resolve(cwd);
    const outcome = await approvals.authorize({
      command,
      cwd: resolved,
      clientId: owner,
      rules: settings.get().approval,
    });
    await record(
      'run_command',
      command,
      outcome.action === 'allow' ? 'allowed' : 'denied',
      Date.now() - started,
    );
    if (outcome.action === 'deny')
      throw new Error(
        'The owner did not allow this command. Ask before proposing a different command.',
      );
  }

  function json(
    name: string,
    operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
    gate?: () => Promise<void>,
  ) {
    return execute(
      name,
      async () => {
        const result = await operation();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
      gate,
    );
  }

  server.registerTool(
    'system_info',
    {
      description:
        'Get OS, allowed workspace roots, enabled capabilities, and default shell. Call this before working on the PC.',
      inputSchema: {},
      annotations: readonly,
    },
    () =>
      json('system_info', () => ({
        platform: process.platform,
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        node: process.version,
        roots: files.workspace.roots,
        shell_enabled: config.shellEnabled,
        screenshots_enabled: config.screenshotsEnabled,
        default_shell: processes.defaultShell,
        max_file_bytes: config.maxFileBytes,
        command_timeout_ms: config.commandTimeoutMs,
        cpu_count: os.availableParallelism(),
        total_memory_bytes: os.totalmem(),
      })),
  );

  server.registerTool(
    'list_directory',
    {
      description:
        'List a directory, optionally as a bounded tree. Symlinks are listed but never traversed. Common build/dependency directories are omitted unless include_ignored=true.',
      inputSchema: {
        path: pathInput.default('.'),
        depth: z.number().int().min(1).max(8).default(1),
        limit: z.number().int().min(1).max(1000).default(200),
        include_ignored: z.boolean().default(false),
      },
      annotations: readonly,
    },
    (args) =>
      json('list_directory', () =>
        files.list(args.path, args.depth, args.limit, args.include_ignored),
      ),
  );

  server.registerTool(
    'find_files',
    {
      description:
        'Find paths by glob, e.g. **/*.ts or src/**. Bounded traversal of at most 20,000 entries; narrow path if truncated.',
      inputSchema: {
        path: pathInput.default('.'),
        pattern: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(1000).default(200),
        include_ignored: z.boolean().default(false),
      },
      annotations: readonly,
    },
    (args) =>
      json('find_files', () =>
        files.find(args.path, args.pattern, args.limit, args.include_ignored),
      ),
  );

  server.registerTool(
    'search_text',
    {
      description:
        'Search UTF-8 files for literal text and return matching lines. Use a glob to filter files. Reports skipped binary, oversized or unreadable files. For regex use run_command with rg if installed.',
      inputSchema: {
        path: pathInput.default('.'),
        query: z.string().min(1).max(5000),
        glob: z.string().min(1).max(256).default('**/*'),
        case_sensitive: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: readonly,
    },
    (args) =>
      json('search_text', () =>
        files.search(args.path, args.query, args.glob, args.case_sensitive, args.limit),
      ),
  );

  server.registerTool(
    'file_info',
    {
      description: 'Get file/directory type, size and modification time without reading contents.',
      inputSchema: { path: pathInput },
      annotations: readonly,
    },
    (args) => json('file_info', () => files.info(args.path)),
  );

  server.registerTool(
    'read_file',
    {
      description:
        'Read a UTF-8 text file with line numbers, pagination and its SHA-256 hash. Binary files are rejected. Follow next_line to continue reading.',
      inputSchema: {
        path: pathInput,
        start_line: z.number().int().min(1).default(1),
        max_lines: z.number().int().min(1).max(2000).default(300),
      },
      annotations: readonly,
    },
    (args) => json('read_file', () => files.read(args.path, args.start_line, args.max_lines)),
  );

  server.registerTool(
    'write_file',
    {
      description:
        'Create a UTF-8 file. Existing files require overwrite=true. Overwrites are atomic; supply expected_sha256 to detect changes since the last read.',
      inputSchema: {
        path: pathInput,
        content: z.string().max(config.maxFileBytes),
        overwrite: z.boolean().default(false),
        create_parents: z.boolean().default(true),
        expected_sha256: sha,
      },
      annotations: mutation,
    },
    (args) =>
      json('write_file', () =>
        files.write(
          args.path,
          args.content,
          args.overwrite,
          args.create_parents,
          args.expected_sha256,
        ),
      ),
  );

  server.registerTool(
    'edit_file',
    {
      description:
        'Apply exact text replacements in order, then save atomically. All edits must succeed. Match whitespace/line endings. Ambiguous matches require replace_all=true.',
      inputSchema: {
        path: pathInput,
        edits: z
          .array(
            z.object({
              old_text: z.string().min(1).max(config.maxFileBytes),
              new_text: z.string().max(config.maxFileBytes),
              replace_all: z.boolean().default(false),
            }),
          )
          .min(1)
          .max(100),
        expected_sha256: sha,
      },
      annotations: mutation,
    },
    (args) => json('edit_file', () => files.edit(args.path, args.edits, args.expected_sha256)),
  );

  server.registerTool(
    'create_directory',
    {
      description: 'Create a directory and missing parent directories under MCP_ROOTS.',
      inputSchema: { path: pathInput },
      annotations: { ...mutation, destructiveHint: false, idempotentHint: true },
    },
    (args) => json('create_directory', () => files.makeDirectory(args.path)),
  );

  server.registerTool(
    'move_path',
    {
      description:
        'Move or rename a file or directory. Destination must not exist; its parent must exist. Cross-volume moves are not supported.',
      inputSchema: { source: pathInput, destination: pathInput },
      annotations: mutation,
    },
    (args) => json('move_path', () => files.move(args.source, args.destination)),
  );

  server.registerTool(
    'delete_path',
    {
      description:
        'Delete a file or empty directory. Deleting a non-empty directory requires recursive=true. Workspace roots are protected. A symlink itself is deleted, not its target.',
      inputSchema: { path: pathInput, recursive: z.boolean().default(false) },
      annotations: mutation,
    },
    (args) => json('delete_path', () => files.delete(args.path, args.recursive)),
  );

  server.registerTool(
    'read_image',
    {
      description:
        'Read an image from MCP_ROOTS as MCP image content, scaled to max_size. Input limit is 16 MiB.',
      inputSchema: { path: pathInput, max_size: imageSize },
      annotations: readonly,
    },
    (args) => execute('read_image', () => readImage(files, args.path, args.max_size)),
  );

  if (config.shellEnabled) {
    server.registerTool(
      'run_command',
      {
        description:
          "Execute a shell command as the OS user. cwd must be in MCP_ROOTS; the command itself has full OS-user permissions. Depending on the owner's approval settings the command may be held until it is approved in the PC MCP app or Telegram, or refused outright. Returns within wait_ms with a job_id; poll read_command for long commands. Timeout kills the process tree. For dev servers set a longer timeout_ms (up to 24h). On Windows the default shell is PowerShell 5.1. This is piped I/O, not a PTY.",
        inputSchema: {
          command: z.string().min(1).max(100000),
          cwd: pathInput.default('.'),
          shell: z.enum(['powershell', 'cmd', 'bash', 'sh']).optional(),
          timeout_ms: z.number().int().min(1000).max(86400000).optional(),
          wait_ms: wait,
          keep_stdin: z.boolean().default(false),
        },
        annotations: shellMutation,
      },
      (args) =>
        json(
          'run_command',
          () =>
            processes.run(owner, {
              ...args,
              timeout_ms: args.timeout_ms ?? config.commandTimeoutMs,
            }),
          () => approveCommand(args.command, args.cwd),
        ),
    );

    server.registerTool(
      'read_command',
      {
        description:
          'Poll a command and read stdout/stderr. Pass returned stdout_cursor and stderr_cursor on the next poll to avoid duplicates. Cursors count UTF-16 characters. *_more indicates unread output; *_truncated indicates older output was evicted from the bounded buffer.',
        inputSchema: {
          job_id: z.string().uuid(),
          stdout_cursor: z.number().int().min(0).default(0),
          stderr_cursor: z.number().int().min(0).default(0),
          wait_ms: wait,
        },
        annotations: readonly,
      },
      (args) =>
        json('read_command', () =>
          processes.read(owner, args.job_id, args.stdout_cursor, args.stderr_cursor, args.wait_ms),
        ),
    );

    server.registerTool(
      'list_commands',
      {
        description:
          'List commands launched by this authenticated client. Completed history is bounded and kept in memory for at most one hour.',
        inputSchema: {},
        annotations: readonly,
      },
      () => json('list_commands', () => ({ commands: processes.list(owner) })),
    );

    server.registerTool(
      'write_command_input',
      {
        description:
          'Write UTF-8 text to stdin of a running command started with keep_stdin=true. Include a newline when answering a prompt. Set end=true to close stdin.',
        inputSchema: {
          job_id: z.string().uuid(),
          text: z.string().max(100000),
          end: z.boolean().default(false),
        },
        annotations: shellMutation,
      },
      (args) =>
        json('write_command_input', () => processes.input(owner, args.job_id, args.text, args.end)),
    );

    server.registerTool(
      'stop_command',
      {
        description:
          'Terminate the process tree of a command launched by this client. Does not accept arbitrary system PIDs.',
        inputSchema: { job_id: z.string().uuid() },
        annotations: shellMutation,
      },
      (args) => json('stop_command', () => processes.stop(owner, args.job_id)),
    );
  }

  if (config.screenshotsEnabled) {
    server.registerTool(
      'list_displays',
      {
        description:
          'List desktop displays available to the logged-in OS user. Screenshot tools need an active graphical session.',
        inputSchema: {},
        annotations: readonly,
      },
      () => json('list_displays', async () => ({ displays: await listDisplays() })),
    );

    server.registerTool(
      'take_screenshot',
      {
        description:
          'Capture the current desktop display as a PNG image in the MCP response. display is an index from list_displays. No screenshot is served at a public URL.',
        inputSchema: { display: z.number().int().min(0).max(32).default(0), max_size: imageSize },
        annotations: readonly,
      },
      (args) => execute('take_screenshot', () => captureScreen(args.display, args.max_size)),
    );
  }
  server.registerTool(
    'read_audit',
    {
      description:
        'Read recent audit events for this authenticated client. Requires the log permission.',
      inputSchema: { limit: z.number().int().min(1).max(300).default(50) },
      annotations: readonly,
    },
    ({ limit }) =>
      json('read_audit', () => ({
        entries: audit
          .tail(500)
          .filter((entry) => entry.clientId === owner)
          .slice(0, limit),
      })),
  );
  if (caller.permissions.includes('gateway')) registerGatewayTools(server, services.gateway, owner);
  return server;
}
