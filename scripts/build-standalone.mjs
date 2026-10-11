import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build the standalone EXE on Windows x64.');
const exec = promisify(execFile);
async function run(file, args, options) {
  const label = `${path.basename(file)} ${args[0] ?? ''}`;
  const started = performance.now();
  process.stdout.write(`Building: ${label}\n`);
  const operation = exec(file, args, options);
  if (file === 'dotnet') {
    operation.child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    operation.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }
  const result = await operation;
  process.stdout.write(`Built ${label} in ${Math.round((performance.now() - started) / 1000)}s\n`);
  return result;
}
const root = process.cwd();
const work = path.resolve('.mcp-tunnel', 'standalone-build');
const cache = path.resolve(process.env.TMCP_BUILD_CACHE ?? '.mcp-tunnel/build-cache');
const payload = path.join(work, 'payload');
const zip = path.join(work, 'payload.zip');
const metadata = path.join(work, 'payload.json');
const output = path.join(work, 'published');
const manifest = JSON.parse(await readFile('scripts/windows-runtime.json', 'utf8'));
const cloudflare = JSON.parse(
  await readFile('scripts/cloudflared-release.json', 'utf8'),
).assets.find((asset) => asset.name === 'cloudflared-windows-amd64.exe');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(asset) {
  const filename = path.join(cache, asset.file);
  try {
    if ((await digest(filename)) === asset.sha256) return filename;
    throw new Error(`Cached runtime checksum mismatch: ${asset.file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body)
    throw new Error(`Runtime download failed: ${asset.file} (${response.status})`);
  const temporary = `${filename}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if ((await digest(temporary)) !== asset.sha256)
      throw new Error(`Runtime checksum mismatch: ${asset.file}`);
    await cp(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
  return filename;
}

async function shell(action, source, destination) {
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts/bundle-windows.ps1'),
      '-Action',
      action,
      '-Source',
      source,
      ...(destination ? ['-Destination', destination] : []),
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}

async function runtimes() {
  const nodeZip = await download(manifest.node);
  const webCab = await download(manifest.webview);
  const cloudflared = await download({
    file: cloudflare.name,
    url: cloudflare.browser_download_url,
    sha256: cloudflare.digest.replace('sha256:', ''),
  });
  const nodeExtract = path.join(work, 'node');
  const webExtract = path.join(work, 'webview');
  await mkdir(nodeExtract);
  await mkdir(webExtract);
  await run('tar', ['-xf', nodeZip, '-C', nodeExtract]);
  await run(
    path.join(process.env.SystemRoot, 'System32/expand.exe'),
    [webCab, '-F:*', webExtract],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const nodeFolder = (await readdir(nodeExtract))[0];
  const webFolder = (await readdir(webExtract)).find((name) =>
    name.startsWith('Microsoft.WebView2.FixedVersionRuntime.'),
  );
  if (!nodeFolder || !webFolder) throw new Error('Unexpected runtime archive layout');
  await cp(path.join(nodeExtract, nodeFolder), path.join(payload, 'runtime'), { recursive: true });
  await cp(path.join(webExtract, webFolder), path.join(payload, 'browser-runtime'), {
    recursive: true,
  });
  await shell('verify', path.join(payload, 'browser-runtime', 'msedgewebview2.exe'));
  await mkdir(path.join(payload, 'bin'));
  await cp(cloudflared, path.join(payload, 'bin', 'cloudflared.exe'));
}

async function application() {
  for (const file of ['package.json', 'package-lock.json'])
    await cp(path.join(root, file), path.join(payload, file));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this build through npm run build:standalone.');
  const result = await run(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', payload],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
  for (const file of [
    'dist/src',
    'ui/public',
    'scripts/secure-control-pipe.ps1',
    'README.md',
    'docs/access-model.md',
  ]) {
    await mkdir(path.dirname(path.join(payload, file)), { recursive: true });
    await cp(path.join(root, file), path.join(payload, file), {
      recursive: true,
      filter: (source) => !source.endsWith('.map'),
    });
  }
}

await mkdir(cache, { recursive: true });
await rm(work, { recursive: true, force: true });
await mkdir(payload, { recursive: true });
await mkdir(output);
await Promise.all([runtimes(), application()]);
await run(
  path.join(payload, 'runtime/node.exe'),
  [
    '--input-type=module',
    '-e',
    "import sharp from 'sharp'; import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'; if(!McpServer||!sharp.versions.png) process.exit(1);",
  ],
  { cwd: payload },
);
await shell('zip', payload, zip);
await writeFile(
  metadata,
  JSON.stringify({
    version: pkg.version,
    sha256: await digest(zip),
    node: manifest.node.version,
    webview: manifest.webview.version,
  }),
);
await run(
  'dotnet',
  [
    'publish',
    'ui/PcMcp.csproj',
    '--disable-build-servers',
    '-p:UseSharedCompilation=false',
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-o',
    output,
    `-p:PayloadArchive=${zip}`,
    `-p:PayloadMetadata=${metadata}`,
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
  ],
  { cwd: root, maxBuffer: 8 * 1024 * 1024 },
);
// NuGet may copy IntelliSense documentation independently of the SDK publish flags.
for (const name of ['Microsoft.Web.WebView2.Core.xml', 'Microsoft.Web.WebView2.WinForms.xml'])
  await rm(path.join(output, name), { force: true });
const files = await readdir(output);
if (files.length !== 1 || files[0] !== 'PcMcp.exe')
  throw new Error(`Expected exactly one published executable, got: ${files.join(', ')}`);
await mkdir(path.join(root, 'release'), { recursive: true });
const target = path.join(root, 'release', 'TMCP.exe');
await cp(path.join(output, 'PcMcp.exe'), target);
console.log(
  JSON.stringify({
    executable: target,
    bytes: (await stat(target)).size,
    sha256: await digest(target),
    version: pkg.version,
  }),
);
