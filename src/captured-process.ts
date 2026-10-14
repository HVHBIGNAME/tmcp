import { spawn } from 'node:child_process';
import { childEnvironment } from './config.js';
import { terminateTree } from './processes.js';
import { abortable } from './utils.js';
import { managedInvocation } from './windows.js';

/** Bounded short-lived workers; cancellation kills the owned process group/job. */
export async function captureProcess(
  executable: string,
  args: string[],
  project: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const invocation = managedInvocation(executable, args, project);
  const child = spawn(invocation[0], invocation[1], {
    cwd: project,
    env: childEnvironment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'pipe',
  });
  child.stdin.end();
  const deadline = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error('Image worker timed out; check desktop permissions and capture dependencies'),
      ),
    20000,
  );
  const chunks: Buffer[] = [];
  let total = 0,
    stderr = '',
    spawnError: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > 6 * 1024 * 1024) deadline.abort(new Error('Image worker output exceeds the limit'));
    else chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  const done = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code)),
  );
  try {
    const code = await abortable(done, cancellation);
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(stderr.trim() || `Image worker failed (${code})`);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    if (cancellation.aborted) await terminateTree(child);
  }
}
