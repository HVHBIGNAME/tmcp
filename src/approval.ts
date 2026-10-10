import { z } from 'zod';
import picomatch from 'picomatch';
import { hash } from './utils.js';

export const approvalPolicySchema = z.enum(['never', 'once', 'always', 'match']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

/**
 * Decides whether a command may run without asking the user.
 *
 * `never` denies everything, `once` asks every time, `always` allows everything and
 * `match` asks unless an allowlist rule matches. Rules are matched in order and the
 * first match decides, so a specific rule can be placed above a broad one.
 */
export interface ApprovalRules {
  policy: ApprovalPolicy;
  /** Glob patterns of allowed commands. */
  allow: string[];
  /** Glob patterns that are always denied, checked before allowlist rules. */
  deny: string[];
  /** How long an approved command may run, enforced separately. */
  timeoutMs: number;
}

export type Decision =
  | { action: 'allow'; rule?: string }
  | { action: 'deny'; rule?: string }
  | { action: 'ask'; reason: string };

export const defaultRules: ApprovalRules = {
  policy: 'once',
  allow: [],
  deny: [],
  timeoutMs: 120000,
};

export function decide(rules: ApprovalRules, command: string): Decision {
  const target = command.trim();
  const deny = compile(rules.deny);
  const denied =
    deny(target) ??
    target
      .split(/[\r\n;&|]+/)
      .map((part) => deny(part.trim()))
      .find(Boolean);
  if (denied) return { action: 'deny', rule: denied };
  // Glob rules describe simple commands, not shell syntax. Compound expressions and
  // substitutions require a decision about the whole script instead of its prefix.
  if (/[\r\n;&|`$<>^]/.test(target) && rules.policy !== 'always')
    return rules.policy === 'never'
      ? { action: 'deny' }
      : { action: 'ask', reason: 'Compound commands require approval' };
  const allow = compile(rules.allow);
  const allowed = allow(target);
  switch (rules.policy) {
    case 'never':
      return allowed ? { action: 'allow', rule: allowed } : { action: 'deny' };
    case 'always':
      return { action: 'allow', rule: allowed };
    case 'once':
      return allowed
        ? { action: 'allow', rule: allowed }
        : { action: 'ask', reason: 'No allowlist rule matches this command' };
    case 'match':
      return allowed
        ? { action: 'allow', rule: allowed }
        : { action: 'ask', reason: 'Command is not in the allowlist' };
  }
}

/**
 * Builds a matcher for the rules.
 *
 * An entry without wildcards is matched as a whole command, so `git status` does not
 * also allow `git status --porcelain`. Patterns support `*` anywhere.
 */
export function compile(patterns: readonly string[]): (command: string) => string | undefined {
  const exact = new Map<string, string>();
  const globs: { pattern: string; matches: (value: string) => boolean }[] = [];
  for (const pattern of patterns) {
    if (/[*?[\]]/.test(pattern))
      globs.push({
        pattern,
        matches: picomatch(pattern, { nocase: process.platform === 'win32' }),
      });
    else exact.set(pattern, pattern);
  }
  return (command: string) => {
    if (exact.has(command)) return exact.get(command);
    return globs.find((glob) => glob.matches(command))?.pattern;
  };
}

export function fingerprint(command: string, cwd: string): string {
  return hash(`${cwd}\0${command}`).slice(0, 16);
}

export function summarize(command: string, limit = 160): string {
  const single = command.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}
