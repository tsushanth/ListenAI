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

test('credentials are only overridden when given, so a locally logged-in profile keeps working', async () => {
  const seen: Seen[] = [];
  const run: CliRunner = async (file, args, opts) => { seen.push({ file, args, env: opts.env, timeout: opts.timeout }); return { stdout: '', stderr: '' }; };
  const before = { id: process.env.MODAL_TOKEN_ID, secret: process.env.MODAL_TOKEN_SECRET };
  process.env.MODAL_TOKEN_ID = 'from-profile-id';
  process.env.MODAL_TOKEN_SECRET = 'from-profile-secret';
  try {
    await createModalCli({ run }).appStop('x'); // no tokens passed
    assert.equal(seen[0].env.MODAL_TOKEN_ID, 'from-profile-id');
    assert.equal(seen[0].env.MODAL_TOKEN_SECRET, 'from-profile-secret');
    await createModalCli({ run, tokenId: 'explicit-id', tokenSecret: 'explicit-secret' }).appStop('x');
    assert.equal(seen[1].env.MODAL_TOKEN_ID, 'explicit-id');
  } finally {
    if (before.id === undefined) delete process.env.MODAL_TOKEN_ID; else process.env.MODAL_TOKEN_ID = before.id;
    if (before.secret === undefined) delete process.env.MODAL_TOKEN_SECRET; else process.env.MODAL_TOKEN_SECRET = before.secret;
  }
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

// ---------------------------------------------------------------------------------------------
// Review findings: a usage error must never be mistaken for "already gone"
// ---------------------------------------------------------------------------------------------

test('a CLI usage error (renamed flag or command) is a failure, not "already gone": otherwise a failed stop reads as success', async () => {
  // The CLI is not version-pinned; if it ever renames --allow-missing, Click says "No such option". That must surface.
  for (const stderr of [
    'Error: No such option: --allow-missing',
    "Error: No such command 'delete'.",
    'Usage: modal secret delete [OPTIONS] NAME\nTry \'modal secret delete -h\' for help.\nError: Missing argument NAME',
  ]) {
    const { cli } = cliWith(() => failure(stderr));
    await assert.rejects(() => cli.secretDelete('x'), ModalCliError, `secretDelete swallowed: ${stderr.slice(0, 40)}`);
    await assert.rejects(() => cli.volumeDelete('x'), ModalCliError, `volumeDelete swallowed: ${stderr.slice(0, 40)}`);
    await assert.rejects(() => cli.appStop('x'), ModalCliError, `appStop swallowed: ${stderr.slice(0, 40)}`);
  }
});

test('"not found" about the thing being deleted is still tolerated (idempotent teardown)', async () => {
  for (const stderr of ["Error: App 'voice-convert-dev-user-1' not found", 'Secret does not exist', 'Volume foo could not be found']) {
    const { cli } = cliWith(() => failure(stderr));
    await cli.appStop('x');
    await cli.secretDelete('x');
    await cli.volumeDelete('x');
  }
});

test('appList that returns rows but no recognisable names throws, so a renamed JSON key cannot silently disable the orphan sweep', async () => {
  const renamed = cliWith(() => ({ stdout: JSON.stringify([{ app_id: 'ap-1', name: 'voice-convert-dev-user-aaaaaaaa-0001', state: 'deployed' }]) }));
  await assert.rejects(() => renamed.cli.appList(), /unexpected|recogni[sz]/i);
  const empty = cliWith(() => ({ stdout: '[]' }));
  assert.deepEqual(await empty.cli.appList(), [], 'an empty workspace is fine');
});
