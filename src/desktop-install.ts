import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Install the complete executable before registering it for startup. */
export async function installDesktop(executable: string, home: string): Promise<string> {
  const source = path.resolve(executable);
  if (!(await lstat(source)).isFile() || path.extname(source).toLowerCase() !== '.exe')
    throw new Error('Standalone desktop executable is unavailable');
  await mkdir(home, { recursive: true });
  const destination = path.join(home, 'TMCP.exe');
  if (source.toLowerCase() === path.resolve(destination).toLowerCase()) return destination;
  const temporary = path.join(home, `.TMCP-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
