import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { allPermissions, parsePermissions, type Permission } from '../permissions.js';
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
  expiresAt: z.string().nullable(),
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

/**
 * Stores shared API tokens.
 *
 * Only hashes are kept on disk, so a leaked data directory cannot be replayed against
 * the server. Each token carries its own permission set and can be rotated or revoked
 * independently of the owner secrets in the environment.
 */
export class TokenStore {
  private readonly writes = new SerialQueue();

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
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
    };
  }

  /** Returns the permissions of a matching token, or undefined when no token matches. */
  find(presented: string): { id: string; permissions: Permission[] } | undefined {
    const digest = hash(presented);
    const record = this.data.tokens.find((candidate) => candidate.tokenHash === digest);
    if (!record || !record.enabled) return undefined;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return { id: record.id, permissions: record.permissions };
  }

  async touch(id: string): Promise<void> {
    const record = this.data.tokens.find((candidate) => candidate.id === id);
    if (!record || record.lastUsedAt === new Date().toISOString()) return;
    await this.writes.run(async () => {
      const draft = structuredClone(this.data);
      const target = draft.tokens.find((candidate) => candidate.id === id);
      if (target) target.lastUsedAt = new Date().toISOString();
      await this.persist(draft);
    });
  }

  async create(input: CreateTokenInput): Promise<IssuedToken> {
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
        expiresAt: input.expiresAt ?? null,
      };
      draft.tokens.push(record);
      await this.persist(draft);
      return { ...this.view(record), token: secret };
    });
  }

  /** Replaces the secret of an existing token, keeping its name and permissions. */
  async rotate(id: string): Promise<IssuedToken> {
    return this.writes.run(async () => {
      const draft = structuredClone(this.data);
      const record = draft.tokens.find((candidate) => candidate.id === id);
      if (!record) throw new Error('Unknown token');
      const secret = token();
      record.tokenHash = hash(secret);
      record.lastUsedAt = null;
      await this.persist(draft);
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
      if (changes.expiresAt !== undefined) record.expiresAt = changes.expiresAt;
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
    });
  }

  /** Permissions pre-selected for a new token in the GUI. */
  static readonly defaultPermissions = allPermissions.filter((value) => value !== 'log');
}
