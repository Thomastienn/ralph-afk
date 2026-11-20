import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Git with a bare origin; fake bd, gh and agents (no model calls). Agents finish their job at once:
// a worker commits, pushes, opens a PR and labels the task in-review; the reviewer merges the PR.
const fakeBd = `const fs = require('fs');
const file = process.env.FIX + '/issues.json';
const issues = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(issues));
const [cmd, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
const get = id => issues.find(issue => issue.id === id);
const out = value => console.log(JSON.stringify(value));
fs.appendFileSync(process.env.FIX + '/bd-calls', [cmd, ...rest].join(' ') + '\\n');
switch (cmd) {
  case 'ready': {
    const ready = issues.filter(i => i.status === 'open' && (!flag('--type') || i.issue_type === flag('--type')));
    if (flag('--sort') === 'oldest') ready.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    out(ready); break;
  }
  case 'show': if (!get(rest[0])) process.exit(1); out([get(rest[0])]); break;
  case 'update': {
    const issue = get(rest[0]);
    if (rest.includes('--claim')) { if (issue.status !== 'open') process.exit(1); issue.status = 'in_progress'; }
    if (flag('--add-label')) issue.labels.push(flag('--add-label'));
    save(); break;
  }
  case 'unclaim': get(rest[0]).status = 'open'; save(); break;
  case 'close': get(rest[0]).status = 'closed'; save(); break;
  case 'create': {
    const id = flag('--id') ?? 'T-new';
    issues.push({ id, title: flag('--title'), issue_type: flag('--type'), status: 'open', labels: [], description: flag('--description') });
    save(); console.log(id); break;
  }
  case 'list': out(issues.filter(i => i.status !== 'closed' && i.labels.includes(flag('--label')))); break;
  case 'epic': out({ closed: [] }); break;
  default: out([]);
}`;
const fakeGh = `const fs = require('fs');
const read = (name, fallback) => fs.existsSync(process.env.FIX + '/' + name) ? JSON.parse(fs.readFileSync(process.env.FIX + '/' + name, 'utf8')) : fallback;
const write = (name, value) => fs.writeFileSync(process.env.FIX + '/' + name, JSON.stringify(value));
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const out = value => console.log(JSON.stringify(value));
const prs = read('prs.json', []);
// FIXTURE_GH_FLAKY: the first pr list fails, as GitHub does now and then.
if (process.env.FIXTURE_GH_FLAKY && args[0] === 'pr' && args[1] === 'list' && !fs.existsSync(process.env.FIX + '/gh-flaked')) {
  fs.writeFileSync(process.env.FIX + '/gh-flaked', ''); console.error('HTTP 502: Bad Gateway'); process.exit(1);
}
switch (args.slice(0, 2).join(' ')) {
  case 'repo view': out({ defaultBranchRef: { name: 'master' } }); break;
  case 'pr create':
    prs.push({ number: prs.length + 1, headRefName: flag('--head'), title: flag('--title'), state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: (process.env.FIXTURE_RED || '').split(' ').includes(flag('--head')) ? 'FAILURE' : 'SUCCESS' }] });
    write('prs.json', prs); break;
  case 'pr list': out(prs.filter(pr => (flag('--state') === 'all' || pr.state === 'OPEN') && (!args.includes('--head') || pr.headRefName === flag('--head')))); break;
  case 'pr fail': prs[args[2] - 1].statusCheckRollup[0].conclusion = 'FAILURE'; write('prs.json', prs); break; // fixture only: CI goes red
  case 'pr view': out({ state: prs[args[2] - 1].state }); break;
  case 'pr merge': prs[args[2] - 1].state = 'MERGED'; write('prs.json', prs); fs.appendFileSync(process.env.FIX + '/merges', args[2] + '\\n'); break;
  case 'workflow run':
    fs.appendFileSync(process.env.FIX + '/dispatches', args.join(' ') + '\\n');
    write('runs.json', [{ status: 'completed', conclusion: process.env.FIXTURE_SLOW || 'success', url: 'https://example.invalid/run/1', createdAt: new Date().toISOString() }]);
    break;
  case 'run list': out(read('runs.json', [])); break;
}`;
const agent = name => `#!/usr/bin/env bash
prompt="\${@: -1}"
if [[ $* == *'Reply with exactly: pong'* && $* != *'## This run'* ]]; then
  # FIXTURE_LIMITED: out of usage until another agent has run.
  [[ " $FIXTURE_LIMITED " != *" ${name} "* || -e "$FIX/agents" ]] || exit 1
  echo pong; exit
fi
task=$(sed -n 's/^Task: //p' <<< "$prompt")
echo "${name} $task \${*:1:$#-1}" >> "$FIX/agents"
printf '%s\\n' "$prompt" >> "$FIX/prompts"
# A Claude session transcript, as the real CLI keeps one per working directory.
if [[ ${name} == claude ]]; then
  d="$CLAUDE_CONFIG_DIR/projects/$(pwd | sed 's/[^a-zA-Z0-9]/-/g')"; mkdir -p "$d"
  printf '%s\\n' '{"type":"assistant","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":1500,"cache_creation_input_tokens":500},"content":[{"type":"tool_use","name":"Bash","input":{"description":"Run tests"}}]}}' \
    '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"boom"}]}}' > "$d/$$.jsonl"
fi
if [[ $prompt == *'PR: #'* ]]; then
  [[ ! -e "$FIX/reviewing" ]] || echo overlap >> "$FIX/overlap"
  touch "$FIX/reviewing"; /usr/bin/sleep 0.2
  # FIXTURE_REVIEW_RED: the first review pushes a fix whose CI goes red, then gives up.
  if [[ -n $FIXTURE_REVIEW_RED && ! -e "$FIX/review-red" ]]; then
    touch "$FIX/review-red"; gh pr fail "$(sed -n 's/^PR: #//p' <<< "$prompt")"; /usr/bin/sleep 0.3
    rm "$FIX/reviewing"; exit 1
  fi
  gh pr merge "$(sed -n 's/^PR: #//p' <<< "$prompt")" --squash
  rm "$FIX/reviewing"; exit
fi
[[ -z $FIXTURE_WORKER_SLEEP ]] || { echo $$ >> "$FIX/pids"; /usr/bin/sleep "$FIXTURE_WORKER_SLEEP"; }
[[ " $FIXTURE_FAIL " != *" $task "* ]] || exit 1
git log -1 --format="$task %s" >> "$FIX/bases"
echo "$task" > "$task.txt" && git add "$task.txt" && git commit -qm "$task" && git push -q origin "$task"
gh pr create --head "$task" --title "$task"
bd update "$task" --add-label in-review`;

const identity = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
const epic = (id, created_at) => ({ id, title: id, issue_type: 'epic', status: 'open', labels: [], created_at });
const task = (id, parent, extra = {}) => ({ id, title: `Do ${id}`, issue_type: 'task', status: 'open', labels: [], parent, ...extra });

function fixture(issues) {
  const base = mkdtempSync(join(tmpdir(), 'ralph-pr-'));
  const cwd = join(base, 'repo');
  const fix = join(base, 'fix');
  const git = (...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity } });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', join(base, 'origin.git')]);
  mkdirSync(cwd);
  git('init', '-q', '-b', 'master');
  writeFileSync(join(cwd, 'README'), 'fixture\n');
  git('add', 'README');
  git('commit', '-qm', 'start');
  git('remote', 'add', 'origin', join(base, 'origin.git'));
  git('push', '-q', '-u', 'origin', 'master');
  for (const dir of [join(cwd, '.ralph-tui'), join(fix, 'bin')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, '.ralph-tui/pr-worker.md'), '# Worker prompt\n');
  writeFileSync(join(cwd, '.ralph-tui/pr-reviewer.md'), '# Reviewer prompt\n');
  writeFileSync(join(fix, 'issues.json'), JSON.stringify(issues));
  const bin = (name, body) => writeFileSync(join(fix, 'bin', name), body, { mode: 0o755 });
  writeFileSync(join(fix, 'bd.cjs'), fakeBd);
  writeFileSync(join(fix, 'gh.cjs'), fakeGh);
  // flock: agents and the supervisor write the fake state at the same time.
  bin('bd', `#!/bin/sh\nexec flock "$FIX/lock" node "$FIX/bd.cjs" "$@"\n`);
  bin('gh', `#!/bin/sh\nexec flock "$FIX/lock" node "$FIX/gh.cjs" "$@"\n`);
  bin('claude', agent('claude'));
  bin('codex', agent('codex'));
  const read = name => existsSync(join(fix, name)) ? readFileSync(join(fix, name), 'utf8').trim().split('\n') : [];
  const script = fileURLToPath(new URL('../bin/ralph-afk', import.meta.url));
  const options = env => ({
    cwd, env: { ...process.env, ...identity, FIX: fix, PATH: `${fix}/bin:${process.env.PATH}`, RALPH_PR_POLL: '0.05', RALPH_AFK_WAIT: '0', CLAUDE_CONFIG_DIR: join(fix, 'claude'), RALPH_AGENTS: fileURLToPath(new URL('../agents.example', import.meta.url)), ...env },
  });
  // --pr runs until Ctrl+C: send it once stop(stdout so far) holds, by default when it reports being out of work.
  const run = (env = {}, args = [], stop = out => /Out of work/.test(out), signal = 'SIGINT') => new Promise(resolve => {
    const child = spawn('bash', [script, '--pr', ...args], options(env));
    let stdout = '', stderr = '', sent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', data => {
      stdout += data;
      if (!sent && stop(stdout)) { sent = true; child.kill(signal); }
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const issue = id => JSON.parse(readFileSync(join(fix, 'issues.json'), 'utf8')).find(i => i.id === id);
  return { base, cwd, fix, git, run, read, issue, claims: () => read('bd-calls').filter(call => call.endsWith('--claim')) };
}

test('workers open one PR per task, oldest epic first; one reviewer at a time merges them and cleans up', async () => {
  const f = fixture([epic('E2', '2026-01-02'), task('E2.1', 'E2'), epic('E1', '2026-01-01'), task('E1.1', 'E1'), task('E1.2', 'E1')]);
  const result = await f.run({}, ['2']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.claims(), ['update E1.1 --claim', 'update E1.2 --claim', 'update E2.1 --claim']);
  assert.deepEqual(f.read('merges'), ['1', '2', '3']);
  assert.deepEqual(f.read('overlap'), []);
  // Every worker and reviewer is told to merge the base into a conflicting PR, whatever the project's prompts say.
  const prompts = readFileSync(join(f.fix, 'prompts'), 'utf8').split(/^(?=# (?:Worker|Reviewer) prompt$)/m);
  assert.equal(prompts.length, 6, prompts.join('\n---\n'));
  for (const prompt of prompts) assert.match(prompt, /says CONFLICTING, run `git fetch origin master` and `git merge origin\/master`/);
  for (const id of ['E1.1', 'E1.2', 'E2.1']) {
    assert.equal(f.issue(id).status, 'closed', id);
    assert.ok(!existsSync(join(f.base, 'repo-pr', id)), `${id} worktree removed`);
  }
  assert.equal(execFileSync('git', ['branch', '--all', '--list', '*E*'], { cwd: f.cwd, encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['ls-remote', '--heads', 'origin'], { cwd: f.cwd, encoding: 'utf8' }).match(/refs\/heads\/E/g), null);
  const agents = f.read('agents');
  assert.ok(agents.filter(line => / E\d\.\d -p --permission-mode auto --model sonnet --effort high$/.test(line)).length === 3, agents.join('\n'));
  // The fake reviewer reads the task line too, so match the reviewer's model instead.
  assert.equal(agents.filter(line => line.endsWith('-p --permission-mode auto --model opus --effort high')).length, 3, agents.join('\n'));
  assert.match(result.stdout, /Out of work\. Checking for new tasks every 0\.05s/);
  assert.match(result.stdout, /Status: \d of 2 workers busy, reviewer (busy|free); \d ready tasks waiting; \d merged this run\.\n {2}worker E\d\.\d \(claude sonnet high( 3k ctx)?, 0m\): /);
  assert.match(result.stdout, /\n {2}PR #1 E1\.1( \[in-review\])?: CI passed/);
  for (const id of ['E1.1', 'E1.2', 'E2.1', 'review-1']) {
    assert.match(result.stdout, new RegExp(`\\] ${id}: Bash: Run tests\\n.*\\] ${id}: error: boom\\n`), id);
  }
});

test('--pr refuses to start without the worker prompt', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  rmSync(join(f.cwd, '.ralph-tui/pr-worker.md'));
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing \.ralph-tui\/pr-worker\.md/);
  assert.deepEqual(f.claims(), []);
});

test('--pr refuses to start with uncommitted changes and pushes nothing', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  writeFileSync(join(f.cwd, 'README'), 'edited\n');
  writeFileSync(join(f.cwd, 'spec.md'), 'new\n');
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Uncommitted changes; commit or stash them first:[\s\S]*README[\s\S]*spec\.md/);
  assert.deepEqual(f.claims(), []);
  assert.equal(execFileSync('git', ['log', '--oneline', 'origin/master'], { cwd: f.cwd, encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('--pr commits a changed Beads export before the push', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
  mkdirSync(join(f.cwd, '.beads'));
  writeFileSync(join(f.cwd, '.beads/issues.jsonl'), '{}\n');
  git('add', '.beads/issues.jsonl');
  git('commit', '-qm', 'beads');
  writeFileSync(join(f.cwd, '.beads/issues.jsonl'), '{"planned":true}\n');
  const result = await f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(git('log', '--format=%s', 'origin/master'), /chore\(beads\): export before ralph-afk --pr/);
});

test('a new-ui ticket without a Mockup line is skipped with a reminder; one with a mockup runs', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1', { labels: ['new-ui'], description: 'A new panel.' }),
    task('E1.2', 'E1', { labels: ['new-ui'], description: 'A new panel.\nMockup: docs/mockups/E1.2.html' })]);
  const result = await f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Skipping E1\.1: a new-ui ticket needs a "Mockup:" line/);
  assert.deepEqual(f.claims(), ['update E1.2 --claim']);
  assert.equal(f.issue('E1.1').status, 'open');
  assert.equal(f.issue('E1.2').status, 'closed');
});

test('with Claude out of usage a Codex worker takes the task; the reviewer waits for Claude', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const result = await f.run({ FIXTURE_LIMITED: 'claude' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [worker, reviewer, ...rest] = f.read('agents');
  assert.match(worker, /^codex E1\.1 exec --approve-for-me -m gpt-6\.2-sol -c model_reasoning_effort="medium" -c sandbox_workspace_write\.writable_roots=\[.*\] -c sandbox_workspace_write\.network_access=true$/);
  assert.match(reviewer, /^claude E1\.1 -p --permission-mode auto --model opus/);
  assert.deepEqual(rest, []);
});

test('-a limits workers and the reviewer to those agents; a stage left with none is refused', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const table = join(f.base, 'agents');
  writeFileSync(table, ['claude', 'codex'].flatMap(agent => [`worker|${agent}|w|-`, `reviewer|${agent}|r|-`]).join('\n'));
  const result = await f.run({ RALPH_AGENTS: table }, ['-a', 'codex']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const agents = f.read('agents');
  assert.deepEqual(agents.map(line => line.split(' ').slice(0, 6).join(' ')), ['codex E1.1 exec --approve-for-me -m w', 'codex E1.1 exec --approve-for-me -m r']);

  const refused = await fixture([epic('E1'), task('E1.1', 'E1')]).run({}, ['-a', 'codex']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No reviewer line in .* for -a codex/);
});

test('a task whose worker keeps failing gets needs-human after 3 tries while other work merges', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1'), task('E1.2', 'E1')]);
  const result = await f.run({ FIXTURE_FAIL: 'E1.1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.claims().filter(call => call.includes('E1.1')).length, 3);
  assert.ok(f.issue('E1.1').labels.includes('needs-human'));
  assert.equal(f.issue('E1.2').status, 'closed');
  assert.match(result.stdout, /Waiting for a human:\n {2}E1\.1 Do E1\.1/);
});

test('a failed gh call is logged and retried; the run goes on and merges', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const result = await f.run({ FIXTURE_GH_FLAKY: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Check failed: HTTP 502: Bad Gateway; trying again in 0\.05s\./);
  assert.equal(f.issue('E1.1').status, 'closed');
});

test('a task in review whose PR merged unwatched closes; one with no PR gets needs-human', async () => {
  const inReview = { status: 'in_progress', labels: ['in-review'] };
  const f = fixture([epic('E1'), task('E1.1', 'E1', inReview), task('E1.2', 'E1', { ...inReview, labels: ['in-review'] })]);
  writeFileSync(join(f.fix, 'prs.json'), JSON.stringify([{ number: 1, headRefName: 'E1.1', title: 'E1.1', state: 'MERGED', statusCheckRollup: [] }]));
  const result = await f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.issue('E1.1').status, 'closed');
  assert.match(result.stdout, /Merged PR #1 \(E1\.1\)\./);
  assert.ok(f.issue('E1.2').labels.includes('needs-human'));
  assert.match(result.stdout, /E1\.2 is in review but it has no PR; labelled needs-human\./);
  assert.deepEqual(f.read('agents'), []);
});

test('failed runs count across restarts; needs-human resets the count', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  mkdirSync(join(f.cwd, '.ralph-tui/pr-logs'));
  writeFileSync(join(f.cwd, '.ralph-tui/pr-logs/tries.json'), JSON.stringify({ 'E1.1': 2 }));
  const result = await f.run({ FIXTURE_FAIL: 'E1.1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.claims().length, 1);
  assert.ok(f.issue('E1.1').labels.includes('needs-human'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, '.ralph-tui/pr-logs/tries.json'), 'utf8')), {});
});

test('after one Ctrl+C it waits for the running agents without polling gh and bd in a loop', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const result = await f.run({ FIXTURE_WORKER_SLEEP: '1', RALPH_PR_POLL: '5' }, [], out => /as worker for E1\.1/.test(out));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /E1\.1: PR in review\./);
  assert.ok(f.read('bd-calls').filter(call => call.startsWith('epic')).length <= 3, f.read('bd-calls').join('\n'));
});

test('the reviewer takes only PRs whose CI passed; a red PR in review gets needs-human', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1'), task('E1.2', 'E1')]);
  const result = await f.run({ FIXTURE_RED: 'E1.1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.read('merges').length, 1);
  assert.equal(f.issue('E1.2').status, 'closed');
  assert.ok(f.issue('E1.1').labels.includes('needs-human'));
  assert.notEqual(f.issue('E1.1').status, 'closed');
  assert.deepEqual(f.read('agents').filter(line => /^claude E1\.1 .*--model opus/.test(line)), []);
  assert.match(result.stdout, /is in review but its CI failed; labelled needs-human/);
});

test('a reviewer whose fix turns CI red keeps the PR and runs again', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const result = await f.run({ FIXTURE_REVIEW_RED: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!f.issue('E1.1').labels.includes('needs-human'));
  assert.equal(f.issue('E1.1').status, 'closed');
  assert.equal(f.read('agents').filter(line => /^claude E1\.1 .*--model opus/.test(line)).length, 2);
});

test('out of work, --pr keeps checking: a task filed later runs on the planning commits made since', async () => {
  const f = fixture([epic('E1')]);
  let filed = false;
  const result = await f.run({}, [], out => {
    if (!filed && /Out of work/.test(out)) {
      filed = true;
      writeFileSync(join(f.cwd, 'spec.md'), 'plan\n');
      f.git('add', 'spec.md');
      f.git('commit', '-qm', 'plan E1.1');
      const issues = JSON.parse(readFileSync(join(f.fix, 'issues.json'), 'utf8'));
      writeFileSync(join(f.fix, 'issues.new'), JSON.stringify([...issues, task('E1.1', 'E1')]));
      renameSync(join(f.fix, 'issues.new'), join(f.fix, 'issues.json')); // the fake bd never reads half a file
    }
    return (out.match(/Out of work/g) ?? []).length === 2;
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.issue('E1.1').status, 'closed');
  assert.match(result.stdout, /Pushed the new commits on master to origin/);
  assert.deepEqual(f.read('bases'), ['E1.1 plan E1.1']);
});

test('every 5 merges the slow suite runs on GitHub; a failure files a fix task that a worker takes', async () => {
  const f = fixture([epic('E1'), ...[1, 2, 3, 4, 5].map(n => task(`E1.${n}`, 'E1'))]);
  const result = await f.run({ FIXTURE_SLOW: 'failure' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.read('dispatches'), ['workflow run slow-tests.yml --ref master']);
  assert.equal(f.issue('T-new').title, 'Fix test:slow failures');
  assert.match(f.issue('T-new').description, /https:\/\/example\.invalid\/run\/1/);
  assert.equal(f.issue('T-new').status, 'closed');
  assert.equal(f.read('merges').length, 6);
});

test('--pr shares the sequential lock: a second supervisor in the checkout is refused', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  const holder = spawn('flock', [join(f.cwd, '.ralph-tui/afk.lock'), 'sleep', '5']);
  await new Promise(resolve => setTimeout(resolve, 200));
  try {
    const result = await f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already running in this checkout/);
    assert.deepEqual(f.claims(), []);
  } finally { holder.kill(); }
});

test('a supervisor killed with SIGKILL takes its running agents with it', async () => {
  const f = fixture([epic('E1'), task('E1.1', 'E1')]);
  await f.run({ FIXTURE_WORKER_SLEEP: '30' }, [], () => existsSync(join(f.fix, 'pids')), 'SIGKILL');
  const pid = Number(f.read('pids')[0]);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!alive(), 'worker still running after its supervisor died');
  } finally { if (alive()) process.kill(pid, 'SIGKILL'); }
});
