import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, edit, parseAgents } from '../bin/ralph-agents.mjs';

const example = readFileSync(new URL('../agents.example', import.meta.url), 'utf8');

test('the example parses: its agent lines in order, every setting at its default', () => {
  const { rows, settings } = parseAgents(example);
  assert.deepEqual(rows.map(row => `${row.stage}|${row.agent}|${row.model}|${row.effort}`), ['worker|claude|sonnet|high', 'worker|codex|gpt-6.2-sol|medium', 'reviewer|claude|opus|high', 'merger|claude|sonnet|medium']);
  assert.deepEqual(settings, DEFAULTS);
});

test('a setting line beats its default, the first of two wins, and - is no effort', () => {
  const { rows, settings } = parseAgents('poll|0.05\nworker|codex|m|-\npoll|9\nreviewer|none\n');
  assert.equal(settings.poll, '0.05');
  assert.deepEqual(rows, [{ stage: 'worker', agent: 'codex', model: 'm', effort: null, line: 1 }, { stage: 'reviewer', agent: 'none', line: 3 }]);
});

test('a schedule may split a window at midnight', () => {
  assert.equal(parseAgents('schedule|22-24=codex 00-06=codex,claude\n').settings.schedule, '22-24=codex 00-06=codex,claude');
});

test('a bad line is refused with its number', () => {
  for (const line of ['workers|0', 'poll|0', 'wait|1.5', 'schedule|00-24=cursor', 'schedule|22-06=codex', 'schedule|30-99=claude', 'schedule|07-07=claude', 'schedule|00-06=codex 08-25=claude', 'retries|3', 'worker|codex||-', 'merger|human']) {
    assert.throws(() => parseAgents(`# c\nworker|codex|m|-\n${line}`), /^Error: line 3: /, line);
  }
});

test('an edit changes one line and keeps comments and order; a missing setting is added at the end', () => {
  const text = '# mine\nworker|claude|sonnet|high\nworkers|2\n';
  assert.equal(edit(text, { line: 1, col: 1 }, 'opus'), '# mine\nworker|claude|opus|high\nworkers|2\n');
  assert.equal(edit(text, 'workers', '5'), '# mine\nworker|claude|sonnet|high\nworkers|5\n');
  assert.equal(edit(text, 'poll', '30'), '# mine\nworker|claude|sonnet|high\nworkers|2\npoll|30\n');
  assert.throws(() => edit(text, 'workers', 'many'), /line 3: workers must be a whole number from 1/);
  assert.throws(() => edit(text, { line: 1, col: 0 }, 'cursor'), /line 2: expected/);
});
