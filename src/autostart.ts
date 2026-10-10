import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, hash, isErrno, SerialQueue } from './utils.js';
import type { Config } from './config.js';
import { installDesktop, windowsArgument } from './desktop-install.js';

const exec = promisify(execFile);
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  kind: string;
  detail: string;
  executable?: string;
  registrationName?: string;
}

export interface AutostartControl {
  status(): Promise<AutostartStatus>;
  set(enabled: boolean): Promise<AutostartStatus>;
}

const xmlEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const xml = (value: string) => value.replace(/[&<>"']/g, (character) => xmlEntities[character]!);
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
  private readonly writes = new SerialQueue();
  constructor(
    private readonly project: string,
    private readonly dataDir: string,
    private readonly desktop?: { executable: string; home: string; headless?: boolean },
  ) {}

  private registrationName(): string {
    const home = this.desktop?.home;
    const standard = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'TMCP');
    return home && path.resolve(home).toLowerCase() !== path.resolve(standard).toLowerCase()
      ? `TMCP-${hash(path.resolve(home).toLowerCase()).slice(0, 12)}`
      : 'TMCP';
  }

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
        const result = await exec(
          'reg.exe',
          ['query', registryKey, '/v', this.registrationName()],
          {
            windowsHide: true,
            timeout: 5000,
          },
        );
        enabled = /REG_SZ/.test(result.stdout);
        if (this.desktop)
          enabled &&= result.stdout
            .toLowerCase()
            .includes(path.join(this.desktop.home, 'TMCP.exe').toLowerCase());
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
        ? this.desktop
          ? `При включении EXE устанавливается в ${this.desktop.home}. Запуск при входе пользователя.`
          : 'Запуск при входе пользователя. На Linux запуск до входа требует loginctl enable-linger.'
        : 'Пользовательский менеджер автозапуска недоступен в этой среде.',
      ...(this.desktop
        ? {
            executable: path.join(this.desktop.home, 'TMCP.exe'),
            registrationName: this.registrationName(),
          }
        : {}),
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  set(enabled: boolean): Promise<AutostartStatus> {
    return this.writes.run(() => this.apply(enabled));
  }

  private async apply(enabled: boolean): Promise<AutostartStatus> {
    this.cached = undefined;
    const status = await this.status();
    if (!status.supported) throw new Error('Autostart is unavailable in this environment');
    if (enabled === status.enabled && !(enabled && this.desktop)) return status;
    if (process.platform === 'win32') {
      if (enabled) {
        if (this.desktop) {
          const executable = await installDesktop(this.desktop.executable, this.desktop.home);
          this.desktop.executable = executable;
          const command = `${windowsArgument(executable)} --autostart${this.desktop.headless ? ' --headless' : ''} --home ${windowsArgument(this.desktop.home)}`;
          await exec(
            'reg.exe',
            [
              'add',
              registryKey,
              '/v',
              this.registrationName(),
              '/t',
              'REG_SZ',
              '/d',
              command,
              '/f',
            ],
            { windowsHide: true, timeout: 5000 },
          );
          this.cached = undefined;
          return this.status();
        }
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
          ['add', registryKey, '/v', this.registrationName(), '/t', 'REG_SZ', '/d', command, '/f'],
          { windowsHide: true, timeout: 5000 },
        );
      } else
        await exec('reg.exe', ['delete', registryKey, '/v', this.registrationName(), '/f'], {
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

export function autostartFor(config: Config): Autostart {
  return new Autostart(
    config.projectDir,
    config.dataDir,
    config.desktopExecutable
      ? {
          executable: config.desktopExecutable,
          home: path.dirname(config.envFile),
          headless: config.desktopMode === 'cli',
        }
      : undefined,
  );
}
