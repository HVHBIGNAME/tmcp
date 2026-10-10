import path from 'node:path';

export function windowsPowerShell(): string {
  const root = process.env.SystemRoot;
  if (!root) throw new Error('Windows SystemRoot is not set');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
