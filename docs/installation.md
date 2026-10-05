# Установка и обновление

## Windows

Установщик `install.ps1` принимает:

| Параметр               | Значение по умолчанию                                 |
| ---------------------- | ----------------------------------------------------- |
| `-Mode auto\|gui\|cli` | `auto`: GUI на desktop Windows, CLI на Windows Server |
| `-InstallDir PATH`     | `%LOCALAPPDATA%\TMCP`                                 |
| `-Root PATH`           | Домашняя папка пользователя                           |
| `-Version v1.1.0`      | Последний опубликованный релиз                        |
| `-NoStart`             | Не запускать сервер после установки                   |
| `-Autostart`           | Явно включить автозапуск                              |

```powershell
$install = [scriptblock]::Create((irm https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.ps1))
& $install -Mode cli -Root C:\work -NoStart
```

Установка не требует прав администратора для самого TMCP. Microsoft WebView2 устанавливается своим официальным подписанным установщиком, если runtime отсутствует. Release GUI содержит .NET Runtime; исходная сборка по умолчанию использует установленный .NET Desktop Runtime 8.

## Linux / macOS

Переменные окружения:

| Переменная         | Назначение                             |
| ------------------ | -------------------------------------- |
| `TMCP_HOME`        | Каталог приложения                     |
| `TMCP_ROOT`        | Рабочая папка MCP при первой установке |
| `TMCP_VERSION`     | Тег релиза, например `v1.1.0`          |
| `TMCP_NO_START=1`  | Установить без запуска                 |
| `TMCP_AUTOSTART=1` | Включить автозапуск явно               |

```sh
curl -fsSL https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.sh -o /tmp/tmcp-install.sh
TMCP_ROOT="$HOME/work" TMCP_NO_START=1 sh /tmp/tmcp-install.sh
```

`curl`, `tar` и утилита SHA-256 должны быть доступны. При необходимости установщик загружает Node.js 24 LTS в каталог приложения. На Alpine используйте совместимый Node.js из пакетного менеджера заранее. GUI предусмотрен для Windows; Unix-установка выбирает CLI.

Для переносимой установки без изменения PATH используйте `-NoPathUpdate` на Windows или `TMCP_NO_PATH=1` на Unix. Обёртка останется в каталоге `bin` внутри установки.

## Обновление

1. Завершите нужные команды, затем выполните `tmcp stop`.
2. На Windows завершите GUI через меню трея, чтобы освободить EXE.
3. Повторите установку в тот же каталог.

Архивы содержат только код приложения. Существующие `.env`, `.mcp-tunnel`, ключи и правила не включены в архив и не сбрасываются. При обновлении Quick Tunnel адрес изменится; named tunnel сохранит hostname.

## Удаление

```sh
tmcp autostart off
tmcp stop
```

Затем удалите каталог установки и команду-обёртку. Windows: при необходимости удалите `%LOCALAPPDATA%\TMCP\bin` из пользовательского PATH и ярлык из меню «Пуск». Unix: удалите `~/.local/bin/tmcp`. Сначала сохраните нужные локальные настройки и ключи.
