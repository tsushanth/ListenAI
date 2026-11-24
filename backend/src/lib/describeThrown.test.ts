// npm test (node:test via tsx). The failure reporter must never turn a thrown object into "[object Object]".
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const modP = import('./failureReporter.js');

test('describeThrown keeps a real Error as is', async () => {
  const { describeThrown } = await modP;
  const e = new Error('boom');
  assert.equal(describeThrown(e), e);
});

test('describeThrown reads message and code from a PostgREST-style object, not details or hint', async () => {
  const { describeThrown } = await modP;
  const e = describeThrown({ code: '22P02', message: 'invalid input syntax for type uuid: "abc"', details: 'row data', hint: 'private' });
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'invalid input syntax for type uuid: "abc" [22P02]');
  assert.ok(!e.message.includes('row data') && !e.message.includes('private'));
  assert.ok(!e.message.includes('[object Object]'));
});

test('describeThrown handles objects without a message, strings, and other values', async () => {
  const { describeThrown } = await modP;
  assert.equal(describeThrown({ foo: 1 }).message, 'Non-Error object thrown');
  assert.equal(describeThrown({ code: 'X1' }).message, 'Non-Error object thrown [X1]');
  assert.equal(describeThrown('plain text').message, 'plain text');
  assert.equal(describeThrown(undefined).message, 'Non-Error undefined thrown');
  assert.equal(describeThrown(null).message, 'Non-Error object thrown');
  assert.ok(describeThrown({ message: 'x'.repeat(1000) }).message.length <= 300);
});
