#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  configAt,
  control,
  initialize,
  serviceStatus,
  startService,
  stopService,
} from './service-control.js';
import { Autostart } from './autostart.js';
import { errorMessage } from './utils.js';
import { permissions as allPermissions } from './permissions.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    root: { type: 'string' },
    port: { type: 'string' },
    mode: { type: 'string' },
    name: { type: 'string' },
    permissions: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    'no-wait': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  },
});
const project = path.resolve(values.home ?? fileURLToPath(new URL('../../', import.meta.url)));
const command = positionals[0] ?? (process.stdin.isTTY ? 'panel' : 'help');
const color = (code: number, text: string) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const print = (data: unknown) =>
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));

function help() {
  console.log(`TMCP — личный MCP-туннель\n
  tmcp                         меню управления (цифры + Enter)
  tmcp setup [--root PATH]      первоначальная настройка
  tmcp start [--mode quick]     запустить сервер в фоне
  tmcp stop                    остановить сервер и туннель
  tmcp restart                 перезапустить сервер
  tmcp status [--json]          состояние и внешний адрес
  tmcp url                     ссылка для MCP-клиента
  tmcp token list              список ключей без секретов
  tmcp token create --name NAME --permissions files:read,shell
  tmcp token rotate ID          заменить ключ (старый отключится)
  tmcp token enable|disable ID  включить или приостановить доступ
  tmcp token delete ID --yes    удалить ключ
  tmcp autostart on|off|status  автозапуск при входе пользователя
  tmcp logs                    последние строки журнала сервера
  tmcp ui                      открыть Windows-приложение

  --home PATH                  каталог установки (по умолчанию рядом с tmcp)
  --json                       JSON для скриптов

Секреты хранятся локально. При создании ключ показывается только один раз.
Быстрый туннель меняет адрес при пересоздании; свой домен сохраняет его.
`);
}

async function requireServer() {
  const config = configAt(project);
  if (!(await serviceStatus(config))) await startService(config);
  return config;
}

async function showStatus() {
  const config = configAt(project);
  const status = await serviceStatus(config);
  if (values.json) {
    print(status ?? { running: false });
    return;
  }
  if (!status) {
    print(color(33, 'Сервер остановлен. Запуск: tmcp start'));
    return;
  }
  print(color(32, `Сервер работает · PID ${status.pid}`));
  print(`Туннель: ${status.connectionStatus ?? (status.ready ? 'connected' : 'starting')}`);
  if (status.ready && String(status.publicUrl).startsWith('https://'))
    print(color(36, String(status.mcpUrl)));
  else print('Внешняя ссылка появится после подключения. Повторите tmcp url.');
  print(`Локально: ${config.localUrl}/mcp`);
}

async function tokenCommand(action: string, id?: string) {
  const config = await requireServer();
  if (action === 'list') {
    const state = await control(config, '/state');
    if (values.json) print(state.tokens);
    else
      for (const record of state.tokens)
        print(
          `${record.id}  ${record.enabled ? '●' : '○'} ${record.name}  [${record.permissions.join(', ')}]`,
        );
    return;
  }
  if (action === 'create') {
    if (!values.name) throw new Error('Укажите --name и --permissions.');
    const permissions = (values.permissions ?? 'files:read')
      .split(',')
      .map((value) => value.trim());
    print(await control(config, '/tokens', 'POST', { name: values.name, permissions }));
    return;
  }
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Укажите ID из tmcp token list.');
  if (action === 'delete') {
    if (!values.yes)
      throw new Error('Удаление необратимо. Подтвердите: tmcp token delete ID --yes');
    await control(config, `/tokens/${id}`, 'DELETE');
    print('Токен удалён.');
  } else if (action === 'rotate') print(await control(config, `/tokens/${id}/rotate`, 'POST'));
  else if (action === 'enable' || action === 'disable')
    print(await control(config, `/tokens/${id}`, 'PATCH', { enabled: action === 'enable' }));
  else throw new Error('Используйте token list|create|rotate|enable|disable|delete.');
}

async function showLogs() {
  const config = configAt(project);
  const file = await open(path.join(config.dataDir, 'server.log'), 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 65536);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    print(buffer.toString('utf8').split('\n').slice(-60).join('\n'));
  } finally {
    await file.close();
  }
}

async function panel() {
  if (!process.stdin.isTTY) {
    help();
    return;
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt: string, secret = false) => {
    if (!secret) return (await rl.question(prompt)).trim();
    process.stdout.write(prompt);
    muted = true;
    try {
      return (await rl.question('')).trim();
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };
  const api = async (route: string, method = 'GET', body?: unknown) =>
    control(await requireServer(), route, method, body);
  try {
    while (true) {
      console.log(`\n${color(36, '╭─ TMCP ──────────────────────────────────────╮')}`);
      console.log(
        '  1  Запустить          2  Состояние и ссылка\n  3  Ключи доступа      4  Настроить туннель\n  5  Telegram           6  Запросы на подтверждение\n  7  Автозапуск         8  Журнал\n  9  Остановить         0  Закрыть панель',
      );
      console.log(color(36, '╰────────────────────────────────────────────╯'));
      const choice = await ask('Выбор: ');
      try {
        if (choice === '0') break;
        if (choice === '1') {
          await startService(configAt(project));
          await showStatus();
        } else if (choice === '2') await showStatus();
        else if (choice === '8') await showLogs();
        else if (choice === '9') {
          if ((await ask('Остановить сервер и активные команды? [y/N]: ')).toLowerCase() === 'y') {
            await stopService(configAt(project));
            print('Сервер остановлен.');
          }
        } else if (choice === '3') {
          const state = await api('/state');
          for (const [index, record] of state.tokens.entries())
            print(
              `${index + 1}. ${record.name} · ${record.enabled ? 'активен' : 'пауза'} · ${record.permissions.join(', ')}`,
            );
          const selected = await ask('n — новый ключ, номер — управление, Enter — назад: ');
          if (selected === 'n') {
            const name = await ask('Имя интеграции: ');
            for (const [index, permission] of allPermissions.entries())
              print(`${index + 1}. ${permission}`);
            const picks = await ask('Разрешения через запятую (например 1,2,3): ');
            const permissions = picks
              .split(',')
              .map((n) => allPermissions[Number(n.trim()) - 1])
              .filter(Boolean);
            const issued = await api('/tokens', 'POST', { name, permissions });
            print(`Сохраните ключ сейчас: ${issued.token}`);
          } else if (selected) {
            const record = state.tokens[Number(selected) - 1];
            if (!record) throw new Error('Неверный номер.');
            const operation = await ask('1 — включить/пауза, 2 — заменить, 3 — удалить: ');
            if (operation === '1')
              await api(`/tokens/${record.id}`, 'PATCH', { enabled: !record.enabled });
            else if (
              operation === '2' &&
              (await ask('Старый ключ отключится. Продолжить? [y/N]: ')) === 'y'
            )
              print(`Новый ключ: ${(await api(`/tokens/${record.id}/rotate`, 'POST')).token}`);
            else if (operation === '3' && (await ask(`Удалить ${record.name}? [y/N]: `)) === 'y')
              await api(`/tokens/${record.id}`, 'DELETE');
          }
        } else if (choice === '4') {
          const mode = await ask('1 — быстрый туннель, 2 — постоянный домен: ');
          if (!['1', '2'].includes(mode)) continue;
          const tunnel: { mode: string; hostname?: string; tunnelToken?: string } = {
            mode: mode === '1' ? 'quick' : 'named',
          };
          if (mode === '2') {
            tunnel.hostname = await ask('Домен: ');
            tunnel.tunnelToken = await ask('Connector token (пусто — сохранить): ', true);
          }
          if ((await ask('Переподключить туннель? Быстрая ссылка изменится. [y/N]: ')) !== 'y')
            continue;
          await api('/settings', 'PATCH', { tunnel });
          print(
            `Подключён: ${(await api('/tunnel/restart', 'POST', { mode: tunnel.mode })).url}/mcp`,
          );
        } else if (choice === '5') {
          const botToken = await ask('Токен бота (пусто — сохранить): ', true);
          const allowedChats = (await ask('ID чатов через запятую: '))
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
          await api('/settings', 'PATCH', { telegram: { token: botToken, allowedChats } });
          print(await api('/telegram/check', 'POST'));
        } else if (choice === '6') {
          const state = await api('/state');
          if (!state.approvals.length) {
            print('Ожидающих запросов нет.');
            continue;
          }
          for (const [index, record] of state.approvals.entries())
            print(`${index + 1}. ${record.summary}\n   ${record.cwd}`);
          const record = state.approvals[Number(await ask('Номер запроса: ')) - 1];
          if (!record) continue;
          const decision = await ask('1 — разрешить, 2 — разрешить и запомнить, 3 — отклонить: ');
          if (['1', '2', '3'].includes(decision))
            await api(`/approvals/${record.id}/${decision === '3' ? 'deny' : 'allow'}`, 'POST', {
              remember: decision === '2',
            });
        } else if (choice === '7') {
          const config = configAt(project);
          const startup = new Autostart(project, config.dataDir);
          const status = await startup.status();
          print(`Автозапуск: ${status.enabled ? 'включён' : 'выключен'}. ${status.detail}`);
          const answer = await ask('1 — включить, 2 — выключить, Enter — назад: ');
          if (answer === '1' || answer === '2') print(await startup.set(answer === '1'));
        }
      } catch (error) {
        print(color(31, errorMessage(error)));
      }
    }
  } finally {
    rl.close();
  }
}

try {
  if (values.help || command === 'help') help();
  else {
    if (command === 'setup' || command === 'start' || command === 'panel') {
      const port = Number(values.port ?? '18787');
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('Port must be between 1024 and 65535');
      await initialize(project, values.root, port);
    }
    const config = configAt(project);
    if (command === 'setup') print('Готово. Настройки сохранены. Запуск: tmcp start');
    else if (command === 'panel') await panel();
    else if (command === 'start') {
      if (values.mode && !['quick', 'named'].includes(values.mode))
        throw new Error('Mode must be quick or named');
      if (values.mode) {
        if (await serviceStatus(config)) {
          await control(config, '/settings', 'PATCH', { tunnel: { mode: values.mode } });
          await control(config, '/tunnel/restart', 'POST', { mode: values.mode });
        } else {
          const { SettingsStore, settingsPath } = await import('./settings.js');
          const settings = new SettingsStore(settingsPath(config.dataDir));
          await settings.load();
          await settings.update({ tunnel: { mode: values.mode } });
        }
      }
      await startService(config, !values['no-wait']);
      if (!values['no-wait']) await showStatus();
    } else if (command === 'stop') {
      await stopService(config);
      print('Сервер остановлен.');
    } else if (command === 'restart') {
      await stopService(config);
      await startService(config);
      await showStatus();
    } else if (command === 'status') await showStatus();
    else if (command === 'url') {
      const status = await serviceStatus(config);
      if (!status?.ready || !String(status.publicUrl).startsWith('https://'))
        throw new Error('Внешний адрес ещё не готов. Проверьте tmcp status.');
      print(status.mcpUrl);
    } else if (command === 'token') await tokenCommand(positionals[1] ?? 'list', positionals[2]);
    else if (command === 'autostart') {
      const startup = new Autostart(project, config.dataDir);
      const action = positionals[1] ?? 'status';
      if (!['on', 'off', 'status'].includes(action)) throw new Error('Use autostart on|off|status');
      print(action === 'status' ? await startup.status() : await startup.set(action === 'on'));
    } else if (command === 'logs') await showLogs();
    else if (command === 'ui') {
      if (process.platform !== 'win32')
        throw new Error('Desktop GUI is available on Windows. Run tmcp for the terminal panel.');
      const child = spawn(path.join(project, 'dist-ui', 'PcMcp.exe'), [], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (error) => {
        console.error(errorMessage(error));
        process.exitCode = 1;
      });
      child.unref();
    } else throw new Error('Unknown command. Run tmcp --help');
  }
} catch (error) {
  console.error(color(31, errorMessage(error)));
  process.exitCode = 1;
}
