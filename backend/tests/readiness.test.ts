import assert from 'node:assert/strict';
import test from 'node:test';
import { computeInputReadiness } from '../src/lib/readiness';

test('input readiness rewards filling and verification separately', () => {
  const empty = computeInputReadiness([{ value: null, verified: false, required: true }]);
  assert.equal(empty.readiness, 0);

  const filled = computeInputReadiness([{ value: 'x', verified: false, required: true }]);
  assert.equal(filled.readiness, 50, 'filled but unverified is half credit');

  const verified = computeInputReadiness([{ value: 'x', verified: true, required: true }]);
  assert.equal(verified.readiness, 100);

  const optionalIgnored = computeInputReadiness([
    { value: 'x', verified: true, required: true },
    { value: null, verified: false, required: false },
  ]);
  assert.equal(optionalIgnored.readiness, 100, 'optional fields do not drag readiness down');
});

test('readiness is 0 when there are no required fields', () => {
  const result = computeInputReadiness([{ value: null, verified: false, required: false }]);
  assert.equal(result.readiness, 0);
  assert.equal(result.total, 0);
});
