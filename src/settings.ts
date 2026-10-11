import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { approvalPolicySchema, defaultRules, type ApprovalRules } from './approval.js';
import { atomicWrite, isErrno, SerialQueue } from './utils.js';

export interface Settings {
  approval: ApprovalRules;
  telegram: { token: string; allowedChats: string[] };
  logging: { enabled: boolean; maxBytes: number };
  screenshots: { enabled: boolean };
  shell: { enabled: boolean };
  gateway: { discover: boolean; mode: 'catalog' | 'namespaced' };
  tunnel: { mode: 'quick' | 'named'; hostname: string; tunnelToken: string };
  ui: { theme: 'dark' | 'light'; locale: string; startMinimized: boolean };
  updates: { enabled: boolean };
}

const settingsSchema = z.object({
  approval: z.object({
    policy: approvalPolicySchema,
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    timeoutMs: z.number().int().min(1000).max(86400000),
  }),
  telegram: z.object({ token: z.string(), allowedChats: z.array(z.string()) }),
  logging: z.object({ enabled: z.boolean(), maxBytes: z.number().int().min(65536).max(268435456) }),
  screenshots: z.object({ enabled: z.boolean() }),
  shell: z.object({ enabled: z.boolean() }),
  gateway: z.object({ discover: z.boolean(), mode: z.enum(['catalog', 'namespaced']) }),
  tunnel: z.object({
    mode: z.enum(['quick', 'named']),
    hostname: z.string(),
    tunnelToken: z.string(),
  }),
  ui: z.object({
    theme: z.enum(['dark', 'light']),
    locale: z.string(),
    startMinimized: z.boolean().default(false),
  }),
  updates: z.object({ enabled: z.boolean() }).default({ enabled: true }),
});

const settingsPatchSchema = z
  .object({
    approval: settingsSchema.shape.approval.partial().optional(),
    telegram: z
      .object({
        token: z.string().trim().max(512).optional(),
        allowedChats: z
          .array(
            z
              .string()
              .trim()
              .regex(/^-?\d+$/, 'Expected a numeric Telegram chat ID'),
          )
          .max(32)
          .optional(),
      })
      .optional(),
    logging: settingsSchema.shape.logging.partial().optional(),
    screenshots: settingsSchema.shape.screenshots.partial().optional(),
    shell: settingsSchema.shape.shell.partial().optional(),
    gateway: settingsSchema.shape.gateway.partial().optional(),
    tunnel: settingsSchema.shape.tunnel.partial().optional(),
    updates: z.object({ enabled: z.boolean().optional() }).optional(),
    ui: z
      .object({
        theme: z.enum(['dark', 'light']).optional(),
        locale: z.string().optional(),
        startMinimized: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export const defaultSettings: Settings = {
  approval: defaultRules,
  telegram: { token: '', allowedChats: [] },
  logging: { enabled: true, maxBytes: 8388608 },
  screenshots: { enabled: true },
  shell: { enabled: true },
  gateway: { discover: true, mode: 'catalog' },
  tunnel: { mode: 'quick', hostname: '', tunnelToken: '' },
  ui: { theme: 'dark', locale: 'ru', startMinimized: false },
  updates: { enabled: true },
};

export interface RedactedSettings extends Settings {
  telegram: { token: string; allowedChats: string[]; tokenSet: boolean };
  tunnel: { mode: 'quick' | 'named'; hostname: string; tunnelToken: string; tokenSet: boolean };
}

/**
 * Persists GUI settings as JSON.
 *
 * Secrets are stored in this file rather than the environment so the GUI can rotate them
 * without editing `.env`. Reads redact secrets by default; `secretFor` returns the real
 * value only to the components that need to authenticate.
 */
export class SettingsStore {
  private data: Settings = structuredClone(defaultSettings);
  private readonly writes = new SerialQueue();

  constructor(
    private readonly filename: string,
    defaults?: Settings,
  ) {
    if (defaults) this.data = structuredClone(defaults);
  }

  async load(): Promise<void> {
    try {
      this.data = settingsSchema.parse(JSON.parse(await readFile(this.filename, 'utf8')));
    } catch (error) {
      if (!isErrno(error, 'ENOENT'))
        throw new Error('Cannot read settings; the saved file has been preserved', {
          cause: error,
        });
    }
  }

  get(): Settings {
    return structuredClone(this.data);
  }

  /** Returns settings with secrets replaced by a presence flag. */
  redacted(): RedactedSettings {
    const value = this.get();
    return {
      ...value,
      telegram: { ...value.telegram, token: '', tokenSet: Boolean(value.telegram.token) },
      tunnel: { ...value.tunnel, tunnelToken: '', tokenSet: Boolean(value.tunnel.tunnelToken) },
    };
  }

  /** Returns the real secret. Only pass the value to code that authenticates with it. */
  secretFor(kind: 'telegram' | 'tunnel'): string {
    return kind === 'telegram' ? this.data.telegram.token : this.data.tunnel.tunnelToken;
  }

  /** Merges a partial update. Secrets keep their stored value when sent as an empty string. */
  async update(changes: unknown): Promise<RedactedSettings> {
    const incoming = settingsPatchSchema.parse(changes);
    return this.writes.run(async () => {
      const draft = this.get();
      for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined) Object.assign(draft[key as keyof Settings], value);
      }
      draft.telegram.token = incoming.telegram?.token?.trim() || this.data.telegram.token;
      draft.tunnel.tunnelToken =
        incoming.tunnel?.tunnelToken?.trim() || this.data.tunnel.tunnelToken;
      if (/^[•*]+$/.test(draft.telegram.token) || /^[•*]+$/.test(draft.tunnel.tunnelToken))
        throw new Error('Enter a new secret, not its masked placeholder');
      draft.telegram.allowedChats = [...new Set(draft.telegram.allowedChats)];
      const validated = settingsSchema.parse(draft);
      await atomicWrite(this.filename, JSON.stringify(validated, null, 2));
      this.data = validated;
      return this.redacted();
    });
  }
}

/** Redacts a secret for display, showing only enough to recognise it. */
export function maskSecret(value: string): string {
  return value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json');
}
