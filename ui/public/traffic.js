import { el, button, badge } from './components.js';
import { icon } from './icons.js';

const phases = {
  received: ['Получен', 'neutral'],
  authorized: ['Доступ проверен', 'neutral'],
  waiting: ['Ждёт подтверждения', 'warning'],
  running: ['В обработке', 'warning'],
  returned: ['Ответ отправлен', 'success'],
  denied: ['Доступ отклонён', 'error'],
  failed: ['Ошибка', 'error'],
  cancelled: ['Соединение закрыто', 'neutral'],
};
const milliseconds = (value) =>
  value == null ? '—' : value < 1000 ? `${value} мс` : `${(value / 1000).toFixed(2)} с`;
const svg = (tag, attributes = {}, children = []) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
};

export class TrafficPanel {
  constructor() {
    this.records = [];
    this.tokens = [];
    this.following = true;
    this.selectedId = null;
    this.selected = null;
    this.signature = '';
    this.tokenSignature = '';
    this.timers = new Set();
    this.frame = null;
    this.disposed = false;
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.connection = el('div', {}, badge('Подключение…', 'neutral'));
    this.follow = button(
      'Пауза',
      'pause',
      () => {
        this.following = !this.following;
        this.renderSelected(true);
      },
      'text-button',
    );
    this.stats = el('div', { className: 'traffic-stats' });
    this.statValues = {};
    for (const [key, title] of [
      ['received', 'Запросов'],
      ['active', 'В обработке'],
      ['completed', 'Ответов'],
      ['failed', 'Ошибок / отказов'],
      ['p95Ms', 'P95 ответа'],
    ]) {
      const value = el('strong', { textContent: '—', 'data-stat': key });
      this.statValues[key] = value;
      this.stats.append(el('div', {}, [el('span', { textContent: title }), value]));
    }
    this.entry = this.card('connection', 'MCP-клиент', 'POST /mcp');
    this.operation = this.card('terminal', 'Ожидание запроса', 'Инструменты этого компьютера');
    this.result = this.card('arrow', 'Ожидание', 'Ответ клиенту');
    this.tokenList = el('div', { className: 'flow-tokens' });
    this.paths = svg('svg', { class: 'flow-paths', 'aria-hidden': 'true' });
    this.map = el(
      'div',
      {
        className: 'traffic-map',
        role: 'group',
        'aria-label': 'Путь запроса: клиент, токен, инструмент и ответ',
      },
      [
        this.paths,
        this.stage('01', 'Входящий запрос', this.entry.node),
        this.stage('02', 'Ключ доступа', this.tokenList),
        this.stage('03', 'Исполнение', this.operation.node),
        this.stage('04', 'Результат', this.result.node),
        el('span', {
          className: 'flow-return-label',
          textContent: 'Обратный путь: ответ клиенту',
        }),
      ],
    );
    this.selection = el('div', { className: 'traffic-selection' });
    this.history = el('div', {
      className: 'traffic-history',
      role: 'group',
      'aria-label': 'Последние MCP-запросы',
    });
    this.node = el('section', { className: 'panel traffic-panel', 'data-phase': 'idle' }, [
      el('div', { className: 'panel-heading' }, [
        el('div', {}, [
          el('h2', { textContent: 'Поток запросов' }),
          el('p', {
            className: 'muted',
            textContent: 'От входящего запроса до ответа — в реальном времени',
          }),
        ]),
        el('div', { className: 'traffic-controls' }, [this.connection, this.follow]),
      ]),
      this.stats,
      this.map,
      this.selection,
      el('div', { className: 'traffic-legend' }, [
        el('span', { className: 'request', textContent: 'Запрос' }),
        el('span', { className: 'response', textContent: 'Ответ' }),
        el('span', {
          className: 'traffic-timing-note',
          textContent: 'Время фактическое · анимация замедлена',
        }),
      ]),
      this.history,
      el('p', {
        className: 'traffic-privacy',
        textContent:
          'Статистика с запуска сервера. Только названия и статусы: ключи, аргументы и содержимое ответов здесь не сохраняются.',
      }),
    ]);
    this.observer = new ResizeObserver(() => this.scheduleDraw());
    this.observer.observe(this.map);
    this.renderSelected();
    this.renderHistory();
  }

  card(glyph, title, detail) {
    const heading = el('strong', { textContent: title });
    const description = el('span', { textContent: detail });
    return {
      heading,
      description,
      node: el('div', { className: 'flow-card' }, [icon(glyph), heading, description]),
    };
  }

  stage(number, title, content) {
    return el('div', { className: 'flow-stage' }, [
      el('div', { className: 'flow-stage-label' }, [
        el('b', { textContent: number }),
        el('span', { textContent: title }),
      ]),
      el('div', { className: 'flow-stage-body' }, content),
    ]);
  }

  setConnected(connected) {
    this.connection.replaceChildren(
      badge(connected ? 'LIVE' : 'Переподключение', connected ? 'success' : 'neutral'),
    );
    this.node.dataset.connected = String(connected);
  }

  setTokens(tokens) {
    this.tokens = tokens;
    this.renderTokens();
  }

  update(data, animate = false) {
    if (!data) return;
    this.records = data.records ?? [];
    const stats = data.stats;
    for (const [key, value] of Object.entries(this.statValues)) {
      value.textContent =
        key === 'p95Ms'
          ? milliseconds(stats.p95Ms)
          : String(key === 'failed' ? stats.failed + stats.denied : stats[key]);
    }
    this.statValues.p95Ms.title = '95% последних 128 ответов уложились в это время';
    this.renderSelected(animate);
    this.renderHistory();
  }

  renderTokens() {
    const selected = this.selected;
    const candidates = this.tokens.map((token) => ({
      id: token.id,
      name: token.name,
      enabled: token.enabled,
      count: token.permissions.length,
    }));
    if (selected && !candidates.some((token) => token.id === selected.tokenId)) {
      candidates.unshift({
        id: selected.tokenId,
        name: selected.tokenName,
        enabled: Boolean(selected.tokenId),
        count: null,
      });
    }
    let visible = candidates.slice(0, 4);
    const active = candidates.find((token) => token.id === selected?.tokenId);
    if (active && !visible.includes(active)) visible = [...visible.slice(0, 3), active];
    const signature = JSON.stringify([visible, selected?.tokenId]);
    if (signature === this.tokenSignature) return;
    this.tokenSignature = signature;
    this.tokenList.replaceChildren(
      ...visible.map((token) =>
        el(
          'div',
          {
            className: `flow-token${selected && token.id === selected.tokenId ? ' selected' : ''}${!token.enabled ? ' inactive' : ''}`,
            'data-token-id': token.id ?? 'unknown',
            title: token.enabled ? token.name : `${token.name} — доступ приостановлен`,
          },
          [
            icon('key'),
            el('span', { textContent: token.name }),
            el('small', {
              textContent: token.count == null ? '—' : `${token.count} разр.`,
              title:
                token.count == null ? 'Права определяются ключом' : `Разрешений: ${token.count}`,
            }),
          ],
        ),
      ),
    );
    if (!visible.length)
      this.tokenList.append(
        el('div', { className: 'flow-token' }, [
          icon('key'),
          el('span', { textContent: 'Ключ клиента' }),
        ]),
      );
    if (candidates.length > visible.length)
      this.tokenList.append(
        el('small', {
          className: 'flow-more',
          textContent: `Ещё ${candidates.length - visible.length} · раздел «Доступ»`,
        }),
      );
    this.scheduleDraw();
  }

  renderSelected(animate = false) {
    const record = this.following
      ? this.records[0]
      : this.records.find((item) => item.id === this.selectedId);
    const previous = this.selected;
    this.selected = record ?? null;
    this.selectedId = record?.id ?? null;
    this.follow.replaceChildren(
      icon(this.following ? 'pause' : 'play'),
      el('span', { textContent: this.following ? 'Пауза' : 'Следить' }),
    );
    this.follow.setAttribute('aria-pressed', String(!this.following));
    this.follow.title = this.following
      ? 'Приостановить просмотр новых запросов. Сервер продолжит работу.'
      : 'Показывать последний запрос';
    const signature = JSON.stringify([
      record?.id,
      record?.phase,
      record?.tool,
      record?.target,
      this.following,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const [status, tone] = phases[record?.phase] ?? ['Ожидаем первый запрос', 'neutral'];
    this.node.dataset.phase = record?.phase ?? 'idle';
    this.operation.heading.textContent = record?.tool ?? record?.method ?? 'Ожидание запроса';
    this.operation.heading.title = this.operation.heading.textContent;
    this.operation.description.textContent =
      record?.target ??
      (record?.phase === 'waiting' ? 'Нужно решение владельца' : 'Локальные инструменты');
    this.entry.description.textContent = record?.method ?? 'POST /mcp';
    this.result.heading.textContent = record?.finishedAt ? `HTTP ${record.httpStatus}` : 'Ожидание';
    this.result.description.textContent = record?.finishedAt
      ? milliseconds(record.durationMs)
      : 'Ответ ещё не отправлен';
    this.selection.replaceChildren(
      badge(status, tone),
      el('span', {
        className: 'traffic-request-id',
        textContent: record
          ? `${this.following ? 'Последний' : 'Просмотр'} · ${record.id.slice(0, 8)}`
          : 'Схема оживёт при обращении MCP-клиента',
      }),
      ...(record
        ? [el('span', { className: 'traffic-selected-token', textContent: record.tokenName })]
        : []),
    );
    this.renderTokens();
    this.scheduleDraw(animate && Boolean(record), previous?.id !== record?.id || !this.following);
  }

  renderHistory() {
    const visible = this.records.slice(0, 6);
    if (!visible.length) {
      if (!this.history.querySelector('.traffic-empty'))
        this.history.replaceChildren(
          el('div', { className: 'traffic-empty' }, [
            icon('log'),
            el('span', { textContent: 'Запросов пока нет. Подключите клиент по ссылке выше.' }),
          ]),
        );
      return;
    }
    const existing = new Map(
      [...this.history.children].map((node) => [node.dataset.requestId, node]),
    );
    this.history.querySelector('.traffic-empty')?.remove();
    const retained = new Set();
    for (const [index, record] of visible.entries()) {
      let row = existing.get(record.id);
      const [phase, tone] = phases[record.phase];
      if (!row) {
        row = el('button', {
          type: 'button',
          className: 'traffic-row',
          'data-request-id': record.id,
        });
        row.addEventListener('click', () => {
          this.following = false;
          this.selectedId = record.id;
          this.signature = '';
          this.renderSelected(true);
          this.renderHistory();
        });
        row.append(
          el('time'),
          el('span', { className: 'traffic-row-token' }),
          el('code'),
          el('span', { className: 'traffic-row-phase' }),
          el('span', { className: 'traffic-row-duration' }),
        );
      }
      const [time, token, tool, state, duration] = row.children;
      time.textContent = new Date(record.startedAt).toLocaleTimeString('ru-RU');
      token.textContent = record.tokenName;
      token.title = record.tokenName;
      tool.textContent = record.tool ?? record.method;
      tool.title = record.target ?? tool.textContent;
      state.textContent = phase;
      state.className = `traffic-row-phase ${tone}-tone`;
      duration.textContent = milliseconds(record.durationMs);
      row.classList.toggle('selected', record.id === this.selectedId);
      row.setAttribute('aria-pressed', String(record.id === this.selectedId));
      if (this.history.children[index] !== row)
        this.history.insertBefore(row, this.history.children[index] ?? null);
      retained.add(row);
    }
    for (const row of existing.values()) if (!retained.has(row)) row.remove();
  }

  scheduleDraw(animate = false, wholeRequest = false) {
    this.animateNext ||= animate;
    this.animateWhole ||= wholeRequest;
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.node.isConnected || this.disposed) return;
      this.draw();
      if (this.animateNext) this.animate(this.animateWhole);
      this.animateNext = false;
      this.animateWhole = false;
    });
  }

  draw() {
    const origin = this.map.getBoundingClientRect();
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const curve = (a, b) => {
      const x = a.x + a.width + 2,
        y = a.y + a.height / 2;
      const endX = b.x - 2,
        endY = b.y + b.height / 2;
      const middle = (x + endX) / 2;
      return `M ${x} ${y} C ${middle} ${y}, ${middle} ${endY}, ${endX} ${endY}`;
    };
    const start = box(this.entry.node),
      executor = box(this.operation.node),
      reply = box(this.result.node);
    const tokens = [...this.tokenList.querySelectorAll('.flow-token')];
    const chosen = tokens.find((node) => node.classList.contains('selected')) ?? tokens[0];
    if (!chosen || !origin.width) return;
    const selected = box(chosen);
    this.forward = [curve(start, selected), curve(selected, executor), curve(executor, reply)];
    const bottom = origin.height - 21;
    this.backward = `M ${reply.x + reply.width / 2} ${reply.y + reply.height + 3} V ${bottom - 10} Q ${reply.x + reply.width / 2} ${bottom}, ${reply.x + reply.width / 2 - 10} ${bottom} H ${start.x + start.width / 2 + 10} Q ${start.x + start.width / 2} ${bottom}, ${start.x + start.width / 2} ${bottom - 10} V ${start.y + start.height + 3}`;
    this.paths.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`);
    this.paths.replaceChildren();
    for (const token of tokens)
      this.paths.append(
        svg('path', { d: curve(start, box(token)), class: 'flow-wire' }),
        svg('path', { d: curve(box(token), executor), class: 'flow-wire' }),
      );
    for (const d of this.forward)
      this.paths.append(
        svg('path', { d, class: `flow-wire${this.selected ? ' flow-wire-selected' : ''}` }),
      );
    this.paths.append(svg('path', { d: this.backward, class: 'flow-wire flow-wire-return' }));
  }

  animate(wholeRequest) {
    if (!this.selected || this.motion.matches || document.hidden || this.map.clientWidth < 500)
      return;
    const record = this.selected;
    if (wholeRequest || !record.finishedAt) {
      this.forward.forEach((path, index) => this.particle(path, 'request', index * 290, 310));
      this.outboundUntil = performance.now() + 920;
    }
    if (record.finishedAt)
      this.particle(
        this.backward,
        record.phase === 'returned' ? 'response' : 'error',
        Math.max(0, (this.outboundUntil ?? 0) - performance.now()),
        680,
      );
  }

  particle(path, kind, delay, duration) {
    const motion = svg('animateMotion', {
      path,
      dur: `${duration}ms`,
      begin: 'indefinite',
      fill: 'freeze',
    });
    const dot = svg('circle', { r: 3.5, class: `flow-packet ${kind}`, opacity: 0 }, [motion]);
    this.paths.append(dot);
    const start = setTimeout(() => {
      this.timers.delete(start);
      if (!dot.isConnected) return;
      dot.setAttribute('opacity', '1');
      motion.beginElement();
      const end = setTimeout(() => {
        dot.remove();
        this.timers.delete(end);
      }, duration + 30);
      this.timers.add(end);
    }, delay);
    this.timers.add(start);
  }

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
