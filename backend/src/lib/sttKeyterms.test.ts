// npm test (node:test via tsx). Parsing of the keyterms / dictionary request parameter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyterms } from './sttKeyterms.js';

test('accepts repeated values, comma/newline lists and JSON arrays; dedupes preserving order', () => {
  assert.deepEqual(parseKeyterms(['A', 'B, C\nD', '["E","A"]', 'B'], { maxTerms: 100 }), { terms: ['A', 'B', 'C', 'D', 'E'] });
});

test('keeps a term containing a comma when it arrives as its own repeated value only if no list separator is intended', () => {
  // JSON array form is the unambiguous way to send a term containing commas.
  assert.deepEqual(parseKeyterms(['["Smith, J.","Okonkwo"]'], { maxTerms: 10 }), { terms: ['Smith, J.', 'Okonkwo'] });
});

test('strips control characters, trims, drops empties and over-long terms are truncated to 100 chars', () => {
  const r = parseKeyterms(['  ok\u0000term  ', '', ' ', 'x'.repeat(300)], { maxTerms: 10 });
  assert.equal('terms' in r && r.terms[0], 'ok term');
  assert.equal('terms' in r && r.terms[1]!.length, 100);
});

test('over the term limit -> error', () => {
  const r = parseKeyterms(['a,b,c,d'], { maxTerms: 3 });
  assert.ok('error' in r && /keyterms/i.test(r.error));
});

test('empty input -> no terms', () => {
  assert.deepEqual(parseKeyterms([], { maxTerms: 3 }), { terms: [] });
  assert.deepEqual(parseKeyterms([undefined, null, 5 as unknown as string], { maxTerms: 3 }), { terms: [] });
});
