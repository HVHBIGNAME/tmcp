import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isErrno } from './utils.js';

export class Workspace {
  private constructor(readonly roots: string[]) {}

  static async open(roots: string[]): Promise<Workspace> {
    const canonical = await Promise.all(
      roots.map(async (root) => {
        const resolved = await realpath(root);
        if (!(await stat(resolved)).isDirectory()) {
          throw new Error(`Workspace root is not a directory: ${root}`);
        }
        return resolved;
      }),
    );
    if (!canonical.length) throw new Error('At least one workspace root is required');
    return new Workspace([...new Set(canonical)]);
  }

  contains(candidate: string): boolean {
    return this.roots.some((root) => {
      const relative = path.relative(root, candidate);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    });
  }

  assertMutable(candidate: string): void {
    if (
      this.roots.some((root) => {
        const relative = path.relative(candidate, root);
        return (
          relative === '' ||
          (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      })
    ) {
      throw new Error('A workspace root cannot be deleted or moved');
    }
  }

  async resolve(input: string, followLeaf = true): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('Invalid path');
    if (process.platform === 'win32') {
      const withoutDrive = input.replace(/^[A-Za-z]:[\\/]/, '');
      if (
        /^[\\/]{2}/.test(input) ||
        /[:*?"<>|]/.test(withoutDrive) ||
        /[. ]([\\/]|$)/.test(withoutDrive.replace(/^\.([\\/]|$)/, ''))
      ) {
        // Reject device/UNC paths, ADS, drive-relative paths, and Win32 name normalization aliases.
        throw new Error('Unsupported Windows path (device, UNC, ADS or ambiguous name)');
      }
      if (
        withoutDrive
          .split(/[\\/]/)
          .some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
      ) {
        throw new Error('Windows device names are not file paths');
      }
    }
    const absolute = path.resolve(this.roots[0]!, input);
    if (!this.contains(absolute)) throw new Error('Path is outside MCP_ROOTS');
    if (!followLeaf && !this.roots.some((root) => path.relative(root, absolute) === '')) {
      const parent = await this.resolve(path.dirname(absolute));
      return path.join(parent, path.basename(absolute));
    }
    let ancestor = absolute;
    const missing: string[] = [];
    for (;;) {
      try {
        const canonical = path.join(await realpath(ancestor), ...missing.reverse());
        if (!this.contains(canonical)) throw new Error('Symlink or junction escapes MCP_ROOTS');
        return canonical;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        try {
          if ((await lstat(ancestor)).isSymbolicLink())
            throw new Error('Dangling symlinks are not allowed');
        } catch (statError) {
          if (!isErrno(statError, 'ENOENT')) throw statError;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
}
