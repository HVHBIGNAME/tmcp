import path from 'node:path';

export function windowsPowerShell(): string {
  const root = process.env.SystemRoot;
  if (!root) throw new Error('Windows SystemRoot is not set');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function managedInvocation(
  executable: string,
  args: string[],
  project: string,
): [string, string[]] {
  if (process.platform !== 'win32') return [executable, args];
  return [
    windowsPowerShell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(project, 'scripts', 'windows-job.ps1'),
      '-Executable',
      executable,
      '-ArgumentsBase64',
      Buffer.from(JSON.stringify(args)).toString('base64'),
    ],
  ];
}
