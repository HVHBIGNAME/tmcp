import { randomUUID } from 'node:crypto';

export type TrafficPhase =
  | 'received'
  | 'authorized'
  | 'waiting'
  | 'running'
  | 'returned'
  | 'denied'
  | 'failed'
  | 'cancelled';

export interface TrafficRecord {
  id: string;
  order: number;
  method: string;
  tool: string | null;
  target: string | null;
  tokenId: string | null;
  tokenName: string;
  phase: TrafficPhase;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  httpStatus: number | null;
  stages: { phase: TrafficPhase; afterMs: number }[];
}

type Outcome = 'returned' | 'denied' | 'failed' | 'cancelled';
type Subscriber = { update: (event: TrafficEvent) => void; close: () => void };
export type TrafficEvent = {
  type: 'snapshot' | 'update';
  instanceId: string;
  sequence: number;
  stats: {
    received: number;
    active: number;
    completed: number;
    failed: number;
    denied: number;
    p95Ms: number | null;
  };
  records?: TrafficRecord[];
  record?: TrafficRecord;
};

const label = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 96);

/** Ephemeral request metadata. Credentials, arguments, command output and file contents never enter this feed. */
export class Traffic {
  private readonly instanceId = randomUUID();
  private sequence = 0;
  private readonly records = new Map<string, TrafficRecord>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly latencies: number[] = [];
  private readonly totals = { received: 0, active: 0, completed: 0, failed: 0, denied: 0 };
  private closed = false;

  constructor(private readonly retention = 150) {}

  begin(method: string): TrafficSpan {
    const record: TrafficRecord = {
      id: randomUUID(),
      order: this.totals.received + 1,
      method: label(method),
      tool: null,
      target: null,
      tokenId: null,
      tokenName: 'Проверка ключа',
      phase: 'received',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      httpStatus: null,
      stages: [{ phase: 'received', afterMs: 0 }],
    };
    this.totals.received++;
    this.totals.active++;
    this.records.set(record.id, record);
    if (this.records.size > this.retention) this.records.delete(this.records.keys().next().value!);
    this.changed(record);
    return new TrafficSpan(record, (finished) => {
      if (finished) {
        this.totals.active--;
        if (record.phase === 'returned') this.totals.completed++;
        else if (record.phase === 'denied') this.totals.denied++;
        else this.totals.failed++;
        this.latencies.push(record.durationMs!);
        if (this.latencies.length > 128) this.latencies.shift();
      }
      this.changed(record);
    });
  }

  private stats(): TrafficEvent['stats'] {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ...this.totals,
      p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
    };
  }

  private changed(record: TrafficRecord): void {
    this.sequence++;
    if (this.closed || !this.subscribers.size) return;
    const event: TrafficEvent = {
      type: 'update',
      instanceId: this.instanceId,
      sequence: this.sequence,
      stats: this.stats(),
      record: structuredClone(record),
    };
    for (const subscriber of this.subscribers) subscriber.update(event);
  }

  snapshot(): TrafficEvent {
    return {
      type: 'snapshot',
      instanceId: this.instanceId,
      sequence: this.sequence,
      stats: this.stats(),
      records: [...this.records.values()].reverse().map((record) => structuredClone(record)),
    };
  }

  subscribe(update: Subscriber['update'], close: Subscriber['close']): () => void {
    if (this.closed) throw new Error('Traffic feed is shutting down');
    if (this.subscribers.size >= 16) throw new Error('Too many activity subscribers');
    const subscriber = { update, close };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close(): void {
    this.closed = true;
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}

export class TrafficSpan {
  private readonly started = performance.now();
  private outcome: Outcome = 'returned';
  private finished = false;

  constructor(
    private readonly record: TrafficRecord,
    private readonly update: (finished: boolean) => void,
  ) {}

  private phase(phase: TrafficPhase): void {
    if (this.finished || phase === this.record.phase) return;
    this.record.phase = phase;
    if (this.record.stages.length < 12)
      this.record.stages.push({ phase, afterMs: Math.round(performance.now() - this.started) });
    this.update(false);
  }

  authorized(caller: { id: string; tokenId?: string; tokenName?: string }): void {
    this.record.tokenId = caller.tokenId ?? caller.id;
    this.record.tokenName = label(caller.tokenName ?? caller.id);
    this.phase('authorized');
  }

  describe(method: unknown, tool: unknown): void {
    if (typeof method === 'string') this.record.method = label(method);
    if (typeof tool === 'string') this.record.tool = label(tool);
  }

  running(tool?: string, target?: string): void {
    if (tool) this.record.tool = label(tool);
    if (target) this.record.target = label(target);
    this.phase('running');
  }

  waiting(): void {
    this.phase('waiting');
  }

  result(error: boolean): void {
    if (error && this.outcome !== 'denied') this.outcome = 'failed';
  }

  deny(): void {
    this.outcome = 'denied';
  }

  finish(status: number, delivered: boolean): void {
    if (this.finished) return;
    const outcome = !delivered
      ? 'cancelled'
      : status === 401 || status === 403
        ? 'denied'
        : status >= 400
          ? 'failed'
          : this.outcome;
    if (!this.record.tokenId) this.record.tokenName = 'Ключ не распознан';
    this.record.finishedAt = new Date().toISOString();
    this.record.durationMs = Math.round(performance.now() - this.started);
    this.record.httpStatus = status;
    this.record.phase = outcome;
    this.record.stages.push({ phase: outcome, afterMs: this.record.durationMs });
    this.finished = true;
    this.update(true);
  }
}
