import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../bin/ralph-pr-tui.mjs';

const now = Date.now();
const job = (slot, steps, extra = {}) => ({ slot, stage: 'worker', Task: `T-${slot}`, Title: `Task ${slot}`, agent: 'claude', model: 'opus', started: now - 12 * 60000, steps, ...extra });
const steps = n => Array.from({ length: n }, (_, i) => `step ${i + 1}`);
const view = extra => ({ header: 'ralph-pr  master', jobs: [], prs: [], logs: [], now, ...extra });

test('the overview shows each agent with its last 5 steps, then PRs, log and keys, in exactly the terminal size', () => {
  const lines = render(view({
    jobs: [job(1, steps(8)), job(2, [], { stage: 'reviewer', PR: '#42' })],
    prs: ['PR #42 T-2: CI passed, reviewer running'],
    logs: ['14:00:00 one', '14:00:01 two'],
  }), 80, 30);
  assert.equal(lines.length, 15); // the rest of the screen is cleared, not padded
  assert.match(lines[0], /^ralph-pr {2}master {2}\d/);
  assert.equal(lines[2], '[1] worker  T-1  Task 1  claude opus  12m');
  assert.deepEqual(lines.slice(3, 8), ['    step 4', '    step 5', '    step 6', '    step 7', '    step 8']);
  assert.equal(lines[8], '[2] reviewer  #42 T-2  Task 2  claude opus  12m');
  assert.equal(lines[9], '    starting');
  assert.equal(lines[11], 'PRs  PR #42 T-2: CI passed, reviewer running');
  assert.deepEqual(lines.slice(12, 14), ['Log  14:00:00 one', '     14:00:01 two']);
  assert.equal(lines.at(-1), '1-9 open agent · q/Ctrl+C stop');
  assert.ok(lines.every(line => line.length <= 80));
});

test('a small terminal gets fewer steps per panel and never more rows than it has', () => {
  const lines = render(view({ jobs: [job(1, steps(9)), job(2, steps(9)), job(3, steps(9))], logs: steps(50) }), 40, 16);
  assert.equal(lines.length, 16);
  assert.deepEqual(lines.slice(2, 5), ['[1] worker  T-1  Task 1  claude opus  12m'.slice(0, 40), '    step 9', '[2] worker  T-2  Task 2  claude opus  12m'.slice(0, 40)]);
  assert.match(lines.at(-2), /step 50$/); // the newest log line survives
});

test('a full log never pushes past the bottom, and no room for log lines shows none', () => {
  assert.equal(render(view({ logs: steps(500) }), 40, 20).length, 20);
  const tiny = render(view({ jobs: [job(1, steps(3))], logs: steps(500) }), 40, 5);
  assert.equal(tiny.length, 5);
  assert.equal(tiny[3], 'Log  step 500');
  assert.ok(!render(view({ logs: steps(500) }), 40, 4).some(line => line.startsWith('Log')));
});

test('the detail view fills the screen with the newest steps and scrolls back', () => {
  const focus = job(2, steps(100), { file: '/logs/T-2.log' });
  const lines = render(view({ jobs: [focus], focus }), 80, 24);
  assert.equal(lines.length, 24);
  assert.equal(lines[0], '[2] worker  T-2  Task 2  claude opus  12m  /logs/T-2.log');
  assert.equal(lines[2], 'step 81');
  assert.equal(lines[21], 'step 100');
  assert.equal(lines.at(-1), 'Esc back · ↑/↓ scroll · 1-9 switch agent');
  const back = render(view({ jobs: [focus], focus, scroll: 10 }), 80, 24);
  assert.equal(back[21], 'step 90');
  assert.match(back.at(-1), /10 lines up$/);
  const top = render(view({ jobs: [focus], focus, scroll: 1000 }), 80, 24);
  assert.equal(top[2], 'step 1'); // scrolling stops at the first step
});

test('a new agent in the detail view says starting and keeps the key line at the bottom', () => {
  const focus = job(1, []);
  const lines = render(view({ jobs: [focus], focus }), 80, 10);
  assert.equal(lines.length, 10);
  assert.equal(lines[2], 'starting');
  assert.match(lines.at(-1), /^Esc back/);
});

test('control characters and escape codes in agent output cannot break the layout', () => {
  const lines = render(view({ jobs: [job(1, ['a\tb\x1b[31mred\r\n'])] }), 80, 20);
  assert.equal(lines[3], '    a b [31mred  ');
});
