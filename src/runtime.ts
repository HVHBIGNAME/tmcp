import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isErrno } from './utils.js';

export const runtimeSchema = z
  .object({
    service: z.literal('pc-mcp-tunnel'),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    startedAt: z.string(),
    ready: z.boolean(),
    mode: z.enum(['local', 'quick', 'named']),
    localUrl: z.string().url(),
    publicUrl: z.string().url(),
    mcpUrl: z.string().url(),
  })
  .passthrough();
export type RuntimeInfo = z.infer<typeof runtimeSchema>;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    if (isErrno(error, 'EPERM')) return true;
    throw error;
  }
}

export async function acquireLock(
  dataDir: string,
  name = 'server.lock',
): Promise<() => Promise<void>> {
  const filename = path.join(dataDir, name);
  const create = () => open(filename, 'wx', 0o600);
  let handle;
  try {
    handle = await create();
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const pid = Number((await readFile(filename, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid lock file: ${filename}`);
    if (isAlive(pid))
      throw new Error(`MCP gateway is already running (PID ${pid}). Use npm run status`);
    await rm(filename);
    handle = await create();
  }
  await handle.writeFile(String(process.pid));
  return async () => {
    await handle.close();
    await rm(filename, { force: true });
  };
}
