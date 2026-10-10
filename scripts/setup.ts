import { parseArgs } from 'node:util';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isErrno } from '../src/utils.js';
import { migrateLegacyAuth } from '../src/migration.js';

const { values } = parseArgs({
  options: { root: { type: 'string', multiple: true }, port: { type: 'string' } },
});
const filename = path.resolve('.env');
try {
  await stat(filename);
  await migrateLegacyAuth(filename);
  console.log(`Already configured: ${filename}. Edit this file to change settings.`);
} catch (error) {
  if (!isErrno(error, 'ENOENT')) throw error;
  const roots = await Promise.all((values.root ?? [process.cwd()]).map((root) => realpath(root)));
  for (const root of roots)
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const port = Number(values.port ?? '18787');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Port must be between 1024 and 65535');
  const template = await readFile(path.resolve('.env.example'), 'utf8');
  const env = template
    .replace(
      /^MCP_ROOTS=.*$/m,
      () => `MCP_ROOTS=${JSON.stringify(roots.map((root) => root.split(path.sep).join('/')))}`,
    )
    .replace(/^MCP_PORT=.*$/m, `MCP_PORT=${port}`);
  await writeFile(filename, env, { flag: 'wx', mode: 0o600 });
  await mkdir(path.resolve('.mcp-tunnel'), { recursive: true, mode: 0o700 });
  console.log(`Created ${filename}`);
  console.log(`Workspace roots: ${roots.join(', ')}`);
  console.log(
    'Client keys are issued in Access or with tmcp token create. Local control uses OS-protected IPC.',
  );
  console.log('Next: npm run discover; npm run build; npm run up');
}
