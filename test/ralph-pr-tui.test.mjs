import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../bin/ralph-pr-tui.mjs';

const now = Date.now();
const job = (slot, steps, extra = {}) => ({ slot, stage: 'worker', Task: `T-${slot}`, Title: `Task ${slot}`, agent: 'claude', model: 'opus', effort: 'high', started: now - 12 * 60000, steps, ...extra });
const steps = n => Array.from({ length: n }, (_, i) => `step ${i + 1}`);
const view = extra => ({ header: ['master'], jobs: [], prs: [], logs: [], now, ...extra });
const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '');
const screen = (...args) => render(...args).map(plain);

test('the overview shows each agent with its last 5 steps, then PRs, log and keys, never wider than the terminal', () => {
  const lines = render(view({
    jobs: [job(1, steps(8), { context: 84321 }), job(2, [], { stage: 'reviewer', PR: '#42' })],
    prs: ['PR #42 T-2: CI passed, reviewer running'],
    logs: ['14:00:00 one', '14:00:01 two'],
  }), 80, 30);
  const text = lines.map(plain);
  assert.equal(text.length, 16); // the rest of the screen is cleared, not padded
  assert.match(text[0], /^ ralph-pr {2}· {2}master +\d\d:\d\d:\d\d $/);
  assert.match(text[2], /^ 1 {2}worker {2}T-1 {2}Task 1 ─+ claude opus high 84k ctx · 12m$/);
  assert.deepEqual(text.slice(3, 8), [' │ step 4', ' │ step 5', ' │ step 6', ' │ step 7', ' │ step 8']);
  assert.equal(text[8], ''); // room to spare: a blank line between panels
  assert.match(text[9], /^ 2 {2}reviewer {2}#42 T-2 {2}Task 2 ─+ claude opus high · 12m$/);
  assert.equal(text[10], ' │ starting');
  assert.equal(text[12], ' PRs  #42 T-2: CI passed, reviewer running');
  assert.deepEqual(text.slice(13, 15), [' Log  14:00:00 one', '      14:00:01 two']);
  assert.equal(text.at(-1), ' 1-9  open agent   q  stop  ');
  assert.ok(text.every(line => line.length <= 80));
  assert.ok(lines[7].includes('\x1b[0m') && !lines[7].includes('\x1b[2m'), 'the newest step is not dimmed');
  assert.ok(lines[6].includes('\x1b[2mstep 7'), 'older steps are dimmed');
});

test('colour marks state: errors, CI results, failures in the log and a stopping run', () => {
  const lines = render(view({
    jobs: [job(1, ['error: boom'])], stopping: true,
    prs: ['PR #1 T-1 [needs-human]: CI failed', 'PR #2 T-2: CI passed'],
    logs: ['14:00:00 PR #3: claude exited with 1 without merging.', '14:00:01 Merged PR #4 (T-4).'],
  }), 120, 30);
  assert.match(lines[0], /^\x1b\[7;33m/); // the header turns yellow
  assert.ok(lines[3].includes('\x1b[1;31merror: boom'));
  const prs = lines.find(line => plain(line).startsWith(' PRs'));
  assert.ok(prs.includes('\x1b[1;31mneeds-human') && prs.includes('\x1b[31mCI failed') && prs.includes('\x1b[32mCI passed'));
  assert.ok(lines.some(line => line.includes('\x1b[31mPR #3: claude exited')));
  assert.ok(lines.some(line => line.includes('\x1b[32mMerged PR #4')));
  assert.ok(render(view({ jobs: [job(1, ['error: boom'])], color: false }), 80, 20).every(line => !line.includes('\x1b')), 'NO_COLOR gives plain text');
});

test('a small terminal gets fewer steps per panel, no gaps, and never more rows than it has', () => {
  const text = screen(view({ jobs: [job(1, steps(9)), job(2, steps(9)), job(3, steps(9))], logs: steps(50) }), 40, 16);
  assert.equal(text.length, 16);
  assert.match(text[2], /^ 1 {2}worker/);
  assert.equal(text[3], ' │ step 9');
  assert.match(text[4], /^ 2 {2}worker/);
  assert.match(text.at(-2), /step 50$/); // the newest log line survives
  assert.ok(text.every(line => line.length <= 40));
});

test('PRs wrap onto more lines and take room from the log, but never its newest 3 lines or the key line', () => {
  const prs = Array.from({ length: 12 }, (_, i) => `PR #${i + 10} T-${i}: CI running`);
  const text = screen(view({ prs, logs: steps(50) }), 60, 14);
  assert.equal(text.length, 14);
  assert.match(text.find(line => line.startsWith(' PRs')), /^ PRs {2}#10 T-0: CI running {3}#11/);
  assert.ok(text.some(line => line.includes('#21 T-11')));
  assert.match(text.at(-1), /open agent/);
  const crowded = screen(view({ jobs: [job(1, steps(9))], prs: Array(100).fill('PR #1 T-1: CI running'), logs: steps(5) }), 60, 12);
  assert.equal(crowded.length, 12);
  assert.match(crowded[2], /^ 1 {2}worker/);
  assert.deepEqual(crowded.slice(-4, -1), [' Log  step 3', '      step 4', '      step 5']);
  assert.match(crowded.at(-1), /open agent/);
});

test('a narrow terminal keeps the right end of each bar and wraps header fields and log lines', () => {
  const text = screen(view({
    header: ['master', '2/3 workers busy', 'reviewer busy', '1 merged'],
    jobs: [job(1, steps(2), { Title: 'A long task title that cannot fit', context: 84321 })],
    logs: ['14:00:00 Status: 2 of 3 workers busy, reviewer busy; 4 ready tasks waiting.'],
  }), 50, 20);
  assert.match(text[0], /^ ralph-pr {2}· {2}master +\d\d:\d\d:\d\d $/);
  assert.equal(text[1].trimEnd(), ' 2/3 workers busy  ·  reviewer busy  ·  1 merged');
  assert.match(text[3], /^ 1 {2}worker {2}T-1 ─+ claude opus high 84k ctx · 12m$/); // the title gives way first
  assert.deepEqual(text.slice(-4, -1), [' Log  14:00:00 Status: 2 of 3 workers busy,', '               reviewer busy; 4 ready tasks', '               waiting.']);
  assert.ok(text.every(line => line.length <= 50));
  const detail = screen(view({ jobs: [job(1, [])], focus: job(1, [], { Title: 'A long task title that cannot fit' }) }), 40, 10);
  assert.match(detail[0], /^ 1 {2}worker {2}T-1 +claude opus high · 12m $/);
});

test('a full log never pushes past the bottom, and no room for log lines shows none', () => {
  assert.equal(render(view({ logs: steps(500) }), 40, 20).length, 20);
  const tiny = screen(view({ jobs: [job(1, steps(3))], logs: steps(500) }), 40, 5);
  assert.equal(tiny.length, 5);
  assert.equal(tiny[3], ' Log  step 500');
  assert.ok(!screen(view({ logs: steps(500) }), 40, 4).some(line => line.startsWith(' Log')));
});

test('the detail view fills the screen with the newest steps and scrolls back', () => {
  const focus = job(2, steps(100), { file: '/logs/T-2.log' });
  const lines = screen(view({ jobs: [focus], focus }), 80, 24);
  assert.equal(lines.length, 24);
  assert.match(lines[0], /^ 2 {2}worker {2}T-2 {2}Task 2 +claude opus high · 12m $/);
  assert.equal(lines[1], ' /logs/T-2.log');
  assert.equal(lines[2], ' │ step 81');
  assert.equal(lines[21], ' │ step 100');
  assert.equal(lines.at(-1), ' Esc  back   ↑↓  scroll   1-9  switch agent  ');
  const back = screen(view({ jobs: [focus], focus, scroll: 10 }), 80, 24);
  assert.equal(back[21], ' │ step 90');
  assert.match(back.at(-1), /10 lines up$/);
  const top = screen(view({ jobs: [focus], focus, scroll: 1000 }), 80, 24);
  assert.equal(top[2], ' │ step 1'); // scrolling stops at the first step
});

test('a new agent in the detail view says starting and keeps the key line at the bottom', () => {
  const focus = job(1, []);
  const lines = screen(view({ jobs: [focus], focus }), 80, 10);
  assert.equal(lines.length, 10);
  assert.equal(lines[2], ' │ starting');
  assert.match(lines.at(-1), /^ Esc {2}back/);
});

test('control characters and escape codes in agent output cannot break the layout', () => {
  const lines = render(view({ jobs: [job(1, ['a\tb\x1b[31mred\r\n'])] }), 80, 20);
  assert.equal(plain(lines[3]), ' │ a b [31mred  ');
  assert.ok(!lines[3].includes('\x1b[31mred'));
});
