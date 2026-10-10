import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parsePermissions, type Permission } from '../permissions.js';
import { atomicWrite, hash, isErrno, SerialQueue, token } from '../utils.js';

const recordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  /** SHA-256 of the token. The plaintext is returned once, at creation or rotation. */
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z.array(z.enum(['files:read', 'files:write', 'shell', 'screen', 'gateway', 'log'])),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

const storeSchema = z.object({ version: z.literal(1), tokens: z.array(recordSchema) });
type TokenRecord = z.infer<typeof recordSchema>;
type StoreData = z.infer<typeof storeSchema>;

export interface TokenView {
  id: string;
  name: string;
  permissions: Permission[];
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface IssuedToken extends TokenView {
  token: string;
}

export interface CreateTokenInput {
  name: string;
  permissions: string[];
  enabled?: boolean;
  expiresAt?: string | null;
}

/** Shared-token hashes, permissions and revocation state. */
export class TokenStore {
  private readonly writes = new SerialQueue();
  private readonly usage = new Map<string, string>();
  private nextUsageWrite = 0;

  private constructor(
    private readonly filename: string,
    private data: StoreData,
  ) {}

  static async open(dataDir: string): Promise<TokenStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, 'tokens.json');
    let data: StoreData;
    try {
      data = storeSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (!isErrno(error, 'ENOENT'))
        throw new Error('Cannot read the token store', { cause: error });
      data = { version: 1, tokens: [] };
    }
    return new TokenStore(filename, data);
  }

  private async persist(draft: StoreData): Promise<void> {
    await atomicWrite(this.filename, JSON.stringify(draft));
    this.data = draft;
  }

  list(): TokenView[] {
    return this.data.tokens.map((record) => this.view(record));
  }

  private view(record: TokenRecord): TokenView {
    return {
      id: record.id,
      name: record.name,
      permissions: [...record.permissions],
      enabled: record.enabled,
      createdAt: record.createdAt,
      lastUsedAt: this.usage.get(record.id) ?? record.lastUsedAt,
      expiresAt: record.expiresAt,
    };
  }

  /** Returns the permissions of a matching token, or undefined when no token matches. */
  find(presented: string): { id: string; permissions: Permission[] } | undefined {
    const digest = hash(presented);
    const record = this.data.tokens.find((candidate) => candidate.tokenHash === digest);
    if (!record) return undefined;
    const permissions = this.active(record);
    return permissions ? { id: record.id, permissions } : undefined;
  }

  /**
   * Re-checks a token an OAuth grant is bound to.
   *
   * A grant outlives the browser session that created it, so pausing, rotating or
   * deleting the token has to stop it here as well.
   */
  activeById(id: string, tokenHash: string): Permission[] | undefined {
    const record = this.data.tokens.find((candidate) => candidate.id === id);
    if (!record || record.tokenHash !== tokenHash) return undefined;
    return this.active(record);
  }

  private active(record: TokenRecord): Permission[] | undefined {
    if (!record.enabled) return undefined;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return [...record.permissions];
  }

  async touch(id: string): Promise<void> {
    const record = this.data.tokens.find((candidate) => candidate.id === id);
    if (!record) return;
    this.usage.set(id, new Date().toISOString());
    if (Date.now() < this.nextUsageWrite) return;
    this.nextUsageWrite = Date.now() + 30000;
    try {
      await this.flushUsage();
    } catch (error) {
      this.nextUsageWrite = 0;
      throw error;
    }
  }

  flushUsage(): Promise<void> {
    return this.writes.run(async () => {
      if (!this.usage.size) return;
      const updates = new Map(this.usage);
      const draft = structuredClone(this.data);
      for (const target of draft.tokens) {
        const at = updates.get(target.id);
        if (at) target.lastUsedAt = at;
      }
      await this.persist(draft);
      for (const [id, at] of updates) if (this.usage.get(id) === at) this.usage.delete(id);
    });
  }

  async create(input: CreateTokenInput): Promise<IssuedToken> {
    const expiresAt = recordSchema.shape.expiresAt.parse(input.expiresAt ?? null);
    const permissions = parsePermissions(input.permissions);
    if (!permissions.length) throw new Error('A token needs at least one permission');
    const name = input.name.trim();
    if (!name) throw new Error('A token needs a name');
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      if (draft.tokens.some((candidate) => candidate.name === name))
        throw new Error('A token with this name already exists');
      if (draft.tokens.length >= 64) throw new Error('Token limit reached');
      const secret = token();
      const record: TokenRecord = {
        id: randomUUID(),
        name,
        tokenHash: hash(secret),
        permissions,
        enabled: input.enabled ?? true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt,
      };
      draft.tokens.push(record);
      await this.persist(draft);
      return { ...this.view(record), token: secret };
    });
  }

  async rotate(id: string): Promise<IssuedToken> {
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      const record = draft.tokens.find((candidate) => candidate.id === id);
      if (!record) throw new Error('Unknown token');
      const secret = token();
      record.tokenHash = hash(secret);
      record.lastUsedAt = null;
      await this.persist(draft);
      this.usage.delete(id);
      return { ...this.view(record), token: secret };
    });
  }

  async update(
    id: string,
    changes: { permissions?: string[]; enabled?: boolean; expiresAt?: string | null },
  ): Promise<TokenView> {
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      const record = draft.tokens.find((candidate) => candidate.id === id);
      if (!record) throw new Error('Unknown token');
      if (changes.permissions) record.permissions = parsePermissions(changes.permissions);
      if (changes.enabled !== undefined) record.enabled = changes.enabled;
      if (changes.expiresAt !== undefined)
        record.expiresAt = recordSchema.shape.expiresAt.parse(changes.expiresAt);
      await this.persist(draft);
      return this.view(record);
    });
  }

  async remove(id: string): Promise<void> {
    await this.writes.run(async () => {
      const draft = structuredClone(this.data);
      if (!draft.tokens.some((candidate) => candidate.id === id)) throw new Error('Unknown token');
      draft.tokens = draft.tokens.filter((candidate) => candidate.id !== id);
      await this.persist(draft);
      this.usage.delete(id);
    });
  }

  /** Permissions pre-selected for a new token in the GUI. */
  static readonly defaultPermissions: readonly Permission[] = ['files:read'];
}
