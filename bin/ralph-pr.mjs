// ralph-afk --pr [workers]: parallel PR mode. Each worker takes one ready task into its own worktree and
// branch, opens a PR and waits for CI; one reviewer at a time reviews, fixes and squash-merges green PRs.
// ralph-afk holds the checkout lock and starts this from the repository root. See docs/ralph.md.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { probe } from './ralph-probe.mjs';
import { startTui } from './ralph-pr-tui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const { env } = process;
// ralph-afk passes -a (space-separated, maybe empty) then the optional worker count.
const only = (process.argv[2] ?? '').split(' ').filter(Boolean);
const slots = Number(process.argv[3] ?? env.RALPH_PR_WORKERS ?? 3);
const schedule = env.RALPH_AFK_SCHEDULE ?? '00-24=claude,codex';
const waitMs = Number(env.RALPH_AFK_WAIT ?? 600) * 1000;
const pollMs = Number(env.RALPH_PR_POLL ?? 120) * 1000;
const SLOW_EVERY = 5; // merges between slow-suite runs on GitHub
const TRIES = 3; // failed agent runs on one task or PR before it needs a human
const trees = join(dirname(root), `${basename(root)}-pr`); // outside the checkout, so nothing lands in .gitignore
const logs = join(root, '.ralph-tui/pr-logs');
const agentsFile = env.RALPH_AGENTS || (existsSync('.ralph-tui/agents') ? '.ralph-tui/agents' : join(here, '../agents')); // ralph-afk checked it exists
const prompts = { worker: '.ralph-tui/pr-worker.md', reviewer: '.ralph-tui/pr-reviewer.md' };

let screen = null; // the dashboard, while stdin and stdout are a terminal
const events = []; // the dashboard's log lines
const log = message => {
  const line = `[ralph-pr ${new Date().toLocaleString('sv')}] ${message}`;
  if (!screen) return console.log(line);
  appendFileSync(join(logs, 'ralph-pr.log'), `${line}\n`);
  if (events.push(`${new Date().toLocaleTimeString('sv')} ${message}`) > 200) events.shift();
  screen.draw();
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const attempt = (command, args, options) => {
  try { return run(command, args, options); } catch { return null; }
};
const json = (command, args) => JSON.parse(run(command, args) || 'null');
const fail = message => { console.error(message); process.exit(1); };
const labelled = (issue, ...names) => (issue.labels ?? []).some(label => names.includes(label));
const show = id => { const out = attempt('bd', ['show', id, '--json']); return out && JSON.parse(out)[0]; };

if (!Number.isInteger(slots) || slots < 1) fail('Usage: ralph-afk [-a agent,agent] --pr [workers]; workers is a whole number from 1.');
for (const [stage, file] of Object.entries(prompts)) {
  if (!existsSync(file)) fail(`Missing ${file}: the ${stage} prompt for ralph-afk --pr.`);
}
// Workers share the worker lines with ralph-afk.
const table = readFileSync(agentsFile, 'utf8').split('\n')
  .filter(line => line.trim() && !line.trimStart().startsWith('#'))
  .map(line => { const [stage, agent, model, effort] = line.split('|'); return { stage, agent, model, effort }; })
  .filter(row => !only.length || only.includes(row.agent));
for (const stage of Object.keys(prompts)) {
  if (!table.some(row => row.stage === stage)) fail(`No ${stage} line in ${agentsFile}${only.length ? ` for -a ${only.join(',')}` : ''}.`);
}

// Same windows as ralph-afk: space-separated FROM-TO=agents in local hours.
function scheduled() {
  const hour = new Date().getHours();
  for (const window of schedule.split(/\s+/).filter(Boolean)) {
    const [hours, list] = window.split('=');
    const [from, to] = hours.split('-').map(Number);
    if (hour >= from && hour < to) return list.split(',');
  }
  return [];
}
const probed = new Map(); // agent -> { ok, until }
function usable(row) {
  const known = probed.get(row.agent);
  if (known && known.until > Date.now()) return known.ok;
  const { ok, until } = probe(row.agent);
  // A limited agent is not probed before its reported reset; with none, it waits RALPH_AFK_WAIT.
  probed.set(row.agent, { ok, until: until || Date.now() + waitMs });
  if (!ok) log(`${row.agent} is not usable now (usage limit, auth or network).`);
  return ok;
}
// The first usable agent of the stage in table order.
const pick = stage => table.find(row => row.stage === stage && scheduled().includes(row.agent) && usable(row));
const down = agent => probed.set(agent, { ok: false, until: Date.now() + waitMs });

const commonGit = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
function command(row, prompt) {
  const effort = row.effort && row.effort !== '-' ? row.effort : null;
  if (row.agent === 'claude') {
    return ['claude', ['-p', '--permission-mode', 'auto', '--model', row.model, ...(effort ? ['--effort', effort] : []), prompt]];
  }
  // Commits and bd writes land in the main checkout's .git and .beads, outside the worktree sandbox.
  const roots = JSON.stringify([commonGit, join(root, '.beads')]);
  return ['codex', ['exec', '--approve-for-me', '-m', row.model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-c', `sandbox_workspace_write.writable_roots=${roots}`, '-c', 'sandbox_workspace_write.network_access=true', prompt]];
}
const running = new Set();
function launch(row, stage, name, cwd, facts) {
  // GitHub runs no CI on a conflicting PR and a reviewer starts only after CI passed, so an agent waiting on it waits forever.
  const catchUp = `Before every wait on CI: when \`gh pr view <branch> --json mergeable\` says CONFLICTING, run \`git fetch origin ${base}\` and \`git merge origin/${base}\`, resolve the conflicts, commit and push. UNKNOWN means GitHub is still computing it: ask again after a few seconds.`;
  const prompt = `${readFileSync(prompts[stage], 'utf8')}\n\n## This run\n\n${facts.join('\n')}\n\n${catchUp}\n`;
  const [bin, args] = command(row, prompt);
  const out = openSync(join(logs, `${name}.log`), 'a');
  // detached: Ctrl+C in this terminal reaches only the supervisor, never a running agent.
  // The watcher ends the agent's group once this supervisor is gone, even after kill -9 or a closed terminal.
  const watch = `(while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -TERM 0) & w=$!; "$@"; s=$?; kill $w 2>/dev/null; exit $s`;
  const child = spawn('sh', ['-c', watch, 'sh', bin, ...args], { cwd, stdio: ['ignore', out, out], detached: true });
  closeSync(out);
  let slot = 1; // a panel keeps its number while its agent runs
  while ([...running].some(job => job.slot === slot)) slot++;
  const job = { slot, steps: [], stage, name, agent: row.agent, model: row.model, cwd, offset: 0, started: Date.now(), child, ...Object.fromEntries(facts.map(fact => [fact.slice(0, fact.indexOf(': ')), fact.slice(fact.indexOf(': ') + 2)])) };
  job.done = new Promise(resolve => {
    child.on('exit', code => resolve((job.code = code ?? 1)));
    child.on('error', error => { log(`Could not start ${bin}: ${error.message}`); resolve((job.code = 127)); });
  });
  running.add(job);
  log(`Started ${row.agent} ${row.model} as ${stage} for ${name}; log: .ralph-tui/pr-logs/${name}.log`);
  return job;
}

// Each agent's steps stream here as they happen. `claude -p` writes its log only at exit, so Claude's steps
// come from its live session transcript; Codex writes its own steps to the log as it goes.
const claudeProjects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
function transcript(job) {
  const dir = join(claudeProjects, job.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  if (!existsSync(dir)) return null;
  // The reviewer worktree is reused, so only a transcript written since this job started counts.
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name))
    .map(file => ({ file, time: statSync(file).mtimeMs })).filter(entry => entry.time >= job.started)
    .sort((a, b) => b.time - a.time)[0]?.file ?? null;
}
const firstLine = text => String(text ?? '').trim().split('\n')[0];
function claudeSteps(text) {
  let entry;
  try { entry = JSON.parse(text); } catch { return []; }
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
  return content.map(part => {
    const input = part.input ?? {};
    if (entry.type === 'assistant' && part.type === 'text') return firstLine(part.text);
    if (entry.type === 'assistant' && part.type === 'tool_use') return `${part.name}: ${firstLine(input.description ?? input.command ?? input.file_path ?? input.pattern)}`;
    if (part.type !== 'tool_result' || !part.is_error) return '';
    return `error: ${firstLine(Array.isArray(part.content) ? part.content.map(piece => piece.text ?? '').join('\n') : part.content)}`;
  });
}
function progress(job) {
  job.file ??= job.agent === 'claude' ? transcript(job) : join(logs, `${job.name}.log`);
  if (!job.file || !existsSync(job.file)) return;
  const fresh = readFileSync(job.file).subarray(job.offset);
  const end = fresh.lastIndexOf('\n') + 1; // a line still being written waits for the next look
  job.offset += end;
  // shortcut: Codex lines are printed raw, its echoed prompt and command output included; parse its session file if that is too noisy.
  for (const text of fresh.subarray(0, end).toString('utf8').split('\n')) {
    for (const step of job.agent === 'claude' ? claudeSteps(text) : [text.trim()]) {
      if (!step) continue;
      job.last = step;
      if (job.steps.push(step) > 1000) job.steps.shift();
      if (!screen) log(`${job.name}: ${step}`.slice(0, 240));
    }
  }
}
setInterval(() => { for (const job of running) progress(job); screen?.draw(); }, 2000).unref();

// Kept on disk, so a restart does not give a failing task TRIES more runs.
const triesFile = join(logs, 'tries.json');
const tries = new Map(Object.entries(existsSync(triesFile) ? JSON.parse(readFileSync(triesFile, 'utf8')) : {}));
const saveTries = () => writeFileSync(triesFile, JSON.stringify(Object.fromEntries(tries)));
// A task or PR that keeps failing waits for the owner instead of spinning.
function failed(id, what) {
  const n = (tries.get(id) ?? 0) + 1;
  if (n < TRIES) tries.set(id, n);
  else tries.delete(id); // the owner removing needs-human gives it TRIES fresh runs
  saveTries();
  if (n < TRIES) return;
  attempt('bd', ['update', id, '--add-label', 'needs-human']);
  attempt('bd', ['note', id, `ralph-afk --pr: ${what} failed ${n} times; see .ralph-tui/pr-logs/.`]);
  log(`${id} failed ${n} times; labelled needs-human.`);
}

const base = json('gh', ['repo', 'view', '--json', 'defaultBranchRef']).defaultBranchRef.name;
const reviewTree = join(trees, 'reviewer');
mkdirSync(logs, { recursive: true });
mkdirSync(trees, { recursive: true });
// Workers never commit the Beads export, so the supervisor does, on the default branch only.
function commitBeads(message) {
  if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== base || !run('git', ['status', '--porcelain', '--', '.beads/issues.jsonl'])) return;
  if (attempt('git', ['commit', '-q', '-m', message, '--', '.beads/issues.jsonl']) !== null) log('Committed the Beads export.');
}
// Workers branch from origin, so uncommitted planning work would miss them. Never commit it blindly: it gets pushed.
commitBeads('chore(beads): export before ralph-afk --pr');
const dirty = run('git', ['status', '--porcelain', '--', '.', ':!.ralph-tui', ':!.beads/issues.jsonl']);
if (dirty) fail(`Uncommitted changes; commit or stash them first:\n${dirty}`);
// The owner's planning commits must reach GitHub before workers branch from it.
try { run('git', ['push', '-q', 'origin', base], { stdio: ['ignore', 'pipe', 'inherit'] }); }
catch { fail(`Could not push local ${base} to origin; fix that first (diverged, or the pre-push secret scan refused).`); }
run('git', ['fetch', '-q', 'origin']);
if (!existsSync(reviewTree)) run('git', ['worktree', 'add', '-q', '--detach', reviewTree, `origin/${base}`]);
// A previous run stopped mid-task: give its unfinished claims back.
for (const id of readdirSync(trees).filter(name => name !== 'reviewer')) {
  const task = show(id);
  if (task?.status === 'in_progress' && !labelled(task, 'in-review')) attempt('bd', ['unclaim', id]);
}

const reminded = new Set();
function readyTasks() {
  const epics = new Map(json('bd', ['ready', '--type', 'epic', '--sort', 'oldest', '--json', '--limit', '0'])
    .filter(epic => !labelled(epic, 'gate:backlog')).map((epic, index) => [epic.id, index]));
  // Parentless tasks (fixes filed mid-run) first, then by epic age; bd's own order within an epic.
  return json('bd', ['ready', '--json', '--limit', '0'])
    .filter(task => task.issue_type !== 'epic' && !labelled(task, 'gate:backlog', 'in-review', 'needs-human'))
    .filter(task => !task.parent || epics.has(task.parent))
    .filter(task => {
      if (!labelled(task, 'new-ui') || /^Mockup:\s*\S/m.test(task.description ?? '')) return true;
      if (!reminded.has(task.id)) log(`Skipping ${task.id}: a new-ui ticket needs a "Mockup:" line linking docs/mockups/${task.id}.html or .png.`);
      reminded.add(task.id);
      return false;
    })
    .sort((a, b) => (epics.get(a.parent) ?? -1) - (epics.get(b.parent) ?? -1));
}
// Agents read code and run single test files, so a worktree borrows the main checkout's dependencies.
function borrowModules(path) {
  if (existsSync(join(root, 'node_modules')) && !existsSync(join(path, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(path, 'node_modules'));
}
function startWorker(task, row) {
  if (attempt('bd', ['update', task.id, '--claim']) === null) return;
  const path = join(trees, task.id);
  try {
    if (!existsSync(path)) {
      run('git', ['fetch', '-q', 'origin']);
      pushBase();
      const branch = attempt('git', ['rev-parse', '-q', '--verify', `refs/heads/${task.id}`]);
      run('git', ['worktree', 'add', '-q', ...(branch ? [path, task.id] : ['-b', task.id, path, `origin/${base}`])]);
    }
    borrowModules(path);
  } catch (error) {
    log(`Could not make the worktree for ${task.id}: ${error.stderr || error.message}`);
    attempt('bd', ['unclaim', task.id]);
    return failed(task.id, 'making the worktree');
  }
  launch(row, 'worker', task.id, path, [`Task: ${task.id}`, `Title: ${task.title}`, `Branch: ${task.id}`, `Base: ${base}`]);
}
// A task added while this runs may come with planning commits; workers branch from origin, so push them first.
function pushBase() {
  if (run('git', ['rev-list', '--count', `origin/${base}..${base}`]) === '0') return;
  if (attempt('git', ['push', '-q', 'origin', base]) !== null) return log(`Pushed the new commits on ${base} to origin.`);
  log(`Could not push local ${base} to origin; workers branch from origin/${base} without its new commits.`);
}
function workerDone(job) {
  const task = show(job.Task);
  if (task && (task.status === 'closed' || labelled(task, 'in-review'))) return log(`${job.Task}: PR in review.`);
  if (task && labelled(task, 'needs-human')) {
    attempt('bd', ['unclaim', job.Task]);
    return log(`${job.Task} needs a human; other work continues.`);
  }
  log(`${job.Task}: ${job.agent} exited with ${job.code} before the PR was in review; the task is ready again.`);
  if (Date.now() - job.started < 120000) down(job.agent);
  attempt('bd', ['unclaim', job.Task]);
  failed(job.Task, 'the worker');
}

// Open PRs whose branch is a Beads task still open here, oldest first.
function taskPrs() {
  return json('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,title,statusCheckRollup'])
    .map(pr => ({ ...pr, task: show(pr.headRefName) }))
    .filter(pr => pr.task && pr.task.status !== 'closed')
    .sort((a, b) => a.number - b.number);
}
const settled = pr => pr.statusCheckRollup?.length &&
  pr.statusCheckRollup.every(check => (check.status ?? 'COMPLETED') === 'COMPLETED' && !['PENDING', 'EXPECTED'].includes(check.state));
// Check runs report a conclusion, commit statuses a state.
const passed = pr => pr.statusCheckRollup.every(check => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? check.state));
const reviewed = new Set(); // PRs a reviewer has started; their red CI is the reviewer's to fix, up to TRIES runs
function startReview(pr, row) {
  reviewed.add(pr.number);
  // Each review starts from a clean, current base; the reviewer checks the PR out detached.
  run('git', ['fetch', '-q', 'origin']);
  run('git', ['checkout', '-q', '-f', '--detach', `origin/${base}`], { cwd: reviewTree });
  run('git', ['clean', '-fdq'], { cwd: reviewTree });
  borrowModules(reviewTree);
  launch(row, 'reviewer', `review-${pr.number}`, reviewTree,
    [`PR: #${pr.number}`, `Task: ${pr.task.id}`, `Title: ${pr.task.title}`, `Branch: ${pr.headRefName}`, `Base: ${base}`]);
}
let merges = 0;
let slow = null; // the dispatched slow-suite run being watched
function reviewDone(job) {
  const number = job.PR.slice(1);
  const state = JSON.parse(attempt('gh', ['pr', 'view', number, '--json', 'state']) ?? '{}').state;
  if (state !== 'MERGED') {
    if (labelled(show(job.Task) ?? {}, 'needs-human')) return log(`PR ${job.PR} needs a human; skipping it until the label is gone.`);
    log(`PR ${job.PR}: ${job.agent} exited with ${job.code} without merging.`);
    if (Date.now() - job.started < 120000) down(job.agent);
    return failed(job.Task, 'the review');
  }
  merged(job.Task, number);
}
function merged(id, number) {
  attempt('bd', ['close', id, '--reason', `Merged in PR #${number}`]);
  const path = join(trees, id);
  if (existsSync(path)) attempt('git', ['worktree', 'remove', '--force', path]);
  attempt('git', ['branch', '-D', id]);
  attempt('git', ['push', '-q', 'origin', '--delete', id]); // GitHub keeps merged branches unless asked
  if (tries.delete(id)) saveTries();
  log(`Merged PR #${number} (${id}).`);
  pull();
  if (++merges % SLOW_EVERY === 0) dispatchSlow();
}
// A task in review whose PR left the open list: merged while no reviewer was watching (a crash or a failed
// gh call), closed by hand, or never opened. A merged one is finished here; the rest wait for the owner.
function strays(open) {
  const waiting = json('bd', ['list', '--label', 'in-review', '--status', 'in_progress', '--json', '--limit', '0']) ?? [];
  for (const task of waiting) {
    if (labelled(task, 'needs-human') || open.some(pr => pr.headRefName === task.id) || [...running].some(job => job.Task === task.id)) continue;
    const prs = json('gh', ['pr', 'list', '--head', task.id, '--state', 'all', '--json', 'number,state']) ?? [];
    if (prs.some(pr => pr.state === 'OPEN')) continue; // opened after the open list was read
    const done = prs.find(pr => pr.state === 'MERGED');
    if (done) { merged(task.id, done.number); continue; }
    const why = prs.length ? `its PR #${prs[0].number} is ${prs[0].state.toLowerCase()}` : 'it has no PR';
    attempt('bd', ['update', task.id, '--add-label', 'needs-human']);
    attempt('bd', ['note', task.id, `ralph-afk --pr: labelled in-review but ${why}.`]);
    log(`${task.id} is in review but ${why}; labelled needs-human.`);
  }
}
// The owner's checkout follows GitHub only while it has nothing of its own; the Beads export does not count.
function pull() {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const changes = run('git', ['status', '--porcelain', '--untracked-files=no']).split('\n')
    .filter(line => line && !line.endsWith(' .beads/issues.jsonl'));
  if (branch !== base || changes.length) return log(`Not pulling the main checkout: it is on ${branch} or has local changes.`);
  if (attempt('git', ['pull', '-q', '--ff-only', 'origin', base]) === null) log(`Could not fast-forward the main checkout to origin/${base}.`);
}
function dispatchSlow() {
  const since = new Date(Date.now() - 60000).toISOString(); // a minute of clock skew
  if (attempt('gh', ['workflow', 'run', 'slow-tests.yml', '--ref', base]) === null) return log('Could not start the slow-test workflow.');
  slow = { since, until: Date.now() + 3600000 };
  log(`${merges} merges: started the slow-test workflow.`);
}
function checkSlow() {
  if (!slow) return;
  const runs = json('gh', ['run', 'list', '--workflow', 'slow-tests.yml', '--event', 'workflow_dispatch', '--limit', '1', '--json', 'status,conclusion,url,createdAt']);
  const latest = runs.find(entry => entry.createdAt >= slow.since);
  if (!latest || latest.status !== 'completed') {
    if (Date.now() > slow.until) { log('The slow-test workflow did not finish within an hour; no longer waiting.'); slow = null; }
    return;
  }
  slow = null;
  if (latest.conclusion === 'success') return log('The slow-test workflow passed.');
  const id = createTask('Fix test:slow failures', `The slow-test workflow failed on ${base}: ${latest.url}. Reproduce from the run log, fix every failure and open a PR.`);
  log(`The slow-test workflow failed (${latest.url}); filed ${id ?? 'nothing: bd create failed'}.`);
}
// Same as ralph-afk: bd cannot change a database's prefix, so honour config.yaml's issue-prefix with an explicit ID.
function createTask(title, description) {
  const config = existsSync('.beads/config.yaml') ? readFileSync('.beads/config.yaml', 'utf8') : '';
  const prefix = /^issue-prefix: *"?([^"\n]*)"? *$/m.exec(config)?.[1];
  let id = [];
  if (prefix) {
    let candidate;
    do candidate = `${prefix}-${Math.random().toString(36).slice(2, 5)}`; while (show(candidate));
    id = ['--force', '--id', candidate];
  }
  return attempt('bd', ['create', ...id, '--type', 'task', '--title', title, '--description', description, '--silent']);
}

let stopping = false;
const halt = new AbortController(); // Ctrl+C ends an idle wait at once
const stopAll = () => { for (const job of running) try { process.kill(-job.child.pid, 'SIGTERM'); } catch {} };
function interrupt() {
  if (stopping) { stopAll(); process.exit(130); }
  stopping = true;
  halt.abort();
  log('Stopping after the running agents finish. Press Ctrl+C again to stop now.');
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', () => { stopAll(); process.exit(143); });

function listParked() {
  const parked = json('bd', ['list', '--label', 'needs-human', '--status', 'open,in_progress,blocked', '--json', '--limit', '0']) ?? [];
  if (!parked.length) return;
  const say = screen ? log : console.log;
  say('Waiting for a human:');
  for (const task of parked) say(`  ${task.id} ${task.title}`);
}
const minutes = start => `${Math.floor((Date.now() - start) / 60000)}m`;
function status(prs, waiting) {
  const jobs = [...running];
  log(`Status: ${jobs.filter(job => job.stage === 'worker').length} of ${slots} workers busy, reviewer ${jobs.some(job => job.stage === 'reviewer') ? 'busy' : 'free'}; ${waiting} ready tasks waiting; ${merges} merged this run.`);
  for (const job of jobs) console.log(`  ${job.stage} ${job.name} (${job.agent} ${job.model}, ${minutes(job.started)}): ${job.last ?? 'starting'}`.slice(0, 240));
  for (const pr of prs) console.log(`  ${prState(pr, jobs)}`);
}
function prState(pr, jobs) {
  const ci = !pr.statusCheckRollup?.length ? 'no CI yet' : !settled(pr) ? 'CI running' : passed(pr) ? 'CI passed' : 'CI failed';
  const labels = (pr.task.labels ?? []).filter(label => ['in-review', 'needs-human'].includes(label));
  const agent = jobs.find(job => job.Task === pr.task.id)?.stage;
  return `PR #${pr.number} ${pr.task.id}${labels.length ? ` [${labels.join(', ')}]` : ''}: ${ci}${agent ? `, ${agent} running` : ''}`;
}
function dashboard() {
  const jobs = [...running].sort((a, b) => a.slot - b.slot);
  const workers = jobs.filter(job => job.stage === 'worker').length;
  const reviewer = jobs.some(job => job.stage === 'reviewer') ? 'busy' : 'free';
  return {
    header: [base, `${workers}/${slots} workers busy`, `reviewer ${reviewer}`, `${latest.waiting} ready`, `${merges} merged`,
      ...(idle ? ['out of work'] : []), ...(stopping ? ['stopping'] : [])],
    stopping,
    jobs, prs: latest.prs.map(pr => prState(pr, jobs)), logs: events,
  };
}

let idle = false;
let shown = 0; // when the last status block printed
let latest = { prs: [], waiting: 0 }; // the last check, for the dashboard
if (process.stdin.isTTY && process.stdout.isTTY) screen = startTui(dashboard, interrupt);
log(`PR mode on ${base}: up to ${slots} workers, one reviewer.`);
// One pass over the queue; true once a requested stop has nothing left running.
function poll() {
  const closed = JSON.parse(attempt('bd', ['epic', 'close-eligible', '--json']) ?? '{}').closed ?? [];
  if (closed.length) log(`Closed finished epics: ${closed.join(' ')}`);
  checkSlow();
  const workers = [...running].filter(job => job.stage === 'worker');
  const ready = stopping ? [] : readyTasks().filter(task => !workers.some(job => job.Task === task.id));
  for (const task of ready.slice(0, slots - workers.length)) {
    const row = pick('worker');
    if (!row) { log('No worker agent available now.'); break; }
    startWorker(task, row);
  }
  const open = taskPrs();
  strays(open);
  const prs = open.filter(pr => !labelled(pr.task, 'needs-human'));
  const reviewing = [...running].some(job => job.stage === 'reviewer');
  // A worker labels a PR in-review only on green CI; one that is red anyway waits for the owner.
  for (const pr of prs.filter(pr => labelled(pr.task, 'in-review') && settled(pr) && !passed(pr) && !reviewed.has(pr.number))) {
    attempt('bd', ['update', pr.task.id, '--add-label', 'needs-human']);
    attempt('bd', ['note', pr.task.id, `ralph-afk --pr: PR #${pr.number} is in review but its CI failed.`]);
    log(`PR #${pr.number} is in review but its CI failed; labelled needs-human. Remove in-review too to hand it back to a worker.`);
  }
  const next = prs.find(pr => labelled(pr.task, 'in-review') && settled(pr) && (passed(pr) || reviewed.has(pr.number)));
  if (!stopping && !reviewing && next) {
    const row = pick('reviewer');
    if (row) startReview(next, row);
    else log('No reviewer agent available now; waiting.');
  }
  if (stopping && !running.size) return true;
  // Out of work: keep checking, so tasks filed later start without a restart.
  const nothing = !running.size && !ready.length && !prs.length && !slow;
  if (nothing && !idle) {
    log(`Out of work. Checking for new tasks every ${pollMs / 1000}s; Ctrl+C to stop.`);
    listParked();
  }
  idle = nothing;
  latest = { prs: open, waiting: ready.filter(task => ![...running].some(job => job.Task === task.id)).length };
  // The dashboard shows the same, live.
  if (!screen && !idle && Date.now() - shown >= pollMs) {
    shown = Date.now();
    status(open, latest.waiting);
  }
}
for (;;) {
  // A failed gh, bd or git call (network, rate limit) must not end the run: its agents run detached and would be orphaned.
  try { if (poll()) break; } catch (error) {
    log(`Check failed: ${firstLine(error.stderr || error.message)}; trying again in ${pollMs / 1000}s.`);
    if (stopping && !running.size) break;
  }
  // Once stopping, halt stays aborted and its sleep returns at once: wait for the agents only, or this spins on gh and bd.
  await Promise.race([...(stopping ? [] : [sleep(pollMs, null, { signal: halt.signal }).catch(() => {})]), ...[...running].map(job => job.done)]);
  for (const job of running) {
    if (job.code === undefined) continue;
    running.delete(job);
    progress(job);
    (job.stage === 'worker' ? workerDone : reviewDone)(job);
  }
}

if (screen) {
  screen.stop();
  screen = null;
  log('Dashboard closed; its log is in .ralph-tui/pr-logs/ralph-pr.log.');
}
log('Stop requested. Stopping.');
// Commit the export once here so the next start pushes it with the planning commits.
commitBeads('chore(beads): export after ralph-afk --pr');
listParked();
