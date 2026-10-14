import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from './utils.js';

export function toolError(error: unknown): CallToolResult {
  const message = errorMessage(error);
  const errno = error instanceof Error && 'code' in error ? String(error.code) : '';
  const cancelled = error instanceof Error && error.name === 'AbortError';
  const code = cancelled
    ? 'cancelled'
    : errno === 'ENOENT' || /Unknown .*ID|Unknown .*id|not found|expired MCP call_id/i.test(message)
      ? 'not_found'
      : errno === 'EEXIST' || /already exists/i.test(message)
        ? 'already_exists'
        : errno === 'EACCES' ||
            errno === 'EPERM' ||
            /Access denied|outside MCP_ROOTS|escapes MCP_ROOTS|credentials|disabled by the owner/i.test(
              message,
            )
          ? 'permission_denied'
          : /sha256 mismatch|File has changed/i.test(message)
            ? 'conflict'
            : /limit|exceeds|Maximum of|too large/i.test(message)
              ? 'limit_exceeded'
              : /timed out|timeout/i.test(message)
                ? 'timeout'
                : /must be|Invalid|ambiguous|old_text|start_column|Binary file|stdin is closed/i.test(
                      message,
                    )
                  ? 'invalid_argument'
                  : 'operation_failed';
  const recovery =
    code === 'conflict'
      ? 'Read the file again and recompute the edit with its new sha256.'
      : code === 'permission_denied'
        ? 'Check system_info and the permissions/settings configured by the owner.'
        : code === 'limit_exceeded'
          ? 'Request a smaller page/result or finish existing work before retrying.'
          : code === 'cancelled'
            ? 'The request was cancelled. Inspect any existing job or file state before repeating a mutation.'
            : code === 'not_found'
              ? 'Refresh the relevant directory, job list or server catalogue and use its exact identifier.'
              : 'Read the error and current state before retrying; mutations must not be blindly repeated.';
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}\n${recovery}` }],
    _meta: { 'tmcp/error': { code, message, retryable: false, recovery } },
  };
}

export function jsonResult(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
