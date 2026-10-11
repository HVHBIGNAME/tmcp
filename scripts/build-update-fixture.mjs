import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The update fixture requires Windows.');
const directory = path.resolve('.mcp-tunnel/update-fixture');
await mkdir(directory, { recursive: true });
const metadata = JSON.parse(await readFile('.mcp-tunnel/standalone-build/payload.json', 'utf8'));
metadata.version = '0.0.1';
const manifest = path.join(directory, 'payload.json');
await writeFile(manifest, JSON.stringify(metadata));
const result = await promisify(execFile)(
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
    path.join(directory, 'published'),
    '-p:Version=0.0.1',
    `-p:PayloadArchive=${path.resolve('.mcp-tunnel/standalone-build/payload.zip')}`,
    `-p:PayloadMetadata=${manifest}`,
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
  ],
  { maxBuffer: 8 * 1024 * 1024 },
);
process.stdout.write(result.stdout);
process.stdout.write(
  'Local-only older-version fixture: ' + path.join(directory, 'published', 'PcMcp.exe') + '\n',
);
