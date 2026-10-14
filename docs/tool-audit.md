# Аудит инструментов TMCP 2.2.0

Проверка охватывает 20 native-инструментов, 10 gateway-инструментов и namespaced-публикацию. Успех теста относится к указанному сценарию, а не ко всем возможным shell-командам или действиям стороннего сервера.

## Подтверждённые результаты

Локально на Windows: **90 успешных core-тестов, 1 POSIX-only пропуск**, все 14 браузерных сценариев и 26 состояний axe без автоматически выявленных нарушений. В части select/диалогов axe оставляет задания ручной проверки (`incomplete`); это не сертификат доступности. TypeScript, Prettier, сборка backend и lifecycle прошли. Изолированный запуск занял 1032 мс, полный останов — 216 мс; это единичное измерение, не бенчмарк. `npm audit --omit=dev`: 0 известных уязвимостей.

Проверки native-контрактов используют официальный MCP SDK: настоящий HTTP initialize, tools/list, tools/call и проверку outputSchema клиентом. Gateway проверяется через настоящий дочерний stdio-сервер, Streamable HTTP и legacy SSE с авторизацией. [CI 38555960366](https://github.com/HVHBIGNAME/tmcp/actions/runs/38555960366) прошёл на Windows/Linux/macOS, включая POSIX-очистку потомков, browser job и обе .NET-проверки updater.

Локальная автономная сборка прошла headless smoke с настоящей shell-командой через bundled Node без глобального PATH, полный GUI smoke с реальным захватом через bundled worker, автозапуском/треем/сохранением ключей и полным выходом, а также install/rollback smoke. В GUI-тесте контрольный снимок файла ключей берётся после остановки: shutdown сохраняет отложенные lastUsedAt, поэтому сравнение со снимком до остановки давало ложный отказ.

## Матрица проверки

В колонке «Подтверждено» перечислены фактически выполненные сценарии. Файлы тестов находятся в `tests/`.

| Инструмент            | Подтверждено                                                                                                | Источник                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `system_info`         | Права ключа, live-настройки, совпадение available_tools с tools/list                                        | native-tools, tool-contracts                       |
| `list_directory`      | Глубина, страницы без повторов, схема результата                                                            | files, native-tools                                |
| `find_files`          | Glob, исключение node_modules, результат через SDK                                                          | files, native-tools                                |
| `search_text`         | Регистр, предел результатов, продолжение, поздний match в длинной строке                                    | files, native-tools                                |
| `file_info`           | Файл, каталог, ошибка отсутствующего пути                                                                   | files, native-tools                                |
| `read_file`           | UTF-8/BOM/CRLF, SHA-256, отказ binary, длинная emoji-строка без потерь                                      | files, native-tools                                |
| `read_image`          | PNG/JPEG, EXIF-поворот, resize без увеличения, отказ SVG, pixel/concurrency limits                          | native-tools, images                               |
| `write_file`          | Создание, отказ overwrite по умолчанию, конфликт SHA, лимит байтов                                          | files, native-tools                                |
| `edit_file`           | Несколько правок, неоднозначность, Unicode, отсутствие частичной записи при ошибке, concurrent SHA conflict | files, native-tools                                |
| `create_directory`    | Родители и повторный вызов                                                                                  | native-tools                                       |
| `move_path`           | Перемещение, занятая цель, защищённые пути                                                                  | files, native-tools, security                      |
| `delete_path`         | Явная рекурсивность, удаление ссылки без её цели, запрет roots/credentials                                  | files, native-tools, security, tool-contracts      |
| `run_command`         | Одобрение, отказ, отмена ожидающего approval, exit code, фоновое задание                                    | approvals, processes, native-tools, tool-contracts |
| `read_command`        | Курсоры stdout/stderr, bounded output, изоляция владельца                                                   | processes, native-tools                            |
| `list_commands`       | Только задания владельца                                                                                    | native-tools                                       |
| `write_command_input` | UTF-8/emoji, EOF, отказ закрытому stdin и чужому владельцу                                                  | native-tools                                       |
| `stop_command`        | Остановка, повторный вызов, Windows orphan cleanup, timeout                                                 | native-tools, processes, descendants               |
| `list_displays`       | Реальные два Windows-дисплея через SDK                                                                      | scripts/audit-desktop-tools.ts                     |
| `take_screenshot`     | Реальный PNG 640×360, неверный индекс отклонён                                                              | scripts/audit-desktop-tools.ts                     |
| `read_audit`          | Возврат записи о выполненной правке через SDK                                                               | native-tools                                       |
| `mcp_list_servers`    | Metadata, скрытие секретов discovery, список после reload                                                   | gateway, gateway-tools                             |
| `mcp_list_tools`      | Схемы, фильтр, cold-start handle, deadline подключения                                                      | gateway, gateway-tools, gateway-http               |
| `mcp_call_tool`       | Text/image/structuredContent/errors, polling, отсутствие повтора после разрыва                              | gateway, gateway-tools, gateway-http               |
| `mcp_read_call`       | Polling, изоляция, истечение 10-минутной истории                                                            | gateway, gateway-tools                             |
| `mcp_cancel_call`     | Отмена cold connect и активного tool/resource call, повторный cancel                                        | gateway-tools                                      |
| `mcp_reload_servers`  | Reload, удалённый backend больше не вызывается                                                              | gateway-tools                                      |
| `mcp_list_resources`  | Resources и URI templates                                                                                   | gateway-tools                                      |
| `mcp_read_resource`   | URI, текстовый результат, отмена медленного чтения                                                          | gateway-tools                                      |
| `mcp_list_prompts`    | Список prompt names                                                                                         | gateway-tools                                      |
| `mcp_get_prompt`      | Аргументы и сообщения                                                                                       | gateway-tools                                      |
| Namespaced tools      | Публикация схемы, реальный вызов, имена ≤64 символов                                                        | gateway, gateway-tools                             |

## Ограничения и использование ИИ

- Native-инструменты имеют outputSchema; неизвестные аргументы отклоняются. `isError: true` сопровождается текстом и `_meta["tmcp/error"]` с кодом, пояснением и следующим шагом. Metadata ошибки не нарушает success-схему SDK.
- `system_info` и tools/list показывают возможности текущего ключа. При отключении shell остаются read/list/stop уже запущенных заданий.
- `read_file`: по умолчанию 32000, максимум 64000 UTF-16 единиц на страницу вместе с номерами строк. Продолжение — **оба** `next_line`/`next_column`; surrogate pairs не разрезаются. Для правок сверяйте SHA, BOM и line endings.
- Directory/find/search: `next_offset` относится к неизменным фильтрам и дереву, не к snapshot. Предел обхода — 20000 записей; `scan_limit_reached` требует более узкого пути. Search — single-line literal, excerpt не заменяет полное чтение строки.
- Команды: максимум 8 одновременно; Windows command ≤6000 символов, более длинный код запускайте из файла. `wait_ms: 0` возвращает job_id. stdout/stderr имеют отдельные курсоры и ограниченный буфер; `*_truncated` означает потерю старого вывода, `*_more` — необходимость дочитать.
- stdin — pipe, не PTY. Передача ограничена 10 секундами; отмена или timeout не гарантируют, что уже отправленные байты не были получены процессом. Pending write нельзя без проверки состояния повторять.
- Обычные потомки принадлежат Windows Job Object или POSIX process group и завершаются с заданием. Для длительной работы запускайте сервис на переднем плане с `wait_ms: 0`, а не через shell `&`. Это управление временем жизни, не sandbox.
- Изображения: максимум 2 операции, 50 млн входных пикселей, файл до 16 MiB, выход PNG до 4 MiB. SVG/XML читаются как текст. Capture worker имеет deadline 20 секунд и ограниченный stdout; отмена завершает worker. Native sharp-transform в read_image проверяет отмену до/после обработки, но не прерывает её немедленно.
- Gateway: максимум 16 активных вызовов; готовая история до 100 записей/64 MiB/10 минут, отдельный результат ≤16 MiB. Если получен call_id, опрашивайте его вместо повторения операции. Отмена cooperative: уже совершённые внешние действия не откатываются.
- Namespaced-имена пересоздаются из актуального каталога; после обновления получите tools/list заново. При неподдерживаемой конвертации схемы используйте каталог `mcp_list_tools` и `mcp_call_tool` с исходным именем.
- HTTP disconnect и authenticated `notifications/cancelled` снимают ожидающий approval. Request ID привязан к владельцу; совпавшие активные ID общего ключа не отменяются массово. Завершённые файловые изменения не откатываются отменой.
- Config-файлы gateway дополнительно защищены от native read/write/delete. Shell и gateway исполняются с правами пользователя ОС; произвольные рабочие файлы вне private paths доступны согласно правам ключа.

## Внешние проверки и границы

Desktop-audit выполнил реальный захват и сохранил только metadata, без снимка. Проверки сторонних backend выполнялись только на каталогах: один прогон получил каталоги 9 из 10 настроенных серверов, последующие прогоны дали connection_pending у части из них. Это не подтверждает стабильность всех подключений или выполнение инструментов Blender/IDA/Roblox и других приложений.

Публичный MCP-домен отвечал Cloudflare 520/502 при работавшем local MCP. Live OAuth через него не прошёл; SSH-проверка из другой сети завершилась timeout. [Public probe 38558688204](https://github.com/HVHBIGNAME/tmcp/actions/runs/38558688204) из GitHub runner получил 502 на `/health`, OAuth metadata и `/mcp` при запущенном сервере. Cloudflared зарегистрировал четыре HTTP/2-соединения, но во время запросов сообщал об обрывах control stream (`context canceled` / `client disconnected`). Это подтверждает внешний сбой, но не устанавливает его первопричину. Сервер после временной проверки остановлен. Workflow `public-probe.yml` запускается вручную без ключей и требует работающего локального сервера/туннеля.

Пределы обхода 20000, всей gateway-памяти 64 MiB, stdin-backpressure timeout и часовой retention команд не подвергались отдельному длительному нагрузочному прогону. Не проверялись все форматы изображений, все backend-схемы, реальные ChatGPT/Notion user-flows и захват Linux/macOS desktop. UI и изолированные OAuth-тесты не заменяют эти проверки.

## Воспроизведение

```sh
npm run check
npm run format:check
npm test
npm run build
npm run test:lifecycle
npm run test:ui
npm run test:a11y
npm audit --omit=dev
npx tsx scripts/audit-desktop-tools.ts
```

Внешний аудит запускается отдельно: `TMCP_AUDIT_EXTERNAL=1 npx tsx scripts/audit-external-tools.ts` (в PowerShell переменная задаётся через `$env:TMCP_AUDIT_EXTERNAL='1'`). Нужен запущенный TMCP. Скрипт создаёт временный ограниченный ключ через IPC и удаляет его в finally; отчёты в private `.mcp-tunnel/tool-audit/`. Если процесс был аварийно прерван, `active-key.json` содержит только ID созданного ключа для удаления.

## Статический анализ

Aislop на 22 изменённых поддерживаемых файлах: **88/100, 0 errors, 7 warnings, 0 fixable**; lint/security без находок. Остаются нефункциональные замечания к размеру `http.ts`, `tools.ts`, `gateway.ts` и функций регистрации/приложения; их разделение требует отдельного рефакторинга. Два hardcoded-ID предупреждения относятся к строке события `token_usage_write_error`, не к credential/provider ID. Штатный JSON-вывод build-script переведён на stdout без console.log; правила анализатора не отключались. Подробности опубликованной сборки добавляются после её проверки.
