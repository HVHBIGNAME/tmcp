import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { childEnvironment, type Config } from './config.js';
import { errorMessage, isErrno } from './utils.js';
import type { Workspace } from './workspace.js';
import { managedInvocation, windowsPowerShell } from './windows.js';
import path from 'node:path';

export type Shell = 'powershell' | 'cmd' | 'bash' | 'sh';

export function shellInvocation(command: string, shell: Shell): [string, string[]] {
  if (shell === 'powershell') {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $global:LASTEXITCODE=0;\n${command}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    return [
      process.platform === 'win32' ? windowsPowerShell() : 'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    ];
  }
  if (shell === 'cmd')
    return [
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', command],
    ];
  return [shell, ['-lc', command]];
}

export async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      await promisify(execFile)('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        timeout: 10000,
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    return;
  }
  // POSIX descendants can retain the group and stdio after their leader has exited.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return;
    throw error;
  }
  await delay(500);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
  }
}

class OutputWindow {
  private text = '';
  private end = 0;
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly maximum: number) {}

  append(data: Buffer): void {
    this.push(this.decoder.write(data));
  }
  finish(): void {
    this.push(this.decoder.end());
  }

  private push(text: string): void {
    this.end += text.length;
    const joined = this.text + text;
    let start = Math.max(0, joined.length - this.maximum);
    if (
      /[\uDC00-\uDFFF]/.test(joined[start] ?? '') &&
      /[\uD800-\uDBFF]/.test(joined[start - 1] ?? '')
    )
      start++;
    this.text = joined.slice(start);
  }

  read(cursor: number) {
    const start = this.end - this.text.length;
    const from = Math.max(start, Math.min(cursor, this.end));
    let end = Math.min(this.text.length, from - start + 40000);
    if (
      /[\uD800-\uDBFF]/.test(this.text[end - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(this.text[end] ?? '')
    )
      end--;
    const output = this.text.slice(from - start, end);
    return {
      text: output,
      cursor: from + output.length,
      truncated: cursor < start,
      more: from + output.length < this.end,
    };
  }
}

type Status = 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out';

interface Job {
  id: string;
  owner: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  stdout: OutputWindow;
  stderr: OutputWindow;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  status: Status;
  stopping?: 'stopped' | 'timed_out';
  stdinBusy?: boolean;
  done: Promise<void>;
}

export interface RunOptions {
  command: string;
  cwd: string;
  shell?: Shell;
  timeout_ms?: number;
  wait_ms: number;
  keep_stdin: boolean;
  signal?: AbortSignal;
}

export class Processes {
  private readonly jobs = new Map<string, Job>();
  private closing = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly config: Config,
  ) {}

  get defaultShell(): Shell {
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }

  get supportedShells(): Shell[] {
    return process.platform === 'win32' ? ['powershell', 'cmd'] : ['bash', 'sh'];
  }

  private prune(): void {
    for (const [id, job] of this.jobs) {
      if (
        job.finishedAt &&
        (Date.parse(job.finishedAt) < Date.now() - 3600000 || this.jobs.size >= 100)
      )
        this.jobs.delete(id);
    }
  }

  async run(owner: string, options: RunOptions) {
    options.signal?.throwIfAborted();
    if (!this.config.shellEnabled) throw new Error('Shell tools are disabled');
    const cwd = await this.workspace.resolve(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
    this.prune();
    if (this.closing) throw new Error('Server is shutting down');
    if ([...this.jobs.values()].filter((job) => job.status === 'running').length >= 8)
      throw new Error('Maximum of 8 running commands reached');
    const shell = options.shell ?? this.defaultShell;
    if (!this.supportedShells.includes(shell))
      throw new Error(
        `Unsupported shell on ${process.platform}; use ${this.supportedShells.join(' or ')}`,
      );
    if (process.platform === 'win32' && options.command.length > 6000)
      throw new Error(
        'Windows command exceeds 6000 characters; write a script with write_file and execute that file',
      );
    const [executable, args] = shellInvocation(options.command, shell);
    options.signal?.throwIfAborted();
    const invocation = managedInvocation(executable, args, this.config.projectDir);
    const child = spawn(invocation[0], [...invocation[1]], {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
      env: { ...childEnvironment(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let finish!: () => void;
    const job: Job = {
      id: randomUUID(),
      owner,
      command: options.command,
      cwd,
      child,
      stdout: new OutputWindow(this.config.maxOutputChars),
      stderr: new OutputWindow(this.config.maxOutputChars),
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.jobs.set(job.id, job);
    child.stdout.on('data', (chunk: Buffer) => job.stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => job.stderr.append(chunk));
    child.on('error', (error) => {
      job.error = errorMessage(error);
    });
    child.stdin.on('error', (error: Error) => {
      if (!isErrno(error, 'EPIPE') && !isErrno(error, 'ERR_STREAM_DESTROYED'))
        job.error = errorMessage(error);
    });
    let groupCleanup: Promise<void> | undefined;
    child.once('exit', () => {
      if (process.platform !== 'win32')
        groupCleanup = terminateTree(child).catch((error) => {
          job.error = `Unable to terminate remaining process group: ${errorMessage(error)}`;
        });
    });
    const timer = setTimeout(() => {
      void this.stopJob(job, 'timed_out').catch((error: unknown) => {
        job.error = `Unable to terminate process: ${errorMessage(error)}`;
      });
    }, options.timeout_ms ?? this.config.commandTimeoutMs);
    timer.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        await groupCleanup;
        job.stdout.finish();
        job.stderr.finish();
        job.exitCode = code;
        job.signal = signal;
        job.finishedAt = new Date().toISOString();
        job.status = job.stopping ?? (job.error || code !== 0 ? 'failed' : 'exited');
        finish();
      })();
    });
    if (!options.keep_stdin) child.stdin.end();
    const cancel = () => {
      void this.stopJob(job, 'stopped').catch((error) => {
        job.error = errorMessage(error);
      });
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (options.signal?.aborted) cancel();
      return await this.read(owner, job.id, 0, 0, options.wait_ms, options.signal);
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  private owned(owner: string, id: string): Job {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('Unknown command ID for this client');
    return job;
  }

  private metadata(job: Job) {
    return {
      job_id: job.id,
      command: job.command.slice(0, 2000),
      command_truncated: job.command.length > 2000,
      cwd: job.cwd,
      pid: job.child.pid,
      status: job.status,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      exit_code: job.exitCode,
      signal: job.signal,
      error: job.error,
    };
  }

  async read(
    owner: string,
    id: string,
    stdoutCursor: number,
    stderrCursor: number,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const job = this.owned(owner, id);
    if (job.status === 'running' && waitMs > 0) {
      const controller = new AbortController();
      try {
        await Promise.race([
          job.done,
          delay(waitMs, undefined, {
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          }),
        ]);
      } finally {
        controller.abort();
      }
    }
    const stdout = job.stdout.read(stdoutCursor);
    const stderr = job.stderr.read(stderrCursor);
    return {
      ...this.metadata(job),
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_cursor: stdout.cursor,
      stderr_cursor: stderr.cursor,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      stdout_more: stdout.more,
      stderr_more: stderr.more,
    };
  }

  list(owner: string) {
    this.prune();
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .map((job) => this.metadata(job));
  }

  /** Only the protected IPC control API may list jobs across clients. */
  listAll() {
    this.prune();
    return [...this.jobs.values()].map((job) => this.metadata(job));
  }

  async input(owner: string, id: string, text: string, end: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const job = this.owned(owner, id);
    if (job.status !== 'running' || job.child.stdin.writableEnded || job.child.stdin.destroyed)
      throw new Error('stdin is closed; start with keep_stdin=true');
    if (job.stdinBusy)
      throw new Error(
        'A stdin write is still pending; read the command status before sending more input',
      );
    job.stdinBusy = true;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            'stdin write timed out; the command may not be reading input. Do not resend without checking its state.',
          ),
        );
      }, 10000);
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const cleanup = () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      job.child.stdin.write(text, 'utf8', (error) => {
        job.stdinBusy = false;
        cleanup();
        if (error) reject(error);
        else resolve();
      });
    });
    if (end) job.child.stdin.end();
    return { job_id: id, stdin_closed: end };
  }

  private async stopJob(job: Job, reason: 'stopped' | 'timed_out') {
    if (job.status !== 'running' || job.stopping) return;
    job.stopping = reason;
    try {
      await terminateTree(job.child);
    } catch (error) {
      job.stopping = undefined;
      throw error;
    }
  }

  async stop(owner: string, id: string) {
    const job = this.owned(owner, id);
    await this.stopJob(job, 'stopped');
    return this.read(owner, id, 0, 0, 1000);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const stopped = await Promise.allSettled(
      [...this.jobs.values()].map((job) => this.stopJob(job, 'stopped')),
    );
    const errors = stopped.filter((result) => result.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        'Could not stop all command processes',
      );
    const deadline = new AbortController();
    try {
      await Promise.race([
        Promise.all([...this.jobs.values()].map((job) => job.done)),
        delay(3000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error('Command shutdown timed out');
        }),
      ]);
    } finally {
      deadline.abort();
    }
  }
}
