/**
 * Permission catalogue.
 *
 * A token grants a subset of these. `admin` is implicit for the owner secrets and
 * cannot be granted to shared tokens: it exposes credential rotation and shutdown.
 */
export const permissions = [
  'files:read',
  'files:write',
  'shell',
  'screen',
  'gateway',
  'log',
] as const;

export type Permission = (typeof permissions)[number];

const permissionSet = new Set<string>(permissions);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}

export function parsePermissions(values: readonly string[]): Permission[] {
  const parsed: Permission[] = [];
  for (const value of values) {
    if (!isPermission(value)) throw new Error(`Unknown permission: ${value}`);
    if (!parsed.includes(value)) parsed.push(value);
  }
  return parsed;
}

export const allPermissions: Permission[] = [...permissions];

/** Human-readable labels for the GUI. */
export const permissionLabels: Record<Permission, string> = {
  'files:read': 'Read files',
  'files:write': 'Create and modify files',
  shell: 'Run commands',
  screen: 'Screenshots',
  gateway: 'Connected MCP servers',
  log: 'Audit log',
};
