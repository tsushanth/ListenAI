// Thin wrapper over the `modal` CLI (installed in the backend image, see Dockerfile). Everything the
// deployment manager needs from Modal goes through the ModalCli interface so tests can substitute a fake
// and so no other file builds shell commands.
//
// Differences from the helpers this replaces (voiceConvert.ts / voiceIsolate.ts):
//  - arguments are passed as an array to execFile, never interpolated into a shell string;
//  - errors are scrubbed of secret values before they are thrown, because the old code logged the raw
//    exec error, which contains the whole command line including the per-user secret;
//  - secret and volume deletion exist, so teardown no longer leaks them.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ModalApp {
  id: string;
  name: string;
  state: string;
}

export interface ModalCli {
  secretCreate(name: string, key: string, value: string): Promise<void>;
  secretDelete(name: string): Promise<void>;
  /** Deploys `file` (path relative to the backend working directory) with the given environment overrides. */
  deploy(file: string, env: Record<string, string>, timeoutMs: number): Promise<void>;
  appStop(appName: string): Promise<void>;
  appList(): Promise<ModalApp[]>;
  volumeDelete(name: string): Promise<void>;
}

export type CliRunner = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export class ModalCliError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message);
    this.name = 'ModalCliError';
  }
}

const NOT_FOUND = /not found|does not exist|no such|could not find|no app/i;

/** Replace every occurrence of each secret in `text` so it can be logged or stored. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out;
}

export interface CreateModalCliOptions {
  tokenId?: string;
  tokenSecret?: string;
  cwd?: string;
  run?: CliRunner;
}

export function createModalCli(options: CreateModalCliOptions = {}): ModalCli {
  const run: CliRunner = options.run ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }));

  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    MODAL_TOKEN_ID: options.tokenId || '',
    MODAL_TOKEN_SECRET: options.tokenSecret || '',
    MODAL_SERVER_URL: 'https://api.modal.com',
  });

  async function exec(
    args: string[],
    opts: { timeout?: number; env?: Record<string, string>; scrub?: string[]; allowMissing?: boolean } = {},
  ): Promise<string> {
    const scrub = [options.tokenSecret || '', ...(opts.scrub ?? [])];
    try {
      const { stdout } = await run('modal', args, {
        env: { ...baseEnv(), ...(opts.env ?? {}) },
        timeout: opts.timeout ?? 60_000,
        cwd: options.cwd,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean; code?: number | string };
      const tail = redact(String(e.stderr || e.stdout || e.message || 'unknown error'), scrub).trim().slice(-400);
      const notFound = NOT_FOUND.test(tail);
      if (notFound && opts.allowMissing) return '';
      const reason = e.killed ? 'timed out' : `exit ${e.code ?? '?'}`;
      throw new ModalCliError(`modal ${args[0]} ${args[1] ?? ''} failed (${reason}): ${tail}`.trim(), notFound);
    }
  }

  return {
    async secretCreate(name, key, value) {
      // Modal's CLI takes KEY=VALUE pairs. execFile passes it as one argv entry, so no shell can interpret it.
      await exec(['secret', 'create', name, `${key}=${value}`, '--force'], { scrub: [value] });
    },
    async secretDelete(name) {
      await exec(['secret', 'delete', name, '--yes', '--allow-missing'], { allowMissing: true });
    },
    async deploy(file, env, timeoutMs) {
      await exec(['deploy', file], { env, timeout: timeoutMs });
    },
    async appStop(appName) {
      await exec(['app', 'stop', appName], { allowMissing: true });
    },
    async appList() {
      const out = await exec(['app', 'list', '--json']);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = JSON.parse(out || '[]');
      } catch {
        throw new ModalCliError('modal app list returned output that is not JSON');
      }
      return rows.map((r) => ({
        id: String(r['App ID'] ?? ''),
        name: String(r['Description'] ?? ''),
        state: String(r['State'] ?? ''),
      }));
    },
    async volumeDelete(name) {
      await exec(['volume', 'delete', name, '--yes', '--allow-missing'], { allowMissing: true });
    },
  };
}
