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
import { generateSecret, rotateEnvToken, type OwnerSecrets } from './secrets.js';
import { errorMessage, secretEqual } from './utils.js';
import type { ConnectionView } from './connection.js';
import type { Logger } from './tools.js';
import type { AutostartControl } from './autostart.js';

export interface ControlServices {
  tokens: TokenStore;
  approvals: Approvals;
  audit: AuditLog;
  settings: SettingsStore;
  gateway: Gateway;
  processes: Processes;
  /** Read lazily: the transport is rebuilt when the token changes at runtime. */
  telegram?: () => Telegram | undefined;
  owner: OwnerSecrets;
  publicUrl: () => string;
  connection: () => ConnectionView;
  capabilities: { shell: boolean; screenshots: boolean };
  log: Logger;
  autostart: AutostartControl;
  startedAt: string;
  rotateToken: (kind: 'owner' | 'admin', current: string) => Promise<string>;
  restartTunnel: (mode: 'quick' | 'named') => Promise<{ url: string }>;
  restartServer: () => void;
  /** Rebuilds the Telegram transport after the token or chat list changes at runtime. */
  applySettings: () => Promise<void>;
}

const idParam = z.string().uuid();

/**
 * Local control API used by the desktop UI.
 *
 * The listener is loopback-only and every route requires the admin secret, which the
 * UI reads from the environment at startup. These endpoints can rotate credentials and
 * stop the server, so they are never exposed through the tunnel: the public router
 * rejects any path under this prefix.
 */
export function controlRouter(services: ControlServices): Router {
  const router = Router();
  router.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(header);
    if (!match?.[1] || !secretEqual(match[1], services.owner.adminToken)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Сессия управления истекла. Подключаемся заново.',
      });
      return;
    }
    next();
  });

  router.get('/state', (_req, res) => {
    const gateway = services.gateway.listServers();
    res.json({
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
      telegramControl: Boolean(services.telegram?.()?.describe().ok),
    });
  });

  router.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
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

  router.post('/owner-token/rotate', async (req, res) => {
    const current = z.string().min(1).parse(req.body?.current);
    if (!secretEqual(current, services.owner.bearerToken)) {
      res.status(403).json({ error: 'The current token does not match' });
      return;
    }
    res.json({ token: await services.rotateToken('owner', current) });
  });

  router.post('/admin-token/rotate', async (req, res) => {
    const current = z.string().min(1).parse(req.body?.current);
    if (!secretEqual(current, services.owner.adminToken)) {
      res.status(403).json({ error: 'The current token does not match' });
      return;
    }
    res.json({ token: await services.rotateToken('admin', current) });
  });

  router.post('/secret/generate', (_req, res) => {
    res.json({ token: generateSecret() });
  });

  router.post('/env/apply', async (req, res) => {
    const input = z
      .object({ ownerToken: z.string().optional(), adminToken: z.string().optional() })
      .parse(req.body ?? {});
    res.json(await rotateEnvToken(services.owner.envFile, input));
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
