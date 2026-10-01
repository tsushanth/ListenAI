// npm test (node:test via tsx). The Modal CLI wrapper, driven by a fake process runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import './modalDeploymentsTestEnv.js';
import { createModalCli, redact, ModalCliError, type CliRunner } from './modalCli.js';

interface Seen { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }

function cliWith(handler: (seen: Seen) => { stdout?: string } | never) {
  const seen: Seen[] = [];
  const run: CliRunner = async (file, args, opts) => {
    const s = { file, args, env: opts.env, timeout: opts.timeout };
    seen.push(s);
    return { stdout: '', stderr: '', ...(handler(s) as object) };
  };
  return { seen, cli: createModalCli({ tokenId: 'ak-test', tokenSecret: 'as-very-secret-token', run }) };
}

function failure(stderr: string, extra: Record<string, unknown> = {}): never {
  throw Object.assign(new Error('Command failed'), { stderr, code: 1, ...extra });
}

test('commands are argv arrays, never shell strings, and carry the Modal credentials', async () => {
  const { seen, cli } = cliWith(() => ({}));
  await cli.secretCreate('voice-convert-user-1', 'CONVERT_SECRET', 'val ue; rm -rf /');
  await cli.appStop('voice-convert-dev-user-1');
  await cli.volumeDelete('vol');
  await cli.secretDelete('sec');
  await cli.deploy('modal/convert_job.py', { VOICE_CONVERT_APP_SUFFIX: '-user-1' }, 123_000);

  assert.deepEqual(seen.map((s) => s.file), ['modal', 'modal', 'modal', 'modal', 'modal']);
  assert.deepEqual(seen[0].args, ['secret', 'create', 'voice-convert-user-1', 'CONVERT_SECRET=val ue; rm -rf /', '--force'], 'one argv entry, not interpolated');
  assert.deepEqual(seen[1].args, ['app', 'stop', 'voice-convert-dev-user-1']);
  assert.deepEqual(seen[2].args, ['volume', 'delete', 'vol', '--yes', '--allow-missing']);
  assert.deepEqual(seen[3].args, ['secret', 'delete', 'sec', '--yes', '--allow-missing']);
  assert.deepEqual(seen[4].args, ['deploy', 'modal/convert_job.py']);
  assert.equal(seen[4].env.VOICE_CONVERT_APP_SUFFIX, '-user-1');
  assert.equal(seen[4].timeout, 123_000);
  assert.equal(seen[0].env.MODAL_TOKEN_ID, 'ak-test');
  assert.equal(seen[0].env.MODAL_TOKEN_SECRET, 'as-very-secret-token');
});

test('errors never contain the per-user secret or the Modal token', async () => {
  const { cli } = cliWith(() =>
    failure('Error: bad request for CONVERT_SECRET=topsecretvalue99 using token as-very-secret-token'),
  );
  await assert.rejects(
    () => cli.secretCreate('n', 'CONVERT_SECRET', 'topsecretvalue99'),
    (err: Error) => {
      assert.ok(err instanceof ModalCliError);
      assert.equal(err.message.includes('topsecretvalue99'), false);
      assert.equal(err.message.includes('as-very-secret-token'), false);
      assert.match(err.message, /\[redacted\]/);
      return true;
    },
  );
});

test('stopping or deleting something that is already gone is not an error', async () => {
  const { cli } = cliWith(() => failure('Error: App voice-convert-dev-user-1 not found'));
  await cli.appStop('voice-convert-dev-user-1'); // resolves
  await cli.secretDelete('x');
  await cli.volumeDelete('x');
});

test('other failures are errors, and a timeout is described as one', async () => {
  const a = cliWith(() => failure('Error: rate limited'));
  await assert.rejects(() => a.cli.appStop('x'), /rate limited/);
  const b = cliWith(() => failure('', { killed: true }));
  await assert.rejects(() => b.cli.deploy('f.py', {}, 1000), /timed out/);
});

test('a failed deploy of something not found is flagged so callers can tell', async () => {
  const { cli } = cliWith(() => failure('Error: file modal/nope.py not found'));
  await assert.rejects(
    () => cli.deploy('modal/nope.py', {}, 1000),
    (err: ModalCliError) => err.notFound === true,
  );
});

test('appList parses Modal JSON into id, name and state', async () => {
  const { cli, seen } = cliWith(() => ({
    stdout: JSON.stringify([
      { 'App ID': 'ap-1', Description: 'voice-convert-dev-user-aaaaaaaa-0001', State: 'deployed', Tasks: '0' },
      { 'App ID': 'ap-2', Description: 'realtime-tts-worker', State: 'stopped', Tasks: '0' },
    ]),
  }));
  assert.deepEqual(await cli.appList(), [
    { id: 'ap-1', name: 'voice-convert-dev-user-aaaaaaaa-0001', state: 'deployed' },
    { id: 'ap-2', name: 'realtime-tts-worker', state: 'stopped' },
  ]);
  assert.deepEqual(seen[0].args, ['app', 'list', '--json']);
});

test('appList rejects output that is not JSON instead of returning nothing', async () => {
  const { cli } = cliWith(() => ({ stdout: 'Error: please log in' }));
  await assert.rejects(() => cli.appList(), /not JSON/);
});

test('redact ignores very short strings so it cannot blank out ordinary words', () => {
  assert.equal(redact('abc def', ['ab', '']), 'abc def');
  assert.equal(redact('token=abcdef1234', ['abcdef1234']), 'token=[redacted]');
});
