import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, isErrno } from './utils.js';

const exec = promisify(execFile);
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  kind: string;
  detail: string;
}

export interface AutostartControl {
  status(): Promise<AutostartStatus>;
  set(enabled: boolean): Promise<AutostartStatus>;
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const systemdArg = (value: string) =>
  `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;

export function startupDefinition(
  platform: string,
  project: string,
  node: string,
  dataDir: string,
) {
  const entry = path.posix.join(project, 'dist', 'src', 'daemon.js');
  if (platform === 'linux')
    return [
      '[Unit]',
      'Description=TMCP personal MCP tunnel',
      'After=network-online.target',
      'Wants=network-online.target',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${systemdArg(project)}`,
      `ExecStart=${systemdArg(node)} ${systemdArg(entry)} --autostart`,
      'Restart=on-failure',
      'RestartSec=5',
      'KillMode=mixed',
      'TimeoutStopSec=25',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  if (platform === 'darwin')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.tmcp.agent</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string><string>--autostart</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(path.posix.join(dataDir, 'autostart.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.posix.join(dataDir, 'autostart.log'))}</string>
</dict></plist>\n`;
  throw new Error('Unsupported startup platform');
}

export class Autostart implements AutostartControl {
  private cached?: { at: number; value: AutostartStatus };
  constructor(
    private readonly project: string,
    private readonly dataDir: string,
  ) {}

  private file(): string {
    return process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tmcp.agent.plist')
      : path.join(os.homedir(), '.config', 'systemd', 'user', 'tmcp.service');
  }

  async status(): Promise<AutostartStatus> {
    if (this.cached && Date.now() - this.cached.at < 10000) return this.cached.value;
    let supported = ['win32', 'linux', 'darwin'].includes(process.platform);
    let enabled = false;
    if (process.platform === 'win32') {
      try {
        const result = await exec('reg.exe', ['query', registryKey, '/v', 'TMCP'], {
          windowsHide: true,
          timeout: 5000,
        });
        enabled = /TMCP\s+REG_SZ/.test(result.stdout);
      } catch {
        enabled = false;
      }
    } else if (supported) {
      try {
        await access(this.file());
        enabled = true;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      if (process.platform === 'linux') {
        try {
          await exec('systemctl', ['--user', 'show-environment'], { timeout: 5000 });
        } catch {
          supported = false;
        }
        if (supported) {
          try {
            await exec('systemctl', ['--user', 'is-enabled', 'tmcp.service'], { timeout: 5000 });
            enabled = true;
          } catch {
            enabled = false;
          }
        }
      }
    }
    const value = {
      supported,
      enabled,
      kind:
        process.platform === 'win32'
          ? 'Windows Startup'
          : process.platform === 'darwin'
            ? 'launchd'
            : 'systemd --user',
      detail: supported
        ? 'Запуск при входе пользователя. На Linux запуск до входа требует loginctl enable-linger.'
        : 'Пользовательский менеджер автозапуска недоступен в этой среде.',
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async set(enabled: boolean): Promise<AutostartStatus> {
    const status = await this.status();
    if (!status.supported) throw new Error('Autostart is unavailable in this environment');
    if (enabled === status.enabled) return status;
    if (process.platform === 'win32') {
      if (enabled) {
        let gui = false;
        try {
          await access(path.join(this.project, 'dist-ui', 'PcMcp.exe'));
          let mode = 'auto';
          try {
            mode = JSON.parse(await readFile(path.join(this.dataDir, 'install.json'), 'utf8')).mode;
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) throw error;
          }
          gui = mode !== 'cli';
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
        let command = `"${path.join(this.project, 'dist-ui', 'PcMcp.exe')}" --background`;
        if (!gui) {
          const script = path.join(this.dataDir, 'autostart.vbs');
          const run = `"${process.execPath}" "${path.join(this.project, 'dist', 'src', 'daemon.js')}" --autostart`;
          await atomicWrite(
            script,
            `CreateObject("WScript.Shell").Run "${run.replaceAll('"', '""')}", 0, False\r\n`,
          );
          command = `wscript.exe "${script}"`;
        }
        await exec(
          'reg.exe',
          ['add', registryKey, '/v', 'TMCP', '/t', 'REG_SZ', '/d', command, '/f'],
          { windowsHide: true, timeout: 5000 },
        );
      } else
        await exec('reg.exe', ['delete', registryKey, '/v', 'TMCP', '/f'], {
          windowsHide: true,
          timeout: 5000,
        });
    } else {
      const file = this.file();
      if (enabled) {
        await mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(
          file,
          startupDefinition(process.platform, this.project, process.execPath, this.dataDir),
        );
        if (process.platform === 'linux') {
          await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 });
          await exec('systemctl', ['--user', 'enable', 'tmcp.service'], { timeout: 10000 });
        }
      } else {
        if (process.platform === 'linux')
          await exec('systemctl', ['--user', 'disable', 'tmcp.service'], { timeout: 10000 });
        await rm(file, { force: true });
        if (process.platform === 'linux')
          await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 });
      }
    }
    this.cached = undefined;
    return this.status();
  }
}
