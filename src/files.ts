import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { atomicWrite, hash, isErrno, SerialQueue } from './utils.js';
import type { Workspace } from './workspace.js';

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.mcp-tunnel',
  '.venv',
  'dist',
  'build',
]);
const scanLimit = 20000;

interface WalkEntry {
  path: string;
  relative: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  depth: number;
}

export interface Edit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

export class Files {
  private readonly writes = new SerialQueue();

  constructor(
    readonly workspace: Workspace,
    readonly maxBytes: number,
  ) {}

  async readBytes(input: string, maximum = this.maxBytes): Promise<Buffer> {
    const filename = await this.workspace.resolve(input);
    const handle = await open(filename, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Path must be a regular file');
      if (info.size > maximum) throw new Error(`File exceeds the ${maximum}-byte limit`);
      const data = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maximum || length > info.size) throw new Error('File grew during read; retry');
      return data.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private decode(data: Buffer): string {
    if (data.includes(0)) throw new Error('Binary file; use read_image or run_command');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  }

  async read(input: string, startLine: number, maxLines: number) {
    const filename = await this.workspace.resolve(input);
    const data = await this.readBytes(filename);
    const text = this.decode(data);
    const lines = text ? text.split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const content = selected
      .map((line, index) => `${startLine + index}: ${line.replace(/\r$/, '')}`)
      .join('\n');
    return {
      path: filename,
      sha256: hash(data),
      total_lines: lines.length,
      start_line: startLine,
      next_line: startLine + selected.length <= lines.length ? startLine + selected.length : null,
      content: content.slice(0, 250000),
      truncated: content.length > 250000,
    };
  }

  async info(input: string) {
    const filename = await this.workspace.resolve(input, false);
    const info = await lstat(filename);
    return {
      path: filename,
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
      bytes: info.size,
      modified_at: info.mtime.toISOString(),
    };
  }

  async *walk(input: string, maxDepth: number, includeIgnored: boolean): AsyncGenerator<WalkEntry> {
    const root = await this.workspace.resolve(input);
    const pending = [{ directory: root, depth: 1 }];
    while (pending.length) {
      const { directory, depth } = pending.pop()!;
      // Recheck ancestors in case a directory was replaced with a junction during traversal.
      const safeDirectory = await this.workspace.resolve(directory);
      for (const entry of await readdir(safeDirectory, { withFileTypes: true })) {
        if (!includeIgnored && entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const filename = path.join(safeDirectory, entry.name);
        if (this.workspace.isPrivate(filename)) continue;
        const type = entry.isSymbolicLink()
          ? 'symlink'
          : entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : 'other';
        yield {
          path: filename,
          relative: path.relative(root, filename).split(path.sep).join('/'),
          type,
          depth,
        };
        if (type === 'directory' && depth < maxDepth)
          pending.push({ directory: filename, depth: depth + 1 });
      }
    }
  }

  async list(input: string, depth: number, limit: number, includeIgnored: boolean) {
    const entries: WalkEntry[] = [];
    for await (const entry of this.walk(input, depth, includeIgnored)) {
      if (entries.length === limit) return { entries, truncated: true };
      entries.push(entry);
    }
    return { entries, truncated: false };
  }

  async find(input: string, pattern: string, limit: number, includeIgnored: boolean) {
    const matches = picomatch(pattern, { dot: true, nocase: process.platform === 'win32' });
    const entries: WalkEntry[] = [];
    let scanned = 0;
    for await (const entry of this.walk(input, 100, includeIgnored)) {
      if (++scanned > scanLimit) return { entries, scanned: scanned - 1, truncated: true };
      if (!matches(entry.relative)) continue;
      if (entries.length === limit) return { entries, scanned, truncated: true };
      entries.push(entry);
    }
    return { entries, scanned, truncated: false };
  }

  async search(input: string, query: string, glob: string, caseSensitive: boolean, limit: number) {
    const matches = picomatch(glob, { dot: true, nocase: process.platform === 'win32' });
    const needle = caseSensitive ? query : query.toLowerCase();
    const results: { path: string; line: number; text: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let scanned = 0;
    let skippedCount = 0;
    for await (const entry of this.walk(input, 100, false)) {
      if (++scanned > scanLimit)
        return {
          matches: results,
          skipped,
          skipped_count: skippedCount,
          scanned: scanned - 1,
          truncated: true,
        };
      if (entry.type !== 'file' || !matches(entry.relative)) continue;
      let content: string;
      try {
        content = this.decode(await this.readBytes(entry.path));
      } catch (error) {
        skippedCount++;
        if (skipped.length < 20)
          skipped.push({
            path: entry.path,
            reason: error instanceof Error ? error.message : String(error),
          });
        continue;
      }
      for (const [index, line] of content.split('\n').entries()) {
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
        if (results.length === limit)
          return {
            matches: results,
            skipped,
            skipped_count: skippedCount,
            scanned,
            truncated: true,
          };
        results.push({ path: entry.path, line: index + 1, text: line.slice(0, 2000) });
      }
    }
    return { matches: results, skipped, skipped_count: skippedCount, scanned, truncated: false };
  }

  private checkSize(content: string): void {
    if (Buffer.byteLength(content) > this.maxBytes)
      throw new Error(`Content exceeds ${this.maxBytes} bytes`);
  }

  private async checkHash(filename: string, expected?: string): Promise<void> {
    if (expected && hash(await this.readBytes(filename)) !== expected) {
      throw new Error('File has changed (sha256 mismatch). Read it again before editing');
    }
  }

  async write(
    input: string,
    content: string,
    overwrite: boolean,
    createParents: boolean,
    expected?: string,
  ) {
    this.checkSize(content);
    return this.writes.run(async () => {
      const filename = await this.workspace.resolve(input);
      await this.checkHash(filename, expected);
      if (createParents) await mkdir(path.dirname(filename), { recursive: true });
      if (overwrite) {
        let mode = 0o600;
        try {
          const info = await stat(filename);
          if (!info.isFile()) throw new Error('Cannot overwrite a non-file');
          mode = info.mode;
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
        await atomicWrite(filename, content, mode);
      } else {
        const handle = await open(filename, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
      }
      return { path: filename, bytes: Buffer.byteLength(content), sha256: hash(content) };
    });
  }

  async edit(input: string, edits: Edit[], expected?: string) {
    return this.writes.run(async () => {
      const filename = await this.workspace.resolve(input);
      const original = await this.readBytes(filename);
      if (expected && hash(original) !== expected)
        throw new Error('File has changed (sha256 mismatch)');
      let content = this.decode(original);
      let replacements = 0;
      for (const edit of edits) {
        if (!edit.old_text || edit.old_text === edit.new_text)
          throw new Error('Edits require non-empty, different old_text and new_text');
        const parts = content.split(edit.old_text);
        const count = parts.length - 1;
        if (count === 0)
          throw new Error('old_text was not found; match whitespace and line endings exactly');
        if (count > 1 && !edit.replace_all)
          throw new Error('old_text is ambiguous; add context or set replace_all');
        content = edit.replace_all
          ? parts.join(edit.new_text)
          : content.replace(edit.old_text, () => edit.new_text);
        replacements += edit.replace_all ? count : 1;
        this.checkSize(content);
      }
      await this.checkHash(filename, hash(original));
      await atomicWrite(filename, content, (await stat(filename)).mode);
      return { path: filename, replacements, sha256: hash(content) };
    });
  }

  async makeDirectory(input: string) {
    return this.writes.run(async () => {
      const directory = await this.workspace.resolve(input);
      await mkdir(directory, { recursive: true });
      return { path: directory };
    });
  }

  async move(source: string, destination: string) {
    return this.writes.run(async () => {
      const from = await this.workspace.resolve(source, false);
      const to = await this.workspace.resolve(destination, false);
      this.workspace.assertMutable(from);
      this.workspace.assertMutable(to);
      try {
        await lstat(to);
        throw new Error('Destination already exists');
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      await rename(from, to);
      return { source: from, destination: to };
    });
  }

  async delete(input: string, recursive: boolean) {
    return this.writes.run(async () => {
      const filename = await this.workspace.resolve(input, false);
      this.workspace.assertMutable(filename);
      const info = await lstat(filename);
      if (info.isDirectory() && !recursive) await rmdir(filename);
      else await rm(filename, { recursive, force: false });
      return { deleted: filename };
    });
  }
}
