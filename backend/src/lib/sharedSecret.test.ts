import test from 'node:test';
import assert from 'node:assert/strict';
import { secretMatches } from './sharedSecret.js';

test('secretMatches: equal strings match', () => {
  assert.equal(secretMatches('s3cret', 's3cret'), true);
});

test('secretMatches: wrong value, different length, empty and non-string credentials do not match', () => {
  assert.equal(secretMatches('nope', 's3cret'), false);
  assert.equal(secretMatches('s3cret-extra', 's3cret'), false);
  assert.equal(secretMatches('', 's3cret'), false);
  assert.equal(secretMatches(undefined, 's3cret'), false);
  assert.equal(secretMatches(['s3cret'], 's3cret'), false);
});

test('secretMatches: fails closed when the configured secret is unset or empty (undefined must not equal undefined)', () => {
  assert.equal(secretMatches(undefined, undefined), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('anything', undefined), false);
  assert.equal(secretMatches('anything', ''), false);
  assert.equal(secretMatches('anything', null), false);
});
