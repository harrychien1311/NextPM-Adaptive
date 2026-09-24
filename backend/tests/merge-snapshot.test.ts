import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSnapshot, type PreviousSnapshot } from '../src/lib/merge-snapshot';
import type { PlanChangeImpact } from '../src/modules/ai/provider';

/**
 * A bad merge produces a snapshot that looks entirely normal on every screen — the gap list is just
 * missing one entry, or the overview quietly has two "scope" blocks. There is nothing to notice at
 * runtime, which is exactly why this is the thing worth testing.
 */

const previous: PreviousSnapshot = {
  summary: 'An SI project for a Korean telco.',
  overview: [
    { key: 'scope', label: 'Scope', summary: 'Two modules.', points: ['Billing', 'Ordering'] },
    { key: 'schedule', label: 'Schedule', summary: 'Go-live 31/03/2027.', points: ['UAT in January'] },
    { key: 'resources', label: 'Resources', summary: '5 FTE.', points: ['One architect'] },
  ],
  gaps: [
    { title: 'No escalation path', why: 'Nobody decides.', documentName: 'Change / Escalation Flow', severity: 'HIGH' },
    { title: 'No org chart', why: 'No named roles.', documentName: 'Organization Chart', severity: 'MEDIUM' },
    { title: 'No glossary', why: 'Terms differ.', documentName: null, severity: 'LOW' },
  ],
  findings: [{ title: 'Date mismatch', detail: 'Two files disagree.', evidence: [] }],
  approaches: [
    {
      approach: 'SCRUM',
      score: 57,
      reasons: ['Requirements are still moving.'],
      evidence: [],
      criteria: [{ name: 'Requirement stability', score: 40, weight: 20, note: 'Moving.' }],
    },
    { approach: 'HYBRID', score: 51, reasons: [], evidence: [], criteria: [] },
  ],
};

function impact(overrides: Partial<PlanChangeImpact> = {}): PlanChangeImpact {
  return {
    summary: 'Go-live moved to June and a payments module was added.',
    changedOverview: [],
    newGaps: [],
    closedGaps: [],
    newFindings: [],
    approach: { stillFits: true, score: 54, note: 'Still fits, slightly worse.', suggested: null },
    affectedDocuments: [],
    provider: 'anthropic',
    ...overrides,
  };
}

test('an unchanged block keeps its place and its content', () => {
  const merged = mergeSnapshot(previous, impact({
    changedOverview: [
      { key: 'schedule', label: 'Schedule', previous: 'Go-live 31/03/2027.', summary: 'Go-live 30/06/2027.', points: ['UAT in April'] },
    ],
  }));

  assert.deepEqual(
    merged.overview.map((block) => block.key),
    ['scope', 'schedule', 'resources'],
    'order is the reading order and must not reshuffle because one block changed',
  );
  assert.equal(merged.overview[1].summary, 'Go-live 30/06/2027.');
  assert.deepEqual(merged.overview[1].points, ['UAT in April']);
  assert.equal(merged.overview[0].summary, 'Two modules.', 'untouched blocks are untouched');
});

test('a changed block the previous analysis never had is appended, not dropped', () => {
  const merged = mergeSnapshot(previous, impact({
    changedOverview: [
      { key: 'commercial', label: 'Commercial', previous: '', summary: 'Fixed price agreed.', points: ['Signed 12 Sep'] },
    ],
  }));

  assert.equal(merged.overview.length, 4);
  assert.equal(merged.overview[3].key, 'commercial');
});

test('gaps close by number, not by title', () => {
  // 1 and 3 close; 2 survives; one new gap arrives.
  const merged = mergeSnapshot(previous, impact({
    closedGaps: [1, 3],
    newGaps: [{ title: 'No payment acceptance criteria', why: 'New module.', documentName: null, severity: 'HIGH' }],
  }));

  assert.deepEqual(
    merged.gaps.map((gap) => gap.title),
    ['No org chart', 'No payment acceptance criteria'],
  );
});

test('closing nothing leaves every gap in place', () => {
  const merged = mergeSnapshot(previous, impact());
  assert.equal(merged.gaps.length, 3);
});

test('findings accumulate — an old contradiction is not resolved by a new change', () => {
  const merged = mergeSnapshot(previous, impact({
    newFindings: [{ title: 'Scope vs budget', detail: 'New module, same price.', evidence: [] }],
  }));

  assert.deepEqual(merged.findings.map((finding) => finding.title), ['Date mismatch', 'Scope vs budget']);
});

test('the approach keeps its identity and breakdown; only the score and a note move', () => {
  const merged = mergeSnapshot(previous, impact({
    approach: { stillFits: false, score: 44, note: 'Fixed scope now.', suggested: 'WATERFALL' },
  }));

  assert.equal(merged.approaches[0].approach, 'SCRUM', 'a merge never re-decides the governance model');
  assert.equal(merged.approaches[0].score, 44);
  assert.equal(merged.approaches[0].reasons[0], 'Fixed scope now.');
  assert.deepEqual(merged.approaches[0].criteria, previous.approaches[0].criteria, 'the breakdown survives');
  assert.equal(merged.approaches[1].approach, 'HYBRID', 'alternatives are untouched');
});

test('a score of 0 from the model does not wipe the previous score', () => {
  // The model omitting the field must not read as "this approach now scores zero".
  const merged = mergeSnapshot(previous, impact({
    approach: { stillFits: true, score: 0, note: '', suggested: null },
  }));
  assert.equal(merged.approaches[0].score, 57);
});

test('an empty delta is a valid answer and changes nothing but the summary', () => {
  const merged = mergeSnapshot(previous, impact({ summary: '' }));
  assert.deepEqual(merged.overview, previous.overview);
  assert.deepEqual(merged.gaps, previous.gaps);
  assert.equal(merged.summary, previous.summary, 'an empty summary falls back rather than blanking it');
});
