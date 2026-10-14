import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export function token(): string {
  return randomBytes(32).toString('base64url');
}

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function secretEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function atomicWrite(
  filename: string,
  content: string | Buffer,
  mode = 0o600,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${token()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // The caller receives the rejection; the next operation must still be able to run.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
