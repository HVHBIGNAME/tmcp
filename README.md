<p align="center">
  <img src="ui/public/logo.svg" width="88" height="88" alt="TMCP logo" />
</p>

<h1 align="center">TMCP</h1>
<p align="center"><strong>Ваш компьютер. Любой MCP-клиент.</strong></p>
<p align="center">Личный MCP-туннель с Windows-приложением и терминальной панелью для Linux, macOS и серверов.</p>

<p align="center">
  <a href="https://github.com/HVHBIGNAME/tmcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/HVHBIGNAME/tmcp/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/HVHBIGNAME/tmcp/releases"><img alt="Release" src="https://img.shields.io/github/v/release/HVHBIGNAME/tmcp?color=398b68" /></a>
  <img alt="Node.js 22.16+" src="https://img.shields.io/badge/Node.js-22.16%2B-398b68" />
  <img alt="Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-526b64" />
</p>

<p align="center">
  <a href="#установка-в-одну-команду">Установить</a> ·
  <a href="#терминальная-панель">CLI</a> ·
  <a href="#подключение-к-notion-и-другим-клиентам">Подключить клиент</a> ·
  <a href="#постоянный-адрес">Свой домен</a> ·
  <a href="docs/troubleshooting.md">Решение проблем</a>
</p>

![Панель подключения TMCP](docs/screenshots/connection.png)

## Что внутри

|                            |                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Внешняя ссылка**         | Cloudflare Tunnel без проброса портов. Ссылка появляется и обновляется автоматически.                            |
| **Приложение для Windows** | Тёмная и светлая темы, собственные иконки, диалоги и понятные ошибки. Закрытие окна оставляет сервер в трее.     |
| **Команда `tmcp`**         | Меню с выбором цифрами: сервер, ссылка, ключи, Telegram, подтверждения, журнал и автозапуск.                     |
| **Ключи доступа**          | Отдельные токены для интеграций, выбор разрешений, приостановка, замена и отзыв.                                 |
| **Файлы и команды**        | Чтение, поиск, правка файлов; фоновые команды с ID задачи, ограничением вывода и опросом результата.             |
| **MCP-шлюз**               | Обнаружение локальных конфигураций, stdio, Streamable HTTP и legacy SSE; подключение инструментов по запросу.    |
| **Telegram**               | Проверка бота, состояние сервера, подтверждение команд и удалённое управление из разрешённых чатов.              |
| **Восстановление**         | Туннель переподключается отдельно от команд. Фоновый наблюдатель запускает сервер после завершения его процесса. |

## Установка в одну команду

### Windows

Откройте **PowerShell**:

```powershell
irm https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.ps1 | iex
```

На обычной Windows устанавливается **GUI**, на Windows Server — **CLI**. Установщик проверяет Node.js и WebView2, загружает недостающие компоненты, создаёт пункт меню «Пуск» и команду `tmcp`. Выпуск GUI включает .NET Runtime.

Чтобы явно выбрать CLI:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.ps1))) -Mode cli
```

### Linux / macOS

```sh
curl -fsSL https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.sh | sh
```

Устанавливается терминальная версия. Если совместимого Node.js нет, установщик добавляет собственный Node.js 24 LTS. `cloudflared` также устанавливается автоматически. Архивы проверяются по SHA-256.

**По умолчанию:**

- Windows: `%LOCALAPPDATA%\TMCP`.
- Linux/macOS: `~/.local/share/tmcp`, команда в `~/.local/bin/tmcp`.
- Рабочая папка для MCP: домашняя папка пользователя. Для другой папки укажите `-Root` в PowerShell или `TMCP_ROOT` на Unix.
- Сервер запускается после установки. Автозапуск **не включается без вашего выбора**.
- Поддерживаемые пакеты: Windows x64; Linux и macOS x64/arm64. Linux-пакет Node.js требует glibc, либо уже установленный совместимый Node.js.

Откройте новый терминал и выполните:

```sh
tmcp
```

Для нестандартного каталога, фиксированной версии и установки без запуска см. [параметры установщика](docs/installation.md).

## Терминальная панель

```text
╭─ TMCP ──────────────────────────────────────╮
  1  Запустить          2  Состояние и ссылка
  3  Ключи доступа      4  Настроить туннель
  5  Telegram           6  Запросы на подтверждение
  7  Автозапуск         8  Журнал
  9  Остановить         0  Закрыть панель
╰────────────────────────────────────────────╯
Выбор:
```

Закрытие терминальной панели оставляет сервер работать в фоне. Для автоматизации есть обычные команды:

```sh
tmcp start
tmcp status --json
tmcp url
tmcp token create --name Notion --permissions files:read,files:write,shell,gateway
tmcp token list
tmcp token disable TOKEN_ID
tmcp token enable TOKEN_ID
tmcp token rotate TOKEN_ID
tmcp token delete TOKEN_ID --yes
tmcp logs
tmcp stop
```

Новый токен выводится **один раз**. В хранилище токенов сохраняется только его SHA-256. Пароли бота и Cloudflare в интерактивном меню вводятся без отображения.

## Подключение к Notion и другим клиентам

1. Получите **внешнюю HTTPS-ссылку** в приложении или через `tmcp url`.
2. Создайте токен в разделе **Доступ** или командой `tmcp token create`.
3. Добавьте **Custom MCP server / Streamable HTTP** в клиенте:

   ```text
   URL:           https://your-tunnel.trycloudflare.com/mcp
   Authorization: Bearer <ваш токен>
   ```

В Notion настройка находится в инструментах Custom Agent: **Tools & Access → Add connection → Custom MCP server**. Клиенты с поддержкой OAuth также могут пройти OAuth-подключение.

Адрес `http://127.0.0.1:18787/mcp` работает **только на этом компьютере**. Панель показывает его отдельно и не выдаёт за внешнюю ссылку.

![Управление доступом](docs/screenshots/access.png)

### Разрешения

| Разрешение    | Возможности                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `files:read`  | Чтение, поиск, список файлов и папок                                             |
| `files:write` | Создание, правка, перемещение и удаление                                         |
| `shell`       | Запуск, чтение, остановка команд и ввод в stdin                                  |
| `screen`      | Скриншоты и список дисплеев                                                      |
| `gateway`     | Инструменты подключённых MCP-серверов                                            |
| `log`         | `read_audit`: недавние события этого клиента; панель владельца видит все события |

![Диалог разрешений](docs/screenshots/permissions.png)

## Постоянный адрес

**Quick Tunnel — временный адрес.** Он меняется при пересоздании туннеля или перезапуске сервера. Автовосстановление не может закрепить имя `trycloudflare.com`: после его смены клиенту нужна новая ссылка.

Для постоянного подключения:

1. Создайте remotely-managed tunnel в **Cloudflare Zero Trust**.
2. Добавьте Public Hostname, например `mcp.example.com`, с сервисом `http://127.0.0.1:18787`.
3. В **Настройки → Внешнее подключение** выберите **Свой домен**, введите hostname и connector token.
4. Нажмите **Сохранить и применить**. В CLI это пункт **4**.

Теперь MCP-адрес — `https://mcp.example.com/mcp`. Домен остаётся прежним после перезапуска. Доступность всё ещё зависит от ПК, сети и Cloudflare.

## Автозапуск

В приложении: **Настройки → Автозапуск**. В терминале:

```sh
tmcp autostart on
tmcp autostart status
tmcp autostart off
```

| Платформа | Механизм                                                    |
| --------- | ----------------------------------------------------------- |
| Windows   | Автозапуск текущего пользователя, GUI свёрнут в трей        |
| Linux     | Пользовательский unit `tmcp.service` через `systemd --user` |
| macOS     | LaunchAgent `com.tmcp.agent`                                |

Это запуск **при входе пользователя**. На Linux-сервере для запуска до входа и работы после выхода можно отдельно включить lingering:

```sh
sudo loginctl enable-linger "$USER"
systemctl --user start tmcp.service
```

В контейнере без пользовательского systemd запускайте `node dist/src/daemon.js` через менеджер процессов контейнера.

## Telegram

Создайте бота через **@BotFather**, напишите ему `/start` и сохраните токен и числовые ID разрешённых чатов. Панель проверяет ответ Telegram; изменения применяются без перезапуска сервера.

Команды: `/status`, `/pending`, `/allow <id> [all]`, `/deny <id>`, `/servers`, `/token <name>`, `/on <id>`, `/off <id>`, `/tunnel`, `/help`.

Кнопки подтверждения привязаны к ID ожидающего запроса. Повторное или просроченное подтверждение не запускает команду ещё раз.

## Светлая тема

![Светлая тема](docs/screenshots/light.png)

Скриншоты созданы на изолированном демонстрационном сервере. Адрес `workstation.tmcp.example` — пример; настоящих токенов на снимках нет.

## Запуск из исходников

Нужны Node.js **22.16+** и `cloudflared`. Для сборки Windows GUI — .NET SDK **8**.

```sh
git clone https://github.com/HVHBIGNAME/tmcp.git
cd tmcp
npm ci
npm run build
node dist/src/cli.js setup --root /path/to/workspace
node dist/src/cli.js start
```

На Windows GUI:

```powershell
npm run build:ui
.\dist-ui\PcMcp.exe
```

### Проверки

```sh
npm run check
npm run format:check
npm test
npx playwright install chromium
npm run test:ui
```

Тесты используют отдельные временные настройки. Они не требуют запущенного пользовательского сервера, `UI_ADMIN` или настоящего Telegram-токена. CI запускает core-тесты на Windows, Linux и macOS, browser-тесты в Chromium и сборку WinForms.

## Как это устроено

```text
MCP-клиент ── HTTPS ── Cloudflare Tunnel ── 127.0.0.1:18787
                                             │
                                      MCP / OAuth / задачи
                                             │
                                      Файлы · Shell · MCP

Desktop / tmcp CLI ── 127.0.0.1:18790 ── локальное управление
                            │
                   настройки · ключи · подтверждения
```

Файловые инструменты ограничены `MCP_ROOTS`. Shell-команды исполняются с правами пользователя ОС и не являются песочницей. Внешний MCP и локальное управление используют разные порты и ключи.

Настройки находятся в `.env` и `.mcp-tunnel/settings.json`. Эти файлы, журналы, пользовательские токены и данные браузера исключены из Git и release-архивов.

**Нужна помощь?** [Диагностика и частые вопросы](docs/troubleshooting.md) · [Создать issue](https://github.com/HVHBIGNAME/tmcp/issues/new)
