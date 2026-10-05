import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const output = path.resolve('release');
await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(os.tmpdir(), 'tmcp-package-'));
const gui = process.argv.includes('--gui');
try {
  const files = gui
    ? ['dist-ui']
    : [
        'dist/src',
        'dist/scripts/setup.js',
        'dist/scripts/discover.js',
        'dist/scripts/control.js',
        'package.json',
        'package-lock.json',
        '.env.example',
        'mcp-servers.example.json',
        'README.md',
        'scripts/install-runtime.mjs',
        'ui/public/index.html',
        'ui/public/app.js',
        'ui/public/api.js',
        'ui/public/components.js',
        'ui/public/icons.js',
        'ui/public/style.css',
        'ui/public/logo.svg',
      ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await cp(path.resolve(file), path.join(stage, file), {
      recursive: true,
      filter: (source) =>
        !source.includes('.WebView2') && !source.endsWith('.xml') && !source.endsWith('.pdb'),
    });
  }
  const basename = gui ? 'tmcp-windows-x64' : 'tmcp-core';
  if (!gui) await exec('tar', ['-czf', path.join(output, `${basename}.tar.gz`), '-C', stage, '.']);
  if (process.platform === 'win32')
    await exec('tar', ['-a', '-cf', path.join(output, `${basename}.zip`), '-C', stage, '.']);
  else await exec('zip', ['-q', '-r', path.join(output, `${basename}.zip`), '.'], { cwd: stage });
  const sums = [];
  for (const name of (await readdir(output)).sort()) {
    if (!/\.(zip|tar\.gz)$/.test(name)) continue;
    sums.push(
      `${createHash('sha256')
        .update(await readFile(path.join(output, name)))
        .digest('hex')}  ${name}`,
    );
  }
  await writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  console.log(`Packaged ${basename} in release/`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
