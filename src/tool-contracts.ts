import { z } from 'zod';
import type { Permission } from './permissions.js';

export const toolPermission = {
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

export function requiredPermission(name: string): Permission | null | undefined {
  return Object.hasOwn(toolPermission, name)
    ? toolPermission[name as keyof typeof toolPermission]
    : undefined;
}

const integer = z.number().int();
const text = z.string();
const entry = z.object({
  path: text,
  relative: text,
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  depth: integer,
});
const page = {
  truncated: z.boolean(),
  next_offset: integer.nullable(),
  scanned: integer,
  scan_limit_reached: z.boolean(),
};
const paths = { entries: z.array(entry), ...page };
const job = {
  job_id: text,
  command: text,
  command_truncated: z.boolean(),
  cwd: text,
  pid: integer.optional(),
  status: z.enum(['running', 'exited', 'failed', 'stopped', 'timed_out']),
  started_at: text,
  finished_at: text.optional(),
  exit_code: integer.nullable(),
  signal: text.nullable(),
  error: text.optional(),
};
const output = {
  ...job,
  stdout: text,
  stderr: text,
  stdout_cursor: integer,
  stderr_cursor: integer,
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  stdout_more: z.boolean(),
  stderr_more: z.boolean(),
};
const image = {
  width: integer,
  height: integer,
  mime_type: z.literal('image/png'),
  bytes: integer,
};

export const outputSchemas: Record<keyof typeof toolPermission, z.ZodRawShape> = {
  system_info: {
    platform: text,
    release: text,
    arch: text,
    hostname: text,
    node: text,
    node_executable: text,
    roots: z.array(text),
    permissions: z.array(text),
    available_tools: z.array(text),
    available_tools_truncated: z.boolean(),
    limits: z.object({
      running_commands: integer,
      gateway_calls: integer,
      image_operations: integer,
      max_command_chars: integer,
      read_page_chars: integer,
      traversal_entries: integer,
    }),
    shell_enabled: z.boolean(),
    screenshots_enabled: z.boolean(),
    gateway_enabled: z.boolean(),
    default_shell: text,
    supported_shells: z.array(text),
    max_file_bytes: integer,
    command_timeout_ms: integer,
    cpu_count: integer,
    total_memory_bytes: integer,
  },
  list_directory: paths,
  find_files: paths,
  search_text: {
    ...page,
    matches: z.array(
      z.object({
        path: text,
        line: integer,
        column: integer,
        text,
        text_start_column: integer,
        text_truncated: z.boolean(),
      }),
    ),
    skipped: z.array(z.object({ path: text, reason: text })),
    skipped_count: integer,
  },
  file_info: {
    path: text,
    type: z.enum(['file', 'directory', 'symlink', 'other']),
    bytes: integer,
    modified_at: text,
  },
  read_file: {
    path: text,
    sha256: text,
    total_lines: integer,
    start_line: integer,
    start_column: integer,
    next_line: integer.nullable(),
    next_column: integer.nullable(),
    content: text,
    truncated: z.boolean(),
    encoding: z.literal('utf-8'),
    bom: z.boolean(),
    line_ending: z.enum(['lf', 'crlf', 'mixed', 'none']),
  },
  write_file: { path: text, bytes: integer, sha256: text },
  edit_file: { path: text, replacements: integer, sha256: text },
  create_directory: { path: text },
  move_path: { source: text, destination: text },
  delete_path: { deleted: text },
  read_image: image,
  take_screenshot: image,
  run_command: output,
  read_command: output,
  stop_command: output,
  list_commands: { commands: z.array(z.object(job)) },
  write_command_input: { job_id: text, stdin_closed: z.boolean() },
  list_displays: { displays: z.array(z.object({ index: integer, name: text })) },
  read_audit: {
    entries: z.array(
      z.object({
        at: text,
        actor: text,
        clientId: text,
        kind: text,
        action: text,
        detail: text,
        detail_truncated: z.boolean(),
        outcome: text,
        durationMs: z.number().nullable(),
      }),
    ),
    truncated: z.boolean(),
  },
};
