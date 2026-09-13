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
});

test('every field counts, not only the required ones', () => {
  // Only the name and the objective are `required`, so scoring the required ones alone would
  // report a complete profile while most of the form is still blank.
  const result = computeInputReadiness([
    { value: 'x', verified: true, required: true },
    { value: null, verified: false, required: false },
  ]);
  assert.equal(result.readiness, 50, 'an empty optional field still holds readiness back');
  assert.equal(result.total, 2);
});

test('readiness is 0 when there are no fields at all', () => {
  const result = computeInputReadiness([]);
  assert.equal(result.readiness, 0);
  assert.equal(result.total, 0);
});
