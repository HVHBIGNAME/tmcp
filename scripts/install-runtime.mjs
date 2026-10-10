import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'dotenv';

const exec = promisify(execFile);
const home = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.includes('--gui') && process.platform === 'win32' ? 'gui' : 'cli';
const filename = path.join(home, '.env');
const envText = await readFile(filename, 'utf8');
const env = parse(envText);
await mkdir(path.join(home, 'bin'), { recursive: true });

async function download(url, destination, digest) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(180000),
    headers: { 'User-Agent': 'TMCP-installer' },
  });
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${new URL(url).hostname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest && createHash('sha256').update(bytes).digest('hex') !== digest.replace(/^sha256:/, ''))
    throw new Error('Downloaded file checksum does not match.');
  await writeFile(destination, bytes);
}

let cloudflared = env.CLOUDFLARED_BIN || 'cloudflared';
try {
  await exec(cloudflared, ['--version'], { windowsHide: true, timeout: 5000 });
} catch {
  if (env.CLOUDFLARED_BIN)
    throw new Error('Configured CLOUDFLARED_BIN does not work. Check the existing .env path.');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const assetName =
    process.platform === 'win32'
      ? 'cloudflared-windows-amd64.exe'
      : process.platform === 'darwin'
        ? `cloudflared-darwin-${arch}.tgz`
        : `cloudflared-linux-${arch}`;
  const release = JSON.parse(
    await readFile(new URL('./cloudflared-release.json', import.meta.url), 'utf8'),
  );
  const asset = release.assets.find((item) => item.name === assetName);
  if (!/^sha256:[0-9a-f]{64}$/.test(asset?.digest ?? ''))
    throw new Error(
      `No verified Cloudflare download for ${assetName}. Install cloudflared manually and rerun.`,
    );
  const destination = path.join(home, 'bin', assetName);
  console.log(`Installing cloudflared ${release.tag_name} (${arch})…`);
  await download(asset.browser_download_url, destination, asset.digest);
  cloudflared = path.join(
    home,
    'bin',
    process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
  );
  if (process.platform === 'darwin') {
    await exec('tar', ['-xzf', destination, '-C', path.join(home, 'bin')]);
    await rm(destination);
  } else if (destination !== cloudflared) {
    const { rename } = await import('node:fs/promises');
    await rename(destination, cloudflared);
  }
  if (process.platform !== 'win32') await chmod(cloudflared, 0o755);
  await exec(cloudflared, ['--version'], { windowsHide: true, timeout: 10000 });
  const line = `CLOUDFLARED_BIN=${JSON.stringify(cloudflared.replaceAll('\\', '/'))}`;
  const text = /^CLOUDFLARED_BIN=/m.test(envText)
    ? envText.replace(/^CLOUDFLARED_BIN=.*$/m, line)
    : `${envText.trimEnd()}\n${line}\n`;
  await writeFile(filename, text, { mode: 0o600 });
}

if (mode === 'gui') {
  const detect =
    "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients','HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients'); $found=$false; foreach($p in $paths) { if(Test-Path $p) { foreach($key in Get-ChildItem $p) { $v=Get-ItemProperty $key.PSPath; if($v.name -like '*WebView2*' -and $v.pv -and $v.pv -ne '0.0.0.0') { $found=$true } } } }; $found";
  const result = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(detect, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
  if (!result.stdout.includes('True')) {
    const installer = path.join(home, 'bin', 'MicrosoftEdgeWebview2Setup.exe');
    console.log('Installing Microsoft Edge WebView2 Runtime…');
    await download('https://go.microsoft.com/fwlink/p/?LinkId=2124703', installer);
    const verify = `$s=Get-AuthenticodeSignature -LiteralPath '${installer.replaceAll("'", "''")}'; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*Microsoft Corporation*') { exit 1 }`;
    await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(verify, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
      },
    );
    await exec(installer, ['/silent', '/install'], { windowsHide: true, timeout: 180000 });
    await rm(installer);
  }
  await access(path.join(home, 'dist-ui', 'PcMcp.exe'));
}
await writeFile(
  path.join(home, '.mcp-tunnel', 'install.json'),
  JSON.stringify({ mode, installedAt: new Date().toISOString() }, null, 2),
);
console.log(`Runtime ready · ${mode.toUpperCase()}`);
