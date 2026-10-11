import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Approvals, AuditLog } from './approvals.js';
import type { Gateway } from './gateway/gateway.js';
import type { Processes } from './processes.js';
import type { SettingsStore } from './settings.js';
import type { Telegram } from './telegram.js';
import type { TokenStore } from './auth/tokens.js';
import { permissionLabels, permissions, type Permission } from './permissions.js';
import { errorMessage } from './utils.js';
import type { ConnectionView } from './connection.js';
import type { Logger } from './tools.js';
import type { AutostartControl } from './autostart.js';
import type { Traffic, TrafficEvent } from './traffic.js';
import { version } from './version.js';

export interface ControlServices {
  tokens: TokenStore;
  approvals: Approvals;
  audit: AuditLog;
  traffic: Traffic;
  settings: SettingsStore;
  gateway: Gateway;
  processes: Processes;
  /** Read lazily: the transport is rebuilt when the token changes at runtime. */
  telegram?: () => Telegram | undefined;
  publicUrl: () => string;
  connection: () => ConnectionView;
  capabilities: { shell: boolean; screenshots: boolean };
  log: Logger;
  autostart: AutostartControl;
  maintenance: () => boolean;
  setMaintenance: (enabled: boolean) => void;
  startedAt: string;
  restartTunnel: (mode: 'quick' | 'named') => Promise<{ url: string }>;
  restartServer: () => void;
  /** Rebuilds the Telegram transport after the token or chat list changes at runtime. */
  applySettings: () => Promise<void>;
}

const idParam = z.string().uuid();

/** Mount only behind the OS-protected IPC listener. */
export function controlRouter(services: ControlServices): Router {
  const router = Router();

  router.get('/state', (_req, res) => {
    const gateway = services.gateway.listServers();
    res.json({
      version,
      maintenance: services.maintenance(),
      publicUrl: services.publicUrl(),
      connection: services.connection(),
      capabilities: services.capabilities,
      startedAt: services.startedAt,
      telegram: services.telegram?.()?.describe() ?? { ok: false, message: 'Not configured' },
      tokens: services.tokens.list(),
      approvals: services.approvals.list(),
      settings: services.settings.redacted(),
      gateway,
      catalog: permissions.map((permission) => ({
        permission,
        label: permissionLabels[permission],
      })),
      jobs: services.processes.listAll(),
      activity: services.audit.tail(5),
      traffic: services.traffic.snapshot(),
      telegramControl: Boolean(services.telegram?.()?.describe().ok),
    });
  });

  router.get('/events', (_req, res) => {
    const send = (event: TrafficEvent) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 256 * 1024) {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = services.traffic.subscribe(send, () => res.end());
    res
      .set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      .flushHeaders();
    send(services.traffic.snapshot());
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    heartbeat.unref();
    res.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.patch('/maintenance', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    services.setMaintenance(enabled);
    res.json({ maintenance: services.maintenance() });
  });

  router.get('/audit', (req, res) => {
    const requested = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(1, requested), 1000) : 200;
    res.json({ entries: services.audit.tail(limit) });
  });

  router.get('/autostart', async (_req, res) => {
    res.json(await services.autostart.status());
  });
  router.patch('/autostart', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(await services.autostart.set(enabled));
  });

  router.get('/servers', (_req, res) => {
    res.json(services.gateway.listServers());
  });

  router.post('/servers/reload', async (_req, res) => {
    await services.gateway.reload(false);
    res.json(services.gateway.listServers());
  });

  router.post('/tokens', async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(64),
        permissions: z.array(z.string()),
        enabled: z.boolean().optional(),
        expiresAt: z.string().nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json(await services.tokens.create(input));
  });

  router.patch('/tokens/:id', async (req, res) => {
    const changes = z
      .object({
        permissions: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        expiresAt: z.string().nullable().optional(),
      })
      .parse(req.body);
    res.json(await services.tokens.update(idParam.parse(req.params.id), changes));
  });

  router.post('/tokens/:id/rotate', async (_req, res) => {
    res.json(await services.tokens.rotate(idParam.parse(_req.params.id)));
  });

  router.delete('/tokens/:id', async (_req, res) => {
    await services.tokens.remove(idParam.parse(_req.params.id));
    res.status(204).end();
  });

  router.patch('/settings', async (req, res) => {
    const updated = await services.settings.update(req.body);
    await services.applySettings();
    res.json(updated);
  });

  router.post('/telegram/check', async (_req, res) => {
    const telegram = services.telegram?.();
    res.json(
      telegram
        ? await telegram.check()
        : { ok: false, status: 'incomplete', message: 'Сначала сохраните токен бота и ID чата.' },
    );
  });

  router.post('/connection/check', async (_req, res) => {
    const connection = services.connection();
    if (!connection.mcpUrl) {
      res.json({
        ok: false,
        message: 'Внешний адрес ещё не готов.',
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    const started = performance.now();
    try {
      const response = await fetch(`${connection.publicUrl}/health`, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        res.json({
          ok: false,
          httpStatus: response.status,
          checkedAt: new Date().toISOString(),
          message: `Внешний адрес вернул HTTP ${response.status}. Проверьте туннель и повторите проверку.`,
        });
        return;
      }
      const body = (await response.json()) as { status?: string; service?: string };
      const ok = response.ok && body.status === 'ok' && body.service === 'pc-mcp-tunnel';
      res.json({
        ok,
        latencyMs: Math.round(performance.now() - started),
        checkedAt: new Date().toISOString(),
        message: ok
          ? 'Сервер доступен через внешний адрес.'
          : 'Туннель не вернул ответ MCP-сервера.',
      });
    } catch {
      res.json({
        ok: false,
        checkedAt: new Date().toISOString(),
        message: 'Не удалось получить ответ через туннель за 10 секунд. Попробуйте ещё раз.',
      });
    }
  });

  router.post('/approvals/:id/:action', (req, res) => {
    const action = z.enum(['allow', 'deny']).parse(req.params.action);
    const remember = req.body?.remember === true;
    res.json(services.approvals.respond(idParam.parse(req.params.id), action, remember));
  });

  router.post('/tunnel/restart', async (req, res) => {
    const mode = z
      .enum(['quick', 'named'])
      .parse(req.body?.mode ?? services.settings.get().tunnel.mode);
    res.json(await services.restartTunnel(mode));
  });

  router.post('/server/restart', (_req, res) => {
    res.json({ restarting: true });
    setImmediate(services.restartServer);
  });

  router.use((_req, res) =>
    res
      .status(404)
      .json({ error: 'not_found', message: 'Действие не найдено. Обновите приложение.' }),
  );
  router.use(controlErrorHandler(services.log));

  return router;
}

const knownErrors: [RegExp, number, string][] = [
  [/already exists/, 409, 'Токен с таким именем уже существует. Выберите другое имя.'],
  [/Unknown token/, 404, 'Этот токен уже удалён. Обновите список.'],
  [/expired or was already answered/, 409, 'Запрос уже обработан или истёк. Обновите список.'],
  [/at least one permission/, 400, 'Выберите хотя бы одно разрешение.'],
  [/needs a name/, 400, 'Введите имя токена.'],
  [/Token limit/, 409, 'Достигнут лимит: 64 токена.'],
  [/masked placeholder/, 400, 'Введите настоящий ключ вместо символов маски.'],
  [
    /Named tunnel requires/,
    400,
    'Для постоянного адреса сохраните домен и connector token Cloudflare.',
  ],
  [/restart is already running/, 409, 'Перезапуск уже выполняется. Дождитесь подключения.'],
  [
    /Autostart is unavailable/,
    409,
    'Автозапуск недоступен в этой среде. На Linux нужен пользовательский systemd.',
  ],
];

export function controlErrorHandler(log: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Проверьте заполнение полей.',
        fields: error.issues.map((issue) => issue.path.join('.')),
      });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({
        error: 'invalid_json',
        message: 'Не удалось прочитать запрос. Повторите действие.',
      });
      return;
    }
    if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_too_large', message: 'Запрос слишком большой.' });
      return;
    }
    const message = errorMessage(error);
    const known = knownErrors.find(([pattern]) => pattern.test(message));
    if (known) {
      res.status(known[1]).json({ error: 'operation_failed', message: known[2] });
      return;
    }
    const reference = randomUUID().slice(0, 8);
    log({ event: 'control_error', reference, method: req.method, path: req.path, message });
    res.status(500).json({
      error: 'internal_error',
      message: `Не удалось выполнить действие. Повторите попытку. Код: ${reference}.`,
    });
  };
}

export function unauthorized(res: Response, message = 'unauthorized'): void {
  res.status(401).json({ error: message });
}

export function requirePermission(granted: readonly Permission[], permission: Permission): boolean {
  return granted.includes(permission);
}

export type { Request };
