import { ActivityStream, ControlClient, StatePoller } from './api.js';
import { TrafficPanel } from './traffic.js';
import { icon } from './icons.js';
import {
  el,
  button,
  badge,
  panel,
  emptyState,
  field,
  input,
  select,
  toggle,
  formPanel,
  modal,
  copy,
  toast,
  secretModal,
  dateTime,
  relativeTime,
  setDisabled,
} from './components.js';

const pages = {
  overview: ['Подключение', 'Адрес сервера и поток запросов', 'connection'],
  tokens: ['Доступ', 'Токены и разрешения для ваших интеграций', 'key'],
  approvals: ['Запросы', 'Подтверждения и правила запуска команд', 'requests'],
  servers: ['MCP-серверы', 'Локальные инструменты, доступные через туннель', 'servers'],
  telegram: ['Telegram', 'Управление компьютером из вашего чата', 'telegram'],
  logs: ['Журнал', 'Последние действия подключённых клиентов', 'log'],
  settings: ['Настройки', 'Подключение, возможности и оформление', 'settings'],
};

const permissions = {
  'files:read': ['Чтение файлов', 'Просмотр файлов и папок', 'file'],
  'files:write': ['Изменение файлов', 'Создание, правка и удаление', 'edit'],
  shell: ['Команды', 'Запуск команд на компьютере', 'terminal'],
  screen: ['Скриншоты', 'Захват экрана и список дисплеев', 'camera'],
  gateway: ['MCP-серверы', 'Вызовы подключённых инструментов', 'servers'],
  log: ['Журнал', 'Доступ к журналу действий', 'log'],
};

const connectionLabels = {
  connected: ['Туннель зарегистрирован', 'neutral'],
  starting: ['Подключаем туннель', 'warning'],
  reconnecting: ['Восстанавливаем туннель', 'warning'],
  error: ['Нужна проверка настроек', 'error'],
  local: ['Только локальный доступ', 'neutral'],
};
const outcomeLabels = {
  executed: 'Выполнено',
  allowed: 'Разрешено',
  denied: 'Отклонено',
  failed: 'Ошибка',
};

export function createControlApp() {
  const client = new ControlClient();
  const state = { data: null, online: false, view: 'overview', logAuto: true, lastUrl: null };
  const root = document.getElementById('root');
  let currentPage;
  let lastUpdate = null;
  let disposed = false;
  const ui = buildShell();
  const poller = new StatePoller(client, update, disconnected);
  const trafficRecords = new Map();
  const stream = new ActivityStream(client, receiveTraffic, (connected) => {
    state.streamConnected = connected;
    currentPage?.streamConnected?.(connected);
  });

  function receiveTraffic(event) {
    if (disposed || !event || !Number.isSafeInteger(event.sequence)) return;
    if (state.traffic?.instanceId !== event.instanceId) trafficRecords.clear();
    else if (event.sequence <= state.traffic.sequence) return;
    if (event.type === 'snapshot') {
      trafficRecords.clear();
      for (const record of event.records ?? []) trafficRecords.set(record.id, record);
    } else if (event.record) trafficRecords.set(event.record.id, event.record);
    const records = [...trafficRecords.values()].sort((a, b) => b.order - a.order);
    for (const record of records.slice(150)) trafficRecords.delete(record.id);
    state.traffic = { ...event, records: records.slice(0, 150) };
    currentPage?.trafficUpdate?.(state.traffic, event.type === 'update');
  }

  function buildShell() {
    const navButtons = {};
    const count = el('span', { className: 'nav-count', hidden: true });
    const nav = el('nav', { className: 'navigation', 'aria-label': 'Разделы приложения' });
    for (const [key, [label, , glyph]] of Object.entries(pages)) {
      const item = button(
        label,
        glyph,
        () => navigate(key),
        `nav-button ${key === 'overview' ? 'active' : ''}`,
      );
      item.setAttribute('data-view', key);
      item.setAttribute('aria-label', label);
      item.title = label;
      if (key === 'overview') item.setAttribute('aria-current', 'page');
      if (key === 'approvals') item.append(count);
      if (key === 'settings') item.classList.add('nav-settings');
      navButtons[key] = item;
      nav.append(item);
    }
    const localStatus = el('div', { className: 'sidebar-status' });
    const title = el('h1', { textContent: pages.overview[0] });
    const subtitle = el('p', { className: 'page-description', textContent: pages.overview[1] });
    const serverStatus = el('div', { className: 'header-status', role: 'status' });
    const refreshButton = button('Обновить', 'refresh', () => poller.refresh(), 'icon-only');
    refreshButton.title = 'Обновить состояние';
    refreshButton.setAttribute('aria-label', 'Обновить состояние');
    const banner = el('div', { className: 'connection-banner', role: 'status', hidden: true });
    const view = el('div', { className: 'page-content', id: 'page-content' });
    const footer = el('footer', { className: 'footer' }, [
      el('span', { textContent: 'PC MCP' }),
      el('span', { className: 'footer-note', textContent: 'Подключение к локальному серверу…' }),
    ]);
    root.replaceChildren(
      el('div', { className: 'app-shell' }, [
        el('aside', { className: 'sidebar' }, [
          el('div', { className: 'brand' }, [
            el('img', { src: './logo.svg', alt: '', width: 38, height: 38 }),
            el('div', {}, [
              el('strong', { textContent: 'PC MCP' }),
              el('span', { textContent: 'Рабочая станция' }),
            ]),
          ]),
          nav,
          el('div', { className: 'sidebar-bottom' }, [
            localStatus,
            el('p', {
              className: 'tray-hint',
              textContent: 'Закройте окно — сервер продолжит работу в трее.',
            }),
          ]),
        ]),
        el('main', { className: 'workspace' }, [
          el('header', { className: 'page-header' }, [
            el('div', {}, [title, subtitle]),
            el('div', { className: 'header-actions' }, [serverStatus, refreshButton]),
          ]),
          banner,
          view,
          footer,
        ]),
      ]),
    );
    view.append(
      el('div', { className: 'loading-state', role: 'status' }, [
        el('img', { src: './logo.svg', alt: '', width: 60, height: 60 }),
        el('h2', { textContent: 'Подключаем ваш компьютер' }),
        el('p', {
          textContent: 'Состояние появится автоматически, как только сервер будет готов.',
        }),
        el('div', { className: 'loading-track' }),
      ]),
    );
    return { navButtons, count, localStatus, title, subtitle, serverStatus, banner, view, footer };
  }

  function navigate(view, confirmed = false) {
    if (state.view === view) return;
    if (!confirmed && ui.view.querySelector('[data-dirty="true"]')) {
      modal({
        title: 'Оставить изменения?',
        glyph: 'edit',
        description: 'В этой форме есть несохранённые изменения. При переходе они будут сброшены.',
        submitLabel: 'Перейти без сохранения',
        onSubmit: () => () => navigate(view, true),
      });
      return;
    }
    state.view = view;
    currentPage?.dispose?.();
    currentPage = null;
    for (const [key, node] of Object.entries(ui.navButtons)) {
      node.classList.toggle('active', key === view);
      if (key === view) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    ui.title.textContent = pages[view][0];
    ui.subtitle.textContent = pages[view][1];
    if (state.data) mountPage();
  }

  function mountPage() {
    const factories = {
      overview,
      tokensPage,
      approvalsPage,
      serversPage,
      telegramPage,
      logsPage,
      settingsPage,
    };
    const names = {
      tokens: 'tokensPage',
      approvals: 'approvalsPage',
      servers: 'serversPage',
      telegram: 'telegramPage',
      logs: 'logsPage',
      settings: 'settingsPage',
    };
    currentPage = factories[names[state.view] ?? state.view](state.data);
    ui.view.replaceChildren(currentPage.node);
    ui.view.scrollTop = 0;
    currentPage.update?.(state.data);
  }

  function update(data) {
    if (disposed) return;
    state.data = data;
    receiveTraffic(data.traffic);
    if (!document.hidden) stream.start();
    state.online = true;
    lastUpdate = new Date();
    ui.banner.hidden = true;
    ui.localStatus.replaceChildren(badge('Компьютер на связи', 'success'));
    ui.serverStatus.replaceChildren(badge('Сервер работает', 'success'));
    ui.count.hidden = !data.approvals.length;
    ui.count.textContent = String(data.approvals.length);
    document.documentElement.dataset.theme = data.settings.ui.theme;
    window.chrome?.webview?.postMessage({ type: 'theme', theme: data.settings.ui.theme });
    ui.footer.lastElementChild.textContent = `Обновлено в ${lastUpdate.toLocaleTimeString('ru-RU')} · ${data.connection?.mode === 'named' ? 'Постоянный адрес' : 'Cloudflare Tunnel'}`;
    const url = data.connection?.mcpUrl;
    if (url && state.lastUrl && url !== state.lastUrl)
      toast('Внешний адрес изменился. Скопируйте новую ссылку для интеграции.', 'warning');
    if (url) state.lastUrl = url;
    if (!currentPage) mountPage();
    else currentPage.update?.(data);
  }

  function disconnected(error) {
    if (disposed) return;
    state.online = false;
    ui.localStatus.replaceChildren(badge('Подключаемся заново', 'warning'));
    ui.serverStatus.replaceChildren(badge('Нет связи', 'warning'));
    ui.banner.hidden = false;
    ui.banner.replaceChildren(
      icon('refresh'),
      el('div', {}, [
        el('strong', { textContent: 'Восстанавливаем связь с сервером' }),
        el('p', { textContent: error.message }),
      ]),
    );
    ui.footer.lastElementChild.textContent = lastUpdate
      ? `Последний ответ: ${lastUpdate.toLocaleTimeString('ru-RU')}`
      : 'Ожидаем запуск сервера';
    currentPage?.connectionLost?.();
    if (!state.data && !window.chrome?.webview)
      ui.view.replaceChildren(
        emptyState(
          'connection',
          'Откройте приложение PC MCP',
          'Панель управляет сервером через защищённый локальный канал. Запустите PcMcp.exe; на Linux и macOS используйте tmcp.',
        ),
      );
  }

  async function mutate(path, method, body, timeout) {
    const result = await client.call(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeout ? { timeout } : {}),
    });
    void poller.refresh();
    return result;
  }

  async function save(patch) {
    const settings = await client.call('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    state.data.settings = settings;
    document.documentElement.dataset.theme = settings.ui.theme;
    window.chrome?.webview?.postMessage({ type: 'theme', theme: settings.ui.theme });
    toast('Настройки сохранены');
    void poller.refresh();
  }

  function restartServer() {
    const active = state.data.jobs.filter((job) => job.status === 'running').length;
    modal({
      title: 'Перезапустить сервер?',
      glyph: 'refresh',
      description: `${active ? `Выполняется команд: ${active}. Они будут остановлены. ` : ''}Подключение прервётся ненадолго.${state.data.connection?.mode === 'quick' ? ' Временный внешний адрес изменится.' : ''}`,
      submitLabel: 'Перезапустить',
      onSubmit: async () => {
        await client.call('/server/restart', { method: 'POST' });
        disconnected(new Error('Сервер перезапускается. Подключение восстановится автоматически.'));
      },
    });
  }

  function restartTunnel() {
    modal({
      title: 'Переподключить туннель?',
      glyph: 'cloud',
      description:
        'Текущие команды продолжат работу на компьютере. Временный адрес Cloudflare после переподключения изменится.',
      submitLabel: 'Переподключить',
      onSubmit: async () => {
        await mutate('/tunnel/restart', 'POST', {}, 105000);
        toast('Туннель подключён');
      },
    });
  }

  function overview() {
    const flow = new TrafficPanel();
    const endpoint = input('', {
      readOnly: true,
      className: 'endpoint-input',
      'aria-label': 'Внешний адрес MCP',
      placeholder: 'Ожидаем внешний адрес…',
    });
    const connectionBadge = el('div');
    const title = el('h2', { className: 'hero-title' });
    const description = el('p', { className: 'hero-description' });
    const copyButton = button(
      'Копировать ссылку',
      'copy',
      () => copy(state.data.connection.mcpUrl),
      'primary',
    );
    copyButton.disabled = true;
    const checkResult = el('div', { className: 'check-result', role: 'status', hidden: true });
    let lastCheck = null;
    const checkButton = button('Проверить доступность', 'bolt', async () => {
      const url = state.data.connection.mcpUrl;
      const result = await client.call('/connection/check', { method: 'POST', timeout: 15000 });
      if (state.data.connection.mcpUrl !== url) return;
      lastCheck = { ...result, url };
      renderConnection(state.data.connection);
    });
    const mode = el('span', { className: 'eyebrow' });
    const local = el('code', { className: 'local-endpoint' });
    const metrics = el('div', { className: 'metrics' });
    const activity = el('div', { className: 'activity-list' });
    const pending = el('div');
    const node = el('div', { className: 'page-stack' }, [
      el('section', { className: 'connection-hero connection-compact' }, [
        el('div', { className: 'hero-top' }, [mode, connectionBadge]),
        el('div', { className: 'hero-body' }, [el('div', {}, [title, description])]),
        el('div', { className: 'endpoint-box' }, [
          el('div', { className: 'endpoint-label' }, [
            icon('link'),
            el('span', { textContent: 'Адрес MCP для ваших интеграций' }),
          ]),
          el('div', { className: 'endpoint-copy' }, [endpoint, copyButton]),
        ]),
        el('div', { className: 'hero-bottom' }, [
          el('div', { className: 'local-row' }, [
            icon('monitor'),
            el('span', { textContent: 'На этом ПК:' }),
            local,
          ]),
          checkButton,
        ]),
        checkResult,
      ]),
      metrics,
      pending,
      flow.node,
      el('div', { className: 'overview-grid' }, [
        panel(
          'Последние действия',
          'Что выполняли подключённые клиенты',
          activity,
          button('Весь журнал', 'arrow', () => navigate('logs'), 'text-button'),
        ),
        panel(
          'Подключить интеграцию',
          'Три шага до первого запроса',
          el('ol', { className: 'steps' }, [
            el('li', {}, [
              el('span', { className: 'step-number', textContent: '1' }),
              el('div', {}, [
                el('strong', { textContent: 'Скопируйте внешнюю ссылку' }),
                el('p', { textContent: 'Добавьте её как Custom MCP server.' }),
              ]),
            ]),
            el('li', {}, [
              el('span', { className: 'step-number', textContent: '2' }),
              el('div', {}, [
                el('strong', { textContent: 'Укажите токен доступа' }),
                el('p', { textContent: 'Заголовок Authorization: Bearer <токен> или OAuth.' }),
              ]),
            ]),
            el('li', {}, [
              el('span', { className: 'step-number', textContent: '3' }),
              el('div', {}, [
                el('strong', { textContent: 'Оставьте приложение в трее' }),
                el('p', { textContent: 'Компьютер должен оставаться включённым.' }),
              ]),
            ]),
          ]),
          button('Доступ', 'key', () => navigate('tokens'), 'text-button'),
        ),
      ]),
    ]);
    let activityKey = '';
    let metricsKey = '';
    let pendingCount = -1;
    function renderConnection(c) {
      if (!c?.mcpUrl || lastCheck?.url !== c.mcpUrl) lastCheck = null;
      const [label, tone] = connectionLabels[c?.status] ?? connectionLabels.starting;
      connectionBadge.replaceChildren(
        badge(
          lastCheck ? (lastCheck.ok ? 'Проверка пройдена' : 'Проверка не пройдена') : label,
          lastCheck ? (lastCheck.ok ? 'success' : 'warning') : tone,
        ),
      );
      mode.textContent =
        c?.mode === 'named' ? 'Постоянный адрес Cloudflare' : 'Временный адрес Cloudflare';
      title.textContent = c?.mcpUrl
        ? lastCheck
          ? lastCheck.ok
            ? 'Внешний адрес проверен'
            : 'Внешний адрес не отвечает'
          : 'Туннель зарегистрирован'
        : c?.status === 'local'
          ? 'Включите внешний туннель'
          : 'Готовим внешнее подключение';
      description.textContent = c?.mcpUrl
        ? lastCheck
          ? 'Результат последней проверки. При проблемах с подключением проверьте адрес повторно.'
          : 'Адрес получен. Нажмите «Проверить доступность», чтобы проверить ответ через интернет.'
        : c?.lastError
          ? 'Туннель восстанавливается. Детали и параметры доступны в настройках.'
          : 'Адрес появится здесь автоматически. Локальный сервер уже работает.';
      checkResult.hidden = !lastCheck;
      if (lastCheck) {
        checkResult.className = `check-result ${lastCheck.ok ? 'success-tone' : 'warning-tone'}`;
        checkResult.textContent =
          lastCheck.message + (lastCheck.ok ? ` ${lastCheck.latencyMs} мс.` : '');
      }
      if (endpoint.value !== (c?.mcpUrl ?? '')) endpoint.value = c?.mcpUrl ?? '';
      setDisabled(copyButton, !c?.mcpUrl || !state.online);
      setDisabled(checkButton, !c?.mcpUrl || !state.online);
      local.textContent = `${c?.localUrl ?? ''}/mcp`;
    }
    return {
      node,
      dispose: () => flow.dispose(),
      trafficUpdate: (data, animate) => flow.update(data, animate),
      streamConnected: (connected) => flow.setConnected(connected),
      connectionLost: () => {
        setDisabled(copyButton, true);
        setDisabled(checkButton, true);
        flow.setConnected(false);
      },
      update(data) {
        flow.setTokens(data.tokens);
        flow.update(state.traffic);
        flow.setConnected(Boolean(state.streamConnected));
        renderConnection(data.connection);
        const nextMetrics = JSON.stringify([
          data.tokens,
          data.gateway.servers,
          data.telegram,
          data.jobs,
        ]);
        if (nextMetrics !== metricsKey) {
          metricsKey = nextMetrics;
          const connected = data.gateway.servers.filter(
            (server) => server.status === 'connected',
          ).length;
          metrics.replaceChildren(
            ...[
              [
                'key',
                String(data.tokens.filter((token) => token.enabled).length),
                'Активных токенов',
                'tokens',
              ],
              [
                'servers',
                `${connected} / ${data.gateway.servers.length}`,
                'MCP-серверы',
                'servers',
              ],
              [
                'telegram',
                data.telegram.ok ? 'Подключён' : 'Настроить',
                'Telegram-бот',
                'telegram',
              ],
              [
                'terminal',
                String(data.jobs.filter((job) => job.status === 'running').length),
                'Команд выполняется',
                'logs',
              ],
            ].map(([glyph, value, caption, route]) => {
              const item = button('', null, () => navigate(route), 'metric');
              item.replaceChildren(
                el('span', { className: 'metric-icon' }, icon(glyph)),
                el('div', {}, [
                  el('strong', { textContent: value }),
                  el('span', { textContent: caption }),
                ]),
                icon('chevron', 'metric-arrow'),
              );
              return item;
            }),
          );
        }
        if (pendingCount !== data.approvals.length) {
          pendingCount = data.approvals.length;
          pending.replaceChildren(
            ...(pendingCount
              ? [
                  el('div', { className: 'pending-banner' }, [
                    icon('requests'),
                    el('div', {}, [
                      el('strong', { textContent: `Ждут подтверждения: ${pendingCount}` }),
                      el('p', { textContent: 'Команды начнут выполняться после вашего решения.' }),
                    ]),
                    button('Открыть запросы', 'arrow', () => navigate('approvals')),
                  ]),
                ]
              : []),
          );
        }
        const nextActivity = JSON.stringify(data.activity);
        if (nextActivity !== activityKey) {
          activityKey = nextActivity;
          activity.replaceChildren(...activityRows(data.activity ?? [], true));
        }
      },
    };
  }

  function permissionPicker(chosen) {
    return el(
      'div',
      { className: 'permission-grid' },
      Object.entries(permissions).map(([key, [label, description, glyph]]) =>
        el('label', { className: 'permission-option' }, [
          el('input', {
            type: 'checkbox',
            checked: chosen.has(key),
            onChange: (event) => (event.target.checked ? chosen.add(key) : chosen.delete(key)),
          }),
          icon(glyph),
          el('span', {}, [
            el('strong', { textContent: label }),
            el('small', { textContent: description }),
          ]),
          icon('check', 'permission-check'),
        ]),
      ),
    );
  }

  function editToken(token) {
    const name = input(token?.name ?? '', { placeholder: 'Например, Notion', maxLength: 64 });
    const chosen = new Set(token?.permissions ?? ['files:read']);
    modal({
      title: token ? `Доступ: ${token.name}` : 'Новый токен',
      glyph: 'key',
      description: token
        ? 'Выберите, что сможет делать эта интеграция.'
        : 'По умолчанию разрешено только чтение файлов. Дополнительные права включайте по необходимости.',
      content: el('div', {}, [
        token ? null : field('Имя интеграции', name),
        permissionPicker(chosen),
      ]),
      submitLabel: token ? 'Сохранить доступ' : 'Создать токен',
      onSubmit: async () => {
        if (!token && !name.value.trim()) {
          name.focus();
          throw new Error('Введите имя интеграции.');
        }
        if (!chosen.size) throw new Error('Выберите хотя бы одно разрешение.');
        if (token) {
          await mutate(`/tokens/${token.id}`, 'PATCH', { permissions: [...chosen] });
          toast('Разрешения обновлены');
          return;
        }
        const issued = await mutate('/tokens', 'POST', {
          name: name.value.trim(),
          permissions: [...chosen],
        });
        return () => secretModal(`Токен для ${issued.name}`, issued.token);
      },
    });
  }

  function tokenAction(token, action) {
    const descriptions = {
      delete: [
        'Удалить токен?',
        `Интеграция «${token.name}» потеряет доступ. Восстановить удалённый токен нельзя.`,
        'Удалить токен',
        'trash',
      ],
      rotate: [
        'Заменить токен?',
        `Старый ключ «${token.name}» перестанет работать. Новый нужно будет указать в интеграции.`,
        'Создать новый ключ',
        'refresh',
      ],
      toggle: [
        token.enabled ? 'Приостановить доступ?' : 'Возобновить доступ?',
        `Изменение применяется к интеграции «${token.name}». Сам токен останется прежним.`,
        token.enabled ? 'Приостановить' : 'Возобновить',
        token.enabled ? 'pause' : 'play',
      ],
    };
    const [title, description, submitLabel, glyph] = descriptions[action];
    modal({
      title,
      description,
      submitLabel,
      glyph,
      danger: action === 'delete',
      onSubmit: async () => {
        if (action === 'delete') await mutate(`/tokens/${token.id}`, 'DELETE');
        else if (action === 'toggle')
          await mutate(`/tokens/${token.id}`, 'PATCH', { enabled: !token.enabled });
        else {
          const issued = await mutate(`/tokens/${token.id}/rotate`, 'POST');
          return () => secretModal(`Новый ключ для ${token.name}`, issued.token);
        }
        toast(action === 'delete' ? 'Токен удалён' : 'Статус доступа обновлён');
      },
    });
  }

  function tokensPage() {
    const list = el('div', { className: 'token-list' });
    const search = input('', {
      type: 'search',
      placeholder: 'Найти интеграцию…',
      'aria-label': 'Найти интеграцию',
    });
    let key = '';
    const draw = (data, force = false) => {
      const next = JSON.stringify(data.tokens) + search.value;
      if (!force && next === key) return;
      key = next;
      const tokens = data.tokens.filter((token) =>
        token.name.toLowerCase().includes(search.value.toLowerCase()),
      );
      list.replaceChildren(
        ...(tokens.length
          ? tokens.map((token) =>
              el('article', { className: 'token-card' }, [
                el('div', { className: 'token-top' }, [
                  el('div', { className: 'identity' }, [
                    el('span', { className: 'identity-icon' }, icon('key')),
                    el('div', {}, [
                      el('h3', { textContent: token.name }),
                      el('p', {
                        className: 'muted',
                        textContent: token.lastUsedAt
                          ? `Использован ${relativeTime(token.lastUsedAt).toLowerCase()}`
                          : 'Ещё не использовался',
                      }),
                    ]),
                  ]),
                  badge(
                    token.expiresAt && Date.parse(token.expiresAt) <= Date.now()
                      ? 'Истёк'
                      : token.enabled
                        ? 'Доступ активен'
                        : 'Приостановлен',
                    token.enabled ? 'success' : 'neutral',
                  ),
                ]),
                el(
                  'div',
                  { className: 'permission-tags' },
                  token.permissions.map((permission) =>
                    el('span', { className: 'tag' }, [
                      icon(permissions[permission]?.[2] ?? 'shield'),
                      permissions[permission]?.[0] ?? permission,
                    ]),
                  ),
                ),
                el('div', { className: 'token-footer' }, [
                  el('span', {
                    className: 'muted',
                    textContent: `Создан ${dateTime(token.createdAt)}`,
                  }),
                  el('div', { className: 'button-group' }, [
                    button('Разрешения', 'shield', () => editToken(token), 'small'),
                    button('Заменить', 'refresh', () => tokenAction(token, 'rotate'), 'small'),
                    button(
                      token.enabled ? 'Пауза' : 'Включить',
                      token.enabled ? 'pause' : 'play',
                      () => tokenAction(token, 'toggle'),
                      'small',
                    ),
                    button(
                      'Удалить',
                      'trash',
                      () => tokenAction(token, 'delete'),
                      'small danger-quiet',
                    ),
                  ]),
                ]),
              ]),
            )
          : [
              emptyState(
                'key',
                search.value ? 'Ничего не найдено' : 'Добавьте свою интеграцию',
                search.value
                  ? 'Попробуйте другое имя.'
                  : 'Создайте токен, выберите разрешения и добавьте его в MCP-клиент.',
              ),
            ]),
      );
    };
    search.addEventListener('input', () => draw(state.data, true));
    return {
      node: el('div', { className: 'page-stack' }, [
        el('div', { className: 'page-toolbar' }, [
          el('div', { className: 'search-field' }, [icon('search'), search]),
          button('Новый токен', 'plus', () => editToken(), 'primary'),
        ]),
        list,
        el('p', {
          className: 'section-note',
          textContent:
            'Доступ дают только выпущенные здесь ключи — напрямую или через OAuth. Ключ показывается один раз; отключение также отзывает связанные OAuth-подключения.',
        }),
      ]),
      update: draw,
    };
  }

  function approvalsPage(data) {
    const requests = el('div');
    let key = '';
    const policy = formPanel(
      'Правила запуска',
      'Правила применяются к новым командам. Запреты имеют приоритет.',
      () => {
        const rules = data.settings.approval;
        const mode = select(rules.policy, [
          ['never', 'Запретить команды'],
          ['once', 'Спрашивать перед каждой командой'],
          ['match', 'Спрашивать вне разрешённого списка'],
          ['always', 'Разрешать без подтверждения'],
        ]);
        const timeout = input(String(rules.timeoutMs / 1000), {
          type: 'number',
          min: '1',
          max: '86400',
        });
        const allow = el('textarea', {
          className: 'input mono',
          value: rules.allow.join('\n'),
          rows: 4,
          placeholder: 'git status\nnpm run *',
        });
        const deny = el('textarea', {
          className: 'input mono',
          value: rules.deny.join('\n'),
          rows: 4,
          placeholder: 'Одна команда или шаблон на строку',
        });
        return {
          mode,
          timeout,
          allow,
          deny,
          nodes: [
            el('div', { className: 'form-grid' }, [
              field('Режим подтверждения', mode),
              field('Ожидание ответа, секунд', timeout),
              field('Разрешённые команды', allow, 'Символ * заменяет любое продолжение.'),
              field(
                'Запрещённые команды',
                deny,
                'Запрет действует даже для ранее одобренных команд.',
              ),
            ]),
          ],
        };
      },
      async (controls) => {
        const timeoutMs = Number(controls.timeout.value) * 1000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000)
          throw new Error('Укажите время от 1 до 86400 секунд.');
        await save({
          approval: {
            policy: controls.mode.value,
            timeoutMs,
            allow: lines(controls.allow.value),
            deny: lines(controls.deny.value),
          },
        });
      },
    );
    return {
      node: el('div', { className: 'page-stack' }, [
        panel(
          'Ожидают вашего решения',
          'Один запрос — одно решение, из приложения или Telegram.',
          requests,
        ),
        policy,
      ]),
      update(next) {
        const value = JSON.stringify(next.approvals);
        if (value === key) return;
        key = value;
        requests.replaceChildren(
          ...(next.approvals.length
            ? next.approvals.map((request) =>
                el('article', { className: 'approval-card' }, [
                  el('div', { className: 'row-between' }, [
                    badge('Требуется подтверждение', 'warning'),
                    el('span', {
                      className: 'muted',
                      textContent: `До ${dateTime(request.expiresAt)}`,
                    }),
                  ]),
                  el('pre', { className: 'command-preview', textContent: request.summary }),
                  el('div', { className: 'muted mono', textContent: request.cwd }),
                  el('div', { className: 'button-group' }, [
                    button(
                      'Разрешить',
                      'check',
                      () => mutate(`/approvals/${request.id}/allow`, 'POST', { remember: false }),
                      'primary',
                    ),
                    button('Разрешить и запомнить', 'shield', () =>
                      mutate(`/approvals/${request.id}/allow`, 'POST', { remember: true }),
                    ),
                    button(
                      'Отклонить',
                      'close',
                      () => mutate(`/approvals/${request.id}/deny`, 'POST', {}),
                      'danger-quiet',
                    ),
                  ]),
                ]),
              )
            : [
                emptyState(
                  'shield',
                  'Всё под контролем',
                  'Сейчас нет команд, ожидающих подтверждения.',
                ),
              ]),
        );
      },
    };
  }

  function serversPage() {
    const list = el('div', { className: 'server-list' });
    const diagnostics = el('div');
    let key = '';
    const statuses = {
      connected: ['Подключён', 'success'],
      connecting: ['Подключается', 'warning'],
      error: ['Ошибка подключения', 'error'],
      not_connected: ['По запросу', 'neutral'],
    };
    return {
      node: el('div', { className: 'page-stack' }, [
        panel(
          'Доступные серверы',
          'Серверы запускаются при первом вызове инструмента. «По запросу» — нормальное состояние.',
          list,
          button('Обновить список', 'refresh', () => mutate('/servers/reload', 'POST')),
        ),
        diagnostics,
      ]),
      update(data) {
        const value = JSON.stringify(data.gateway);
        if (key === value) return;
        key = value;
        list.replaceChildren(
          ...(data.gateway.servers.length
            ? data.gateway.servers.map((server) => {
                const [label, tone] = statuses[server.status] ?? statuses.not_connected;
                return el('article', { className: 'server-row' }, [
                  el('div', { className: 'identity' }, [
                    el('span', { className: 'identity-icon' }, icon('servers')),
                    el('div', {}, [
                      el('h3', { textContent: server.name }),
                      el('p', {
                        className: 'muted',
                        textContent: `${server.transport.toUpperCase()} · ${server.tools_cached == null ? 'Каталог загрузится при подключении' : `${server.tools_cached} инструментов`}`,
                      }),
                    ]),
                  ]),
                  badge(label, tone),
                  el('details', { className: 'server-details' }, [
                    el('summary', { textContent: 'Подробности' }),
                    el('code', { textContent: server.id }),
                    el('p', {
                      className: 'muted break-word',
                      textContent: (server.sources ?? []).join('\n'),
                    }),
                    server.error
                      ? el('p', { className: 'inline-error', textContent: server.error })
                      : null,
                  ]),
                ]);
              })
            : [
                emptyState(
                  'servers',
                  'Пока нет MCP-серверов',
                  'Включите автопоиск в настройках или добавьте конфигурацию mcp-servers.json.',
                ),
              ]),
        );
        diagnostics.replaceChildren(
          ...((data.gateway.diagnostics ?? []).length
            ? [
                panel(
                  'Диагностика обнаружения',
                  '',
                  data.gateway.diagnostics.map((item) =>
                    el('p', {
                      className: 'muted break-word',
                      textContent: `${item.source ?? ''}: ${item.message}`,
                    }),
                  ),
                ),
              ]
            : []),
        );
      },
    };
  }

  function telegramPage(data) {
    const status = el('div', { className: 'telegram-status' });
    const renderStatus = (telegram) => {
      const checking = telegram.status === 'checking';
      status.replaceChildren(
        el('div', { className: 'integration-mark' }, icon('telegram')),
        el('div', {}, [
          el('h3', {
            textContent: telegram.ok
              ? telegram.username
                ? `@${telegram.username}`
                : 'Бот подключён'
              : checking
                ? 'Проверяем подключение'
                : 'Подключение требует внимания',
          }),
          el('p', {
            className: 'muted',
            textContent: telegram.ok
              ? `Разрешённых чатов: ${telegram.chats ?? data.settings.telegram.allowedChats.length}`
              : checking
                ? 'Ожидаем ответ Telegram.'
                : telegram.message === 'Not configured'
                  ? 'Сохраните токен и ID вашего чата ниже.'
                  : (telegram.message ?? 'Проверьте токен и ID чата.'),
          }),
        ]),
        badge(
          telegram.ok ? 'На связи' : checking ? 'Проверка' : 'Не подключён',
          telegram.ok ? 'success' : 'warning',
        ),
      );
    };
    const config = formPanel(
      'Подключение бота',
      'Токен можно получить у @BotFather. Напишите боту /start перед первым использованием.',
      () => {
        const token = input('', {
          type: 'password',
          placeholder: data.settings.telegram.tokenSet
            ? 'Токен сохранён · введите новый для замены'
            : 'Токен от BotFather',
          autocomplete: 'new-password',
        });
        const chats = input(data.settings.telegram.allowedChats.join(', '), {
          placeholder: 'Например, 123456789',
        });
        return {
          token,
          chats,
          nodes: [
            field('Токен бота', token, 'Пустое поле сохраняет существующий токен.'),
            field(
              'ID разрешённых чатов',
              chats,
              'Числовые ID через запятую. Только эти чаты смогут управлять сервером.',
            ),
          ],
        };
      },
      async ({ token, chats }) => {
        const allowedChats = chats.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (!allowedChats.length || allowedChats.some((value) => !/^-?\d+$/.test(value)))
          throw new Error('Введите хотя бы один числовой ID чата.');
        if (!token.value.trim() && !state.data.settings.telegram.tokenSet)
          throw new Error('Введите токен бота.');
        await save({ telegram: { token: token.value.trim(), allowedChats } });
        token.value = '';
        token.placeholder = 'Токен сохранён · введите новый для замены';
        renderStatus(await client.call('/telegram/check', { method: 'POST', timeout: 35000 }));
      },
      'Сохранить и проверить',
    );
    const commands = [
      ['/status', 'Состояние сервера и актуальный внешний адрес'],
      ['/pending', 'Запросы на подтверждение'],
      ['/servers', 'Список MCP-серверов'],
      ['/help', 'Все доступные команды'],
    ];
    const commandList = el(
      'div',
      { className: 'telegram-commands' },
      commands.map(([command, text]) =>
        el('div', {}, [
          el('code', { textContent: command }),
          el('span', { className: 'muted', textContent: text }),
        ]),
      ),
    );
    return {
      node: el('div', { className: 'page-stack' }, [
        panel(
          'Ваш Telegram-бот',
          '',
          status,
          button('Проверить', 'refresh', async () =>
            renderStatus(await client.call('/telegram/check', { method: 'POST', timeout: 35000 })),
          ),
        ),
        config,
        panel('Полезные команды', 'Отправьте команду своему боту.', commandList),
      ]),
      update(next) {
        renderStatus(next.telegram);
      },
    };
  }

  function activityRows(entries, compact = false) {
    if (!entries.length)
      return [
        emptyState(
          'log',
          'Здесь появятся действия',
          'Журнал заполняется, когда интеграция выполняет запросы.',
        ),
      ];
    return entries.map((entry) =>
      el('div', { className: `activity-row ${compact ? 'compact' : ''}` }, [
        el(
          'span',
          {
            className: `activity-icon ${entry.outcome === 'failed' || entry.outcome === 'denied' ? 'warning-tone' : ''}`,
          },
          icon(entry.kind === 'command' ? 'terminal' : entry.kind === 'mcp' ? 'servers' : 'file'),
        ),
        el('div', { className: 'activity-copy' }, [
          el('strong', { textContent: entry.action }),
          el('span', {
            className: 'muted',
            textContent: `${entry.actor}${entry.detail && !compact ? ` · ${entry.detail}` : ''}`,
          }),
        ]),
        el('div', { className: 'activity-meta' }, [
          badge(
            outcomeLabels[entry.outcome] ?? entry.outcome,
            entry.outcome === 'failed'
              ? 'error'
              : entry.outcome === 'denied'
                ? 'warning'
                : 'neutral',
          ),
          el('time', {
            className: 'muted',
            textContent: new Date(entry.at).toLocaleTimeString('ru-RU'),
          }),
        ]),
      ]),
    );
  }

  function logsPage() {
    const list = el('div', { className: 'activity-list log-list' });
    const search = input('', {
      type: 'search',
      placeholder: 'Поиск по действию, клиенту или команде',
      'aria-label': 'Поиск по журналу',
    });
    let entries = [];
    let pending = false;
    let active = true;
    const draw = () =>
      list.replaceChildren(
        ...activityRows(
          entries.filter((item) =>
            `${item.actor} ${item.action} ${item.detail}`
              .toLowerCase()
              .includes(search.value.toLowerCase()),
          ),
        ),
      );
    search.addEventListener('input', draw);
    const load = async () => {
      if (pending || !active) return;
      pending = true;
      try {
        const result = await client.call('/audit?limit=300');
        if (!active) return;
        entries = result.entries;
        draw();
      } catch (error) {
        if (active)
          list.replaceChildren(emptyState('alert', 'Журнал временно недоступен', error.message));
      } finally {
        pending = false;
      }
    };
    const auto = el('label', { className: 'auto-refresh' }, [
      el('input', {
        type: 'checkbox',
        checked: state.logAuto,
        onChange: (event) => {
          state.logAuto = event.target.checked;
          if (state.logAuto) void load();
        },
      }),
      'Автообновление',
    ]);
    void load();
    return {
      node: el('div', { className: 'page-stack' }, [
        el('div', { className: 'page-toolbar' }, [
          el('div', { className: 'search-field wide' }, [icon('search'), search]),
          auto,
          button('Обновить', 'refresh', load),
        ]),
        panel(
          'Действия в текущем сеансе',
          'Последние 300 записей. Полная история сохраняется в audit.log.',
          list,
        ),
      ]),
      update() {
        if (state.logAuto) void load();
      },
      dispose() {
        active = false;
      },
    };
  }

  function settingsPage(data) {
    const settings = data.settings;
    const startupHost = el('div', {
      className: 'muted',
      role: 'status',
      textContent: 'Проверяем настройки автозапуска…',
    });
    const drawStartup = (startup) => {
      startupHost.replaceChildren(
        toggle(
          'Запускать при входе в систему',
          startup.detail,
          startup.enabled,
          async (event) => {
            const enabled = event.target.checked;
            event.target.disabled = true;
            try {
              drawStartup(
                await client.call('/autostart', {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled }),
                  timeout: 65000,
                }),
              );
              toast(enabled ? 'Автозапуск включён' : 'Автозапуск выключен');
            } catch (error) {
              event.target.checked = !enabled;
              toast(error.message, 'error');
            } finally {
              event.target.disabled = !startup.supported;
            }
          },
          !startup.supported,
        ),
      );
    };
    void client
      .call('/autostart')
      .then(drawStartup)
      .catch((error) => {
        startupHost.textContent = error.message;
      });
    let savingMinimized = false;
    const minimized = toggle(
      'Запускать свёрнутым в трей',
      'При следующем запуске окно останется скрытым. Нажмите значок TMCP в трее, чтобы открыть его.',
      settings.ui.startMinimized,
      async (event) => {
        const enabled = event.target.checked;
        event.target.disabled = true;
        savingMinimized = true;
        try {
          await save({ ui: { startMinimized: enabled } });
        } catch (error) {
          event.target.checked = !enabled;
          toast(error.message, 'error');
        } finally {
          event.target.disabled = false;
          savingMinimized = false;
        }
      },
    );
    const general = formPanel(
      'Возможности компьютера',
      'Разрешения каждого токена дополнительно ограничивают доступ.',
      () => {
        const values = {
          shell: settings.shell.enabled,
          screenshots: settings.screenshots.enabled,
          discover: settings.gateway.discover,
          logging: settings.logging.enabled,
        };
        const mode = select(settings.gateway.mode, [
          ['catalog', 'По запросу — быстрый запуск'],
          ['namespaced', 'Прямые имена инструментов'],
        ]);
        return {
          values,
          mode,
          nodes: [
            toggle(
              'Запуск команд',
              'Запуск кода с правами вашего пользователя ОС; рабочая папка не является песочницей',
              values.shell,
              (event) => {
                values.shell = event.target.checked;
              },
              !data.capabilities.shell,
            ),
            toggle(
              'Скриншоты',
              'Снимки экрана подключённым клиентам',
              values.screenshots,
              (event) => {
                values.screenshots = event.target.checked;
              },
              !data.capabilities.screenshots,
            ),
            toggle(
              'Автопоиск MCP-серверов',
              'Конфигурации OpenCode, Claude, Cursor и других приложений',
              values.discover,
              (event) => {
                values.discover = event.target.checked;
              },
            ),
            toggle(
              'Записывать журнал',
              'История выполненных и отклонённых действий',
              values.logging,
              (event) => {
                values.logging = event.target.checked;
              },
            ),
            field('Публикация инструментов', mode),
          ],
        };
      },
      ({ values, mode }) =>
        save({
          shell: { enabled: values.shell },
          screenshots: { enabled: values.screenshots },
          gateway: { discover: values.discover, mode: mode.value },
          logging: { enabled: values.logging },
        }),
    );

    const tunnel = formPanel(
      'Внешнее подключение',
      'Быстрый туннель работает без аккаунта. Свой домен даёт постоянный адрес.',
      () => {
        const mode = select(settings.tunnel.mode, [
          ['quick', 'Быстрый туннель · временная ссылка'],
          ['named', 'Свой домен · постоянная ссылка'],
        ]);
        const hostname = input(settings.tunnel.hostname, { placeholder: 'mcp.example.com' });
        const token = input('', {
          type: 'password',
          placeholder: settings.tunnel.tokenSet
            ? 'Connector token сохранён'
            : 'Connector token из Cloudflare Zero Trust',
          autocomplete: 'new-password',
        });
        const named = el('div', { className: 'named-settings', hidden: mode.value !== 'named' }, [
          field('Домен', hostname, 'HTTPS-домен без пути /mcp.'),
          field('Connector token', token, 'Пустое поле оставляет сохранённый ключ.'),
        ]);
        mode.addEventListener('change', () => {
          named.hidden = mode.value !== 'named';
        });
        return {
          mode,
          hostname,
          token,
          nodes: [
            field('Тип туннеля', mode),
            named,
            el('div', { className: 'info-note' }, [
              icon('info'),
              el('p', {
                textContent:
                  'Применение переподключит туннель. Быстрая ссылка изменится; работающие на ПК команды продолжат выполняться.',
              }),
            ]),
          ],
        };
      },
      async ({ mode, hostname, token }) => {
        if (mode.value === 'named') {
          let url;
          try {
            url = new URL(
              hostname.value.includes('://') ? hostname.value : `https://${hostname.value}`,
            );
          } catch {
            throw new Error('Введите домен, например mcp.example.com.');
          }
          if (
            url.protocol !== 'https:' ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            url.username ||
            !url.hostname.includes('.')
          )
            throw new Error('Нужен HTTPS-домен без пути, пароля или параметров.');
          if (!token.value.trim() && !state.data.settings.tunnel.tokenSet)
            throw new Error('Введите connector token Cloudflare.');
        }
        await save({
          tunnel: {
            mode: mode.value,
            hostname: hostname.value.trim(),
            tunnelToken: token.value.trim(),
          },
        });
        token.value = '';
        token.placeholder = state.data.settings.tunnel.tokenSet
          ? 'Connector token сохранён'
          : 'Connector token из Cloudflare Zero Trust';
        await mutate('/tunnel/restart', 'POST', { mode: mode.value }, 105000);
        toast('Внешнее подключение готово');
      },
      'Сохранить и применить',
    );

    const theme = formPanel(
      'Оформление',
      'Спокойный интерфейс для долгой работы.',
      () => {
        const choice = select(settings.ui.theme, [
          ['dark', 'Тёмная тема'],
          ['light', 'Светлая тема'],
        ]);
        return { choice, nodes: [field('Тема приложения', choice)] };
      },
      ({ choice }) => save({ ui: { theme: choice.value } }),
    );
    return {
      node: el('div', { className: 'page-stack settings-page' }, [
        general,
        tunnel,
        theme,
        panel(
          'Автозагрузка и трей',
          'При включении автозагрузки самостоятельный EXE устанавливается в постоянное место.',
          el('div', {}, [startupHost, minimized]),
        ),
        panel(
          'Обслуживание',
          `Сервер работает с ${dateTime(data.startedAt)}. Перезапуск сервера остановит активные команды.`,
          el('div', { className: 'button-group' }, [
            button('Переподключить туннель', 'cloud', restartTunnel),
            button('Перезапустить сервер', 'refresh', restartServer),
            window.chrome?.webview
              ? button('Меню трея', 'settings', () =>
                  window.chrome.webview.postMessage({ type: 'tray-menu' }),
                )
              : null,
            window.chrome?.webview
              ? button('Завершить работу', 'power', () =>
                  modal({
                    title: 'Остановить сервер и выйти?',
                    glyph: 'power',
                    description:
                      'Активные команды и туннель будут остановлены. Приложение закроется после завершения процессов.',
                    submitLabel: 'Остановить и выйти',
                    onSubmit: () => () => window.chrome.webview.postMessage({ type: 'quit' }),
                  }),
                )
              : null,
          ]),
        ),
      ]),
      update(next) {
        if (!savingMinimized)
          minimized.querySelector('input').checked = next.settings.ui.startMinimized;
      },
    };
  }

  const lines = (value) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const wake = () => {
    if (document.hidden) stream.stop();
    else {
      void poller.refresh();
      if (state.data) stream.start();
    }
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  const hostMessage = (event) => {
    const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (message?.type === 'server-ready') void poller.refresh();
    if (message?.type === 'navigate' && Object.hasOwn(pages, message.page)) navigate(message.page);
  };
  window.chrome?.webview?.addEventListener('message', hostMessage);
  void poller.refresh();
  return {
    refresh: () => poller.refresh(),
    dispose() {
      disposed = true;
      currentPage?.dispose?.();
      poller.stop();
      stream.stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.chrome?.webview?.removeEventListener('message', hostMessage);
    },
  };
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  const app = createControlApp();
  window.addEventListener('pagehide', () => app.dispose(), { once: true });
}
