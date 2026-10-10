import { readFile } from 'node:fs/promises';
import { atomicWrite, isErrno, SerialQueue } from './utils.js';

const writes = new SerialQueue();

/** Remove obsolete authentication settings without rewriting other integration settings. */
export function migrateLegacyAuth(filename: string): Promise<boolean> {
  return writes.run(async () => {
    let original: string;
    try {
      original = await readFile(filename, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
    const next = original.replace(
      /^[\t ]*(?:export[\t ]+)?(?:MCP_TOKEN|MCP_ADMIN_TOKEN|MCP_CONTROL_PORT)[\t ]*=.*(?:\r?\n|$)/gm,
      '',
    );
    if (next === original) return false;
    await atomicWrite(filename, next);
    return true;
  });
}
