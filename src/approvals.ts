import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decide, fingerprint, summarize, type ApprovalRules } from './approval.js';

export const approvalRequestSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string(),
  command: z.string(),
  summary: z.string(),
  cwd: z.string(),
  clientId: z.string(),
  /** Where the request was sent, so a response from the GUI is not accepted twice. */
  channel: z.enum(['gui', 'telegram']),
  requestedAt: z.string(),
  expiresAt: z.string(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export type ApprovalOutcome = { action: 'allow'; remembered: boolean } | { action: 'deny' };

interface Pending {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  /** Rejects once the request expires or the client goes away. */
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalListener = (request: ApprovalRequest) => void | Promise<void>;
export type AuditListener = (entry: AuditEntry) => void | Promise<void>;

export const auditEntrySchema = z.object({
  at: z.string(),
  actor: z.string(),
  clientId: z.string(),
  kind: z.enum(['command', 'approval', 'file', 'mcp', 'auth']),
  action: z.string(),
  detail: z.string(),
  outcome: z.enum(['allowed', 'denied', 'executed', 'failed']),
  durationMs: z.number().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * Asks the user before a command runs.
 *
 * Requests are short-lived and answered exactly once: the first decision wins and any
 * later answer for the same request is rejected, which prevents a double click in the
 * GUI from approving a second execution of an already-running command.
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private readonly remembered = new Map<string, 'allow' | 'deny'>();
  private readonly listeners = new Set<ApprovalListener>();

  constructor(
    private readonly lifetimeMs?: number,
    private readonly limit = 16,
  ) {}

  onRequest(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies the rules, asking the user when required.
   *
   * `rules` may be updated by an approval, so it is passed by reference and returned
   * to the caller with any newly remembered rule applied.
   */
  async authorize(input: {
    command: string;
    cwd: string;
    clientId: string;
    rules: ApprovalRules;
    channel?: 'gui' | 'telegram';
  }): Promise<ApprovalOutcome> {
    const key = fingerprint(input.command, input.cwd);
    const verdict = decide(input.rules, input.command);
    if (verdict.action !== 'ask') return { action: verdict.action, remembered: false };
    const remembered = this.remembered.get(key);
    if (remembered) return { action: remembered === 'allow' ? 'allow' : 'deny', remembered: true };

    if (this.pending.size >= this.limit)
      throw new Error('Too many commands are waiting for approval');
    return this.ask({
      command: input.command,
      cwd: input.cwd,
      clientId: input.clientId,
      channel: input.channel ?? 'gui',
      timeoutMs: this.lifetimeMs ?? input.rules.timeoutMs,
    });
  }

  private ask(input: {
    command: string;
    cwd: string;
    clientId: string;
    channel: 'gui' | 'telegram';
    timeoutMs: number;
  }): Promise<ApprovalOutcome> {
    const id = randomUUID();
    const now = Date.now();
    const request: ApprovalRequest = {
      id,
      fingerprint: fingerprint(input.command, input.cwd),
      command: input.command,
      summary: summarize(input.command),
      cwd: input.cwd,
      clientId: input.clientId,
      channel: input.channel,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.timeoutMs).toISOString(),
    };
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Approval timed out. The command was not executed.'));
      }, input.timeoutMs);
      timer.unref();
      this.pending.set(id, { request, resolve, reject, timer });
      for (const listener of this.listeners) {
        void Promise.resolve(listener(request)).catch(() => undefined);
      }
    });
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((value) => value.request);
  }

  /**
   * Answers a pending request.
   *
   * `remember` persists the decision as an allowlist rule for the exact command, so the
   * user can approve once and stop being prompted for it.
   */
  respond(id: string, action: 'allow' | 'deny', remember = false): ApprovalOutcome {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('This approval request has expired or was already answered');
    if (remember) this.remembered.set(entry.request.fingerprint, action);
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const outcome: ApprovalOutcome =
      action === 'allow' ? { action: 'allow', remembered: remember } : { action: 'deny' };
    entry.resolve(outcome);
    return outcome;
  }

  /** Fails every pending request, used when the server is shutting down. */
  cancelAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  forget(fingerprintValue: string): void {
    this.remembered.delete(fingerprintValue);
  }

  listRemembered(): string[] {
    return [...this.remembered.keys()];
  }
}

/**
 * Append-only audit trail.
 *
 * Entries are written as JSON lines so the GUI can tail them without keeping the whole
 * file in memory, and the in-memory ring buffer lets the GUI show recent activity even
 * when the file has been rotated away.
 */
export class AuditLog {
  private readonly recent: AuditEntry[] = [];
  private readonly queue: string[] = [];
  private flushing = false;

  constructor(
    private readonly sink: (lines: string[]) => Promise<void>,
    private readonly listener: AuditListener,
    private readonly retention = 500,
  ) {}

  async write(entry: AuditEntry): Promise<void> {
    this.recent.push(entry);
    if (this.recent.length > this.retention)
      this.recent.splice(0, this.recent.length - this.retention);
    this.queue.push(JSON.stringify(entry));
    await this.flush();
    await this.listener(entry);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.queue.length);
      if (batch.length) await this.sink(batch);
    } finally {
      this.flushing = false;
    }
  }

  tail(limit: number): AuditEntry[] {
    return this.recent.slice(-limit).reverse();
  }

  clearRecent(): void {
    this.recent.length = 0;
  }
}
