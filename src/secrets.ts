import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

/** Generates a 256-bit URL-safe secret. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface OwnerSecrets {
  /** Grants the full MCP permission set; used directly by clients. */
  bearerToken: string;
  /** Guards the control API and the OAuth login; never sent to MCP clients. */
  adminToken: string;
  envFile: string;
}

export async function readEnvFile(filename: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(filename, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? '';
  }
  return values;
}

/**
 * Rewrites the secrets in `.env`.
 *
 * Comments, ordering and unrelated variables are preserved so an existing file keeps
 * its documentation. The write goes through a temporary file and a rename, so a crash
 * cannot leave a half-written file that fails to parse.
 */
export async function rotateEnvToken(
  filename: string,
  changes: { ownerToken?: string; adminToken?: string },
): Promise<{ updated: string[] }> {
  const targets: [string, string | undefined][] = [
    ['MCP_TOKEN', changes.ownerToken],
    ['MCP_ADMIN_TOKEN', changes.adminToken],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])) as [string, string][];
  if (!targets.length) throw new Error('No token was supplied');
  const original = await readFile(filename, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const updated: string[] = [];
  for (const [key, value] of targets) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index === -1) throw new Error(`${key} is missing from .env`);
    lines[index] = `${key}=${value}`;
    updated.push(key);
  }
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, lines.join(eol), { mode: 0o600 });
  await rename(temporary, filename);
  return { updated };
}
