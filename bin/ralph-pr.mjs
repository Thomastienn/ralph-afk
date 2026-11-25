// ralph-afk --pr: parallel PR mode. Each worker takes one ready task into its own worktree and
// branch, opens a PR and waits for CI; up to reviewers|N reviewers review, fix and approve green PRs. The
// supervisor squash-merges approved green PRs; the merger agent merges the base into a conflicting one.
// ralph-afk holds the checkout lock and starts this from the repository root. See README.md.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parseAgents } from './ralph-agents.mjs';
import { probe } from './ralph-probe.mjs';
import { agentLabel, startTui } from './ralph-pr-tui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const { env } = process;
const SLOW_FIX = 'Fix test:slow failures'; // the task a failed slow run files
const trees = join(dirname(root), `${basename(root)}-pr`); // outside the checkout, so nothing lands in .gitignore
const logs = join(root, '.ralph-tui/pr-logs');
let agentsFile = env.RALPH_AGENTS || (existsSync('.ralph-tui/agents') ? '.ralph-tui/agents' : join(here, '../agents')); // ralph-afk checked it exists
// A checkout's own .ralph-tui/pr-<stage>.md beats the built-in prompts/pr-<stage>.md.
const prompts = Object.fromEntries(['worker', 'reviewer', 'merger'].map(stage => {
  const own = `.ralph-tui/pr-${stage}.md`;
  return [stage, existsSync(own) ? own : join(here, `../prompts/pr-${stage}.md`)];
}));

let screen = null; // the dashboard, while stdin and stdout are a terminal
const events = []; // the dashboard's log lines
const log = message => {
  const line = `[ralph-pr ${new Date().toLocaleString('sv')}] ${message}`;
  if (!screen) return console.log(line);
  appendFileSync(join(logs, 'ralph-pr.log'), `${line}\n`);
  if (events.push(`${new Date().toLocaleTimeString('sv')} ${message}`) > 200) events.shift();
  screen.draw();
};
// Async, so keys and signals are handled while gh, bd or git runs: q and Ctrl+C answer at once.
const execFileAsync = promisify(execFile);
const run = async (command, args, options = {}) =>
  (await execFileAsync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })).stdout.trim();
const attempt = (command, args, options) => run(command, args, options).catch(() => null);
const json = async (command, args) => JSON.parse(await run(command, args) || 'null');
const fail = message => { console.error(message); process.exit(1); };
const labelled = (issue, ...names) => (issue.labels ?? []).some(label => names.includes(label));
// Beads' git hooks take ~15s each, so the supervisor's own checkouts, pulls and branch deletes skip them: they only
// import .beads/issues.jsonl, an export of this same database, and a delete pushes no commits for the secret scan.
const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const show = async id => { const out = await attempt('bd', ['show', id, '--json']); return out && JSON.parse(out)[0]; };

// Workers share the worker lines with ralph-afk. The settings come from the agents file too, and a change to it
// applies to the next agent started: running agents keep theirs.
let table, slots, reviewerSlots, mergerStage, schedule, waitMs, pollMs, maxTries, slowEvery;
function load() {
  const { rows, settings } = parseAgents(readFileSync(agentsFile, 'utf8'));
  for (const stage of ['worker', 'reviewer']) {
    if (!rows.some(row => row.stage === stage)) throw new Error(`No ${stage} line in ${agentsFile}.`);
  }
  table = rows;
  slots = Number(settings.workers);
  reviewerSlots = Number(settings.reviewers);
  // Without merger lines, the worker lines merge the base into conflicting PRs.
  mergerStage = table.some(row => row.stage === 'merger') ? 'merger' : 'worker';
  schedule = settings.schedule;
  waitMs = Number(settings.wait) * 1000;
  pollMs = Number(settings.poll) * 1000;
  maxTries = Number(settings.tries); // failed agent runs on one task or PR before it needs a human
  slowEvery = Number(settings['slow-every']); // merges between slow-suite runs on GitHub
}
try { load(); } catch (error) { fail(error.message.startsWith('line ') ? `${agentsFile} ${error.message}.` : error.message); }
let loaded = statSync(agentsFile).mtimeMs;
// The mode lines change who does the work, so they apply only at the next start.
const modes = () => table.filter(row => !row.model).map(row => `${row.stage}|${row.agent}`).sort().join(' ');
const startModes = modes();
function reload() {
  const mtime = statSync(agentsFile, { throwIfNoEntry: false })?.mtimeMs;
  if (!mtime || mtime === loaded) return;
  loaded = mtime;
  try { load(); } catch (error) { return log(`Not applying ${agentsFile}: ${error.message}`); }
  log(`Applied ${agentsFile}: up to ${slots} workers and ${reviewerSlots} reviewers; running agents keep their settings.`);
  if (modes() !== startModes) log('worker|human, reviewer|human and reviewer|none apply at the next start of ralph-afk --pr.');
}
// reviewer|human: the owner reviews and merges on GitHub; the other reviewer lines are ignored.
const human = table.some(row => row.stage === 'reviewer' && row.agent === 'human');
// worker|human: the owner writes the code on a branch named after the task; no worker agent runs.
const humanWorker = table.some(row => row.stage === 'worker' && row.agent === 'human');
// reviewer|none: no review at all; the supervisor squash-merges each in-review PR once its CI passed.
// Otherwise it merges the PRs a reviewer labelled approved.
const noReview = !human && table.some(row => row.stage === 'reviewer' && row.agent === 'none');
if (noReview && humanWorker) fail(`${agentsFile} has worker|human and reviewer|none: use \`gh pr merge --auto\` on your own PRs instead.`);
if (human && humanWorker) fail(`${agentsFile} has worker|human and reviewer|human: that leaves ralph-afk --pr nothing to do.`);

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
async function usable(row) {
  const known = probed.get(row.agent);
  if (known && known.until > Date.now()) return known.ok;
  const { ok, until } = await probe(row.agent);
  // A limited agent is not probed before its reported reset; with none, it waits wait seconds.
  probed.set(row.agent, { ok, until: until || Date.now() + waitMs });
  if (!ok) log(`${row.agent} is not usable now (usage limit, auth or network).`);
  return ok;
}
// The first usable agent of the stage in table order.
async function pick(stage) {
  for (const row of table) if (row.stage === stage && scheduled().includes(row.agent) && await usable(row)) return row;
}
const down = agent => probed.set(agent, { ok: false, until: Date.now() + waitMs });

const commonGit = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
function command(row, prompt, session, resuming) {
  const { effort } = row;
  if (row.agent === 'claude') {
    return ['claude', ['-p', '--permission-mode', 'auto', '--model', row.model, ...(effort ? ['--effort', effort] : []), resuming ? '--resume' : '--session-id', session, prompt]];
  }
  // Commits and bd writes land in the main checkout's .git and .beads, outside the worktree sandbox.
  const roots = JSON.stringify([commonGit, join(root, '.beads')]);
  return ['codex', ['exec', '--approve-for-me', '-m', row.model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-c', `sandbox_workspace_write.writable_roots=${roots}`, '-c', 'sandbox_workspace_write.network_access=true', ...(resuming ? ['resume', session] : []), prompt]];
}
const running = new Set();
// GitHub runs no CI on a conflicting PR and a reviewer starts only after CI passed, so an agent waiting on it waits forever.
const catchUp = () => `Before every wait on CI: when \`gh pr view <branch> --json mergeable\` says CONFLICTING, run \`git fetch origin ${base}\` and \`git merge origin/${base}\`, resolve the conflicts, commit and push. UNKNOWN means GitHub is still computing it: ask again after a few seconds.`;
// Tells agents what bin/guard/gh refuses, so they do not spend turns on blocked calls.
const guarded = 'Anyone can comment on or open PRs and issues here, so `gh` refuses calls that return text other accounts can write: issues, search, PR comments and reviews (`--comments`, `--json` with comments or reviews, their `gh api` paths), notifications, `gh status`, `gh run list`, `gh workflow view` and `gh pr list` without `--author @me`. Use `gh pr view <pr>` and `gh pr list --author @me`; when the owner left review comments, they are in this prompt.';
const brief = (stage, facts) => `${readFileSync(prompts[stage], 'utf8')}\n\n## This run\n\n${facts.join('\n')}\n\n${catchUp()}\n\n${guarded}\n`;
// resume: { message } replaces the prompt; with an id too, it goes to that existing session.
function launch(row, stage, name, cwd, facts, resume) {
  const prompt = resume?.message ?? brief(stage, facts);
  // Claude takes its session id up front; Codex's is read from its session file afterwards.
  const session = resume?.id ?? randomUUID();
  const [bin, args] = command(row, prompt, session, Boolean(resume?.id));
  const logFile = join(logs, `${name}.log`);
  // A task's log and a resumed session file already hold earlier runs: show only this run's steps.
  const file = row.agent === 'claude' ? join(claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`) : logFile;
  const offset = existsSync(file) ? statSync(file).size : 0;
  const out = openSync(logFile, 'a');
  // detached: Ctrl+C in this terminal reaches only the supervisor, never a running agent.
  // The watcher ends the agent's group once this supervisor is gone, even after kill -9 or a closed terminal.
  const watch = `(while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -TERM 0) & w=$!; "$@"; s=$?; kill $w 2>/dev/null; exit $s`;
  // bin/guard/gh first: agents cannot read GitHub text that other accounts wrote.
  const child = spawn('sh', ['-c', watch, 'sh', bin, ...args], { cwd, stdio: ['ignore', out, out], detached: true, env: { ...process.env, PATH: `${join(here, 'guard')}:${process.env.PATH}` } });
  closeSync(out);
  let slot = 1; // a panel keeps its number while its agent runs
  while ([...running].some(job => job.slot === slot)) slot++;
  const job = { slot, steps: [], stage, name, agent: row.agent, model: row.model, effort: row.effort, cwd, file, offset, session: row.agent === 'claude' ? session : null, started: Date.now(), child, ...Object.fromEntries(facts.map(fact => [fact.slice(0, fact.indexOf(': ')), fact.slice(fact.indexOf(': ') + 2)])) };
  job.done = new Promise(resolve => {
    child.on('exit', code => resolve((job.code = code ?? 1)));
    child.on('error', error => { log(`Could not start ${bin}: ${error.message}`); resolve((job.code = 127)); });
  });
  running.add(job);
  log(`Started ${agentLabel(row)} as ${stage} for ${name}; log: .ralph-tui/pr-logs/${name}.log`);
  return job;
}

// Each agent's steps stream here as they happen. `claude -p` writes its log only at exit, so Claude's steps
// come from its live session transcript; Codex writes its own steps to the log as it goes.
const claudeProjects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const firstLine = text => String(text ?? '').trim().split('\n')[0];
function claudeSteps(text, job) {
  let entry;
  try { entry = JSON.parse(text); } catch { return []; }
  // Context size is the prompt the last reply was sent with: fresh, cached and newly cached tokens.
  const usage = entry.type === 'assistant' && entry.message?.usage;
  if (usage) job.context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
  return content.map(part => {
    const input = part.input ?? {};
    if (entry.type === 'assistant' && part.type === 'text') return firstLine(part.text);
    if (entry.type === 'assistant' && part.type === 'tool_use') return `${part.name}: ${firstLine(input.description ?? input.command ?? input.file_path ?? input.pattern)}`;
    if (part.type !== 'tool_result' || !part.is_error) return '';
    return `error: ${firstLine(Array.isArray(part.content) ? part.content.map(piece => piece.text ?? '').join('\n') : part.content)}`;
  });
}
// The complete lines added to file since the last look; job[key] keeps the place.
function newLines(job, key, file) {
  const fd = openSync(file, 'r'); // read from the saved byte offset only: logs grow for hours
  let fresh;
  try {
    fresh = Buffer.alloc(Math.max(0, fstatSync(fd).size - (job[key] ?? 0)));
    fresh = fresh.subarray(0, readSync(fd, fresh, 0, fresh.length, job[key] ?? 0));
  } finally { closeSync(fd); }
  const end = fresh.lastIndexOf('\n') + 1; // a line still being written waits for the next look
  job[key] = (job[key] ?? 0) + end;
  return fresh.subarray(0, end).toString('utf8').split('\n');
}
function progress(job) {
  if (!existsSync(job.file)) return;
  // shortcut: Codex lines are printed raw, its echoed prompt and command output included; parse its session file if that is too noisy.
  for (const text of newLines(job, 'offset', job.file)) {
    for (const step of job.agent === 'claude' ? claudeSteps(text, job) : [text.trim()]) {
      if (!step) continue;
      job.last = step;
      if (job.steps.push(step) > 1000) job.steps.shift();
      if (!screen) log(`${job.name}: ${step}`.slice(0, 240));
    }
  }
}
// Codex logs no token counts, but its session file under sessions/YYYY/MM/DD does; the first line names the working directory.
const codexSessions = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
function codexSession(job) {
  const day = time => { const d = new Date(time); return join(codexSessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); };
  const cwdOf = file => { try { return JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]).payload?.cwd; } catch { return null; } };
  return [...new Set([day(job.started), day(Date.now())])].filter(dir => existsSync(dir))
    .flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)))
    .map(file => ({ file, time: statSync(file).mtimeMs })).filter(entry => entry.time >= job.started)
    .sort((a, b) => b.time - a.time).find(entry => cwdOf(entry.file) === job.cwd)?.file ?? null;
}
function codexContext(job) {
  if (job.agent !== 'codex') return;
  job.sessionFile ??= codexSession(job);
  if (!job.sessionFile) return;
  for (const text of newLines(job, 'sessionOffset', job.sessionFile)) {
    if (!text.includes('"token_count"')) continue;
    // input_tokens already counts the cached ones.
    try { job.context = JSON.parse(text).payload?.info?.last_token_usage?.input_tokens ?? job.context; } catch {}
  }
}
setInterval(() => { for (const job of running) { progress(job); codexContext(job); } screen?.draw(); }, 2000).unref();

// Kept on disk, so a restart does not give a failing task maxTries more runs.
const triesFile = join(logs, 'tries.json');
const tries = new Map(Object.entries(existsSync(triesFile) ? JSON.parse(readFileSync(triesFile, 'utf8')) : {}));
const saveTries = () => writeFileSync(triesFile, JSON.stringify(Object.fromEntries(tries)));
// reviewer|human: task -> { agent, model, effort, id, since }, the session to resume with the owner's review. Only reviews
// and comments after since are new: the worker's end, or a fix's start, so one posted while a fix runs gets its own fix.
const sessionsFile = join(logs, 'sessions.json');
const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, 'utf8')) : {};
const saveSessions = () => writeFileSync(sessionsFile, JSON.stringify(sessions));
// A task or PR that keeps failing waits for the owner instead of spinning.
async function failed(id, what) {
  const n = (tries.get(id) ?? 0) + 1;
  // Label before the count resets: a hard stop in between must not hand the task maxTries fresh runs.
  if (n >= maxTries) {
    await attempt('bd', ['update', id, '--add-label', 'needs-human']);
    await attempt('bd', ['note', id, `ralph-afk --pr: ${what} failed ${n} times; see .ralph-tui/pr-logs/.`]);
  }
  if (n < maxTries) tries.set(id, n);
  else tries.delete(id); // the owner removing needs-human gives it maxTries fresh runs
  saveTries();
  if (n >= maxTries) log(`${id} failed ${n} times; labelled needs-human.`);
  return n >= maxTries;
}

const base = (await json('gh', ['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef.name;
const me = await run('gh', ['api', 'user', '--jq', '.login']); // the owner: only this account's PRs and comments reach agents
const mine = item => (item.author ?? item.user)?.login === me && item.state !== 'PENDING';
mkdirSync(logs, { recursive: true });
mkdirSync(trees, { recursive: true });
// Workers never commit the Beads export, so the supervisor does, on the default branch only.
async function commitBeads(message) {
  if (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== base || !await run('git', ['status', '--porcelain', '--', '.beads/issues.jsonl'])) return;
  if (await attempt('git', ['commit', '-q', '-m', message, '--', '.beads/issues.jsonl']) !== null) log('Committed the Beads export.');
}
// Workers branch from origin, so uncommitted planning work would miss them. Never commit it blindly: it gets pushed.
// With worker|human no worker branches here, and the owner's own work in progress may be in this checkout.
await commitBeads('chore(beads): export before ralph-afk --pr');
const dirty = !humanWorker && await run('git', ['status', '--porcelain', '--', '.', ':!.ralph-tui', ':!.beads/issues.jsonl']);
if (dirty) fail(`Uncommitted changes; commit or stash them first:\n${dirty}`);
// The owner's planning commits must reach GitHub before workers branch from it.
try { await run('git', ['push', '-q', 'origin', base], { stdio: ['ignore', 'pipe', 'inherit'] }); }
catch { fail(`Could not push local ${base} to origin; fix that first (diverged, or the pre-push secret scan refused).`); }
await run('git', ['fetch', '-q', 'origin']);
// A previous run stopped mid-task: give its unfinished claims back. The rest are the supervisor's own worktrees.
for (const id of readdirSync(trees).filter(name => !/^(reviewer(-\d+)?|merger)$/.test(name))) {
  const task = await show(id);
  if (task?.status === 'in_progress' && !labelled(task, 'in-review')) await attempt('bd', ['unclaim', id]);
}

const reminded = new Set();
async function readyTasks() {
  const epics = new Map((await json('bd', ['ready', '--type', 'epic', '--sort', 'oldest', '--json', '--limit', '0']))
    .filter(epic => !labelled(epic, 'gate:backlog')).map((epic, index) => [epic.id, index]));
  // Parentless tasks (fixes filed mid-run) first, then by epic age; bd's own order within an epic.
  return (await json('bd', ['ready', '--json', '--limit', '0']))
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
  if (!existsSync(join(root, 'node_modules')) || existsSync(join(path, 'node_modules'))) return;
  symlinkSync(join(root, 'node_modules'), join(path, 'node_modules'));
  // A `node_modules/` ignore line matches folders only, so `git add -A` in the worktree would commit the link.
  const exclude = join(commonGit, 'info/exclude');
  const lines = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (/^node_modules$/m.test(lines)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${lines && !lines.endsWith('\n') ? '\n' : ''}node_modules\n`);
}
async function startWorker(task, row) {
  const path = join(trees, task.id);
  // The worktree comes before the claim: a hard stop in between leaves the task open, and the next pass takes it.
  // A claim without a worktree would stay claimed: the restart only gives back claims that have one.
  try {
    if (!existsSync(path)) {
      await run('git', ['fetch', '-q', 'origin']);
      await pushBase();
      const branch = await attempt('git', ['rev-parse', '-q', '--verify', `refs/heads/${task.id}`]);
      await run('git', [...noHooks, 'worktree', 'add', '-q', ...(branch ? [path, task.id] : ['-b', task.id, path, `origin/${base}`])]);
    }
    borrowModules(path);
  } catch (error) {
    log(`Could not make the worktree for ${task.id}: ${error.stderr || error.message}`);
    return failed(task.id, 'making the worktree');
  }
  if (stopping) return; // q came during the git calls: no new agent, and the task stays open
  if (await attempt('bd', ['update', task.id, '--claim']) === null) return;
  launch(row, 'worker', task.id, path, [`Task: ${task.id}`, `Title: ${task.title}`, `Branch: ${task.id}`, `Base: ${base}`]);
}
// A task added while this runs may come with planning commits; workers branch from origin, so push them first.
async function pushBase() {
  if (await run('git', ['rev-list', '--count', `origin/${base}..${base}`]) === '0') return;
  if (await attempt('git', ['push', '-q', 'origin', base]) !== null) return log(`Pushed the new commits on ${base} to origin.`);
  log(`Could not push local ${base} to origin; workers branch from origin/${base} without its new commits.`);
}
async function workerDone(job) {
  const task = await show(job.Task);
  // A fix run keeps in-review on, so only its exit code says whether it finished.
  if (task && (task.status === 'closed' || labelled(task, 'in-review')) && !(job.fix && job.code)) {
    log(`${job.Task}: PR in review.`);
    if (human && task.status !== 'closed') hold(job);
    return;
  }
  if (job.fix) {
    log(`${job.Task}: ${job.agent} exited with ${job.code} before fixing the review; a fresh agent tries next.`);
    if (Date.now() - job.started < 120000) down(job.agent);
    sessions[job.Task].id = null;
    saveSessions();
    return failed(job.Task, 'fixing the review');
  }
  if (task && labelled(task, 'needs-human')) {
    await attempt('bd', ['unclaim', job.Task]);
    return log(`${job.Task} needs a human; other work continues.`);
  }
  log(`${job.Task}: ${job.agent} exited with ${job.code} before the PR was in review; the task is ready again.`);
  if (Date.now() - job.started < 120000) down(job.agent);
  // Count first: a hard stop between the two leaves a claim with a worktree, which the restart gives back.
  await failed(job.Task, 'the worker');
  await attempt('bd', ['unclaim', job.Task]);
}

// The PR waits for the owner's review: keep the worker's session for it, compacted so a fix starts from a short context.
function hold(job) {
  if (job.agent === 'codex') job.sessionFile ??= codexSession(job);
  // A Codex session file starts with its session_meta line, which holds the id.
  const id = job.session ?? (job.sessionFile ? JSON.parse(readFileSync(job.sessionFile, 'utf8').split('\n', 1)[0]).payload?.id : null);
  sessions[job.Task] = { agent: job.agent, model: job.model, effort: job.effort, id, since: new Date(job.fix ? job.started : Date.now()).toISOString() };
  saveSessions();
  log(`${job.Task}: waiting for your review on GitHub.`);
  // shortcut: only Claude is compacted; codex exec resume <id> /compact is untested. Codex compacts itself near its limit.
  if (job.agent !== 'claude' || stopping) return; // a stop starts no agent; a fix then resumes the session as it is
  launch(job, 'worker', job.Task, job.cwd, [`Task: ${job.Task}`, `Title: ${job.Title}`], { id, message: '/compact' }).compact = true;
}
function compactDone(job) {
  log(job.code ? `${job.Task}: could not compact the session (exit ${job.code}); a fix resumes it as it is.` : `${job.Task}: session compacted.`);
}
// The owner reviewed or commented since the last run: the same session fixes it; a fresh worker if that agent cannot run.
async function startFix(pr, held) {
  // Read here, filtered to the owner: bin/guard/gh keeps the agent from reading comments on GitHub.
  const since = Date.parse(held.since);
  // --paginate prints one array per page; --jq '.[]' turns them into one comment per line (gh has no --slurp before 2.48).
  const api = async path => (await run('gh', ['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/${path}?per_page=100`, '--jq', '.[]'])).split('\n').filter(Boolean).map(line => JSON.parse(line));
  // An inline comment carries the time it was drafted, so it counts from its review's submission; still pending, null drops it.
  const submitted = new Map((await api('reviews')).map(review => [review.id, review.submitted_at ?? null]));
  const inline = (await api('comments')).map(comment => submitted.has(comment.pull_request_review_id) ? { ...comment, created_at: submitted.get(comment.pull_request_review_id) } : comment);
  const said = [...pr.reviews, ...pr.comments, ...inline]
    .map(item => ({ ...item, at: Date.parse(item.submittedAt ?? item.createdAt ?? item.created_at) }))
    .filter(item => mine(item) && item.at > since && item.body)
    .sort((a, b) => a.at - b.at)
    .map(item => `- ${item.path ? `${item.path}:${item.line ?? item.original_line}: ` : ''}${item.body}`);
  const ask = `The owner reviewed PR #${pr.number} on GitHub after ${held.since}. What they wrote since then, oldest first:\n${said.join('\n')}\nDo what they ask, commit and push, then wait for CI until it passes, as before. Do not merge, and do not comment on or review the PR: the owner's next comment starts the next fix. ${catchUp()}`;
  const facts = [`Task: ${pr.task.id}`, `Title: ${pr.task.title}`, `Branch: ${pr.headRefName}`, `Base: ${base}`];
  const same = held.id && scheduled().includes(held.agent) && await usable(held);
  const row = same ? held : await pick('worker');
  if (!row) return log(`No worker agent available now to fix your review of PR #${pr.number}.`);
  if (stopping) return; // q came during the calls above: the review stays new for the next run
  const resume = same ? { id: held.id, message: ask } : { message: `${brief('worker', facts)}\n${ask}\n` };
  launch(row, 'worker', pr.task.id, join(trees, pr.task.id), facts, resume).fix = true;
}

// Open PRs whose branch is a Beads task still open here, oldest first.
async function taskPrs() {
  const prs = await json('gh', ['pr', 'list', '--state', 'open', '--author', me, '--limit', '100', '--json', `number,headRefName,title,statusCheckRollup${human ? ',reviews,comments,commits' : ',mergeable'}`]);
  for (const pr of prs) pr.task = await show(pr.headRefName); // one at a time, as before: bd calls share one database
  return prs
    .filter(pr => pr.task && pr.task.status !== 'closed')
    .sort((a, b) => a.number - b.number);
}
const settled = pr => pr.statusCheckRollup?.length &&
  pr.statusCheckRollup.every(check => (check.status ?? 'COMPLETED') === 'COMPLETED' && !['PENDING', 'EXPECTED'].includes(check.state));
// Check runs report a conclusion, commit statuses a state.
const passed = pr => pr.statusCheckRollup.every(check => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? check.state));
// PRs a reviewer has started; their red CI is the reviewer's to fix, up to maxTries runs. Kept on disk: a reviewer
// stopped mid-fix leaves red CI that is still its own after a restart.
const reviewedFile = join(logs, 'reviewed.json');
const reviewed = new Set(existsSync(reviewedFile) ? JSON.parse(readFileSync(reviewedFile, 'utf8')) : []);
const saveReviewed = () => writeFileSync(reviewedFile, JSON.stringify([...reviewed]));
// Each reviewer and merger run starts from a clean, current base in the supervisor's own worktree; the agent checks the PR out detached.
async function freshTree(name) {
  const path = join(trees, name);
  await run('git', ['fetch', '-q', 'origin']);
  if (!existsSync(path)) await run('git', [...noHooks, 'worktree', 'add', '-q', '--detach', path, `origin/${base}`]);
  await run('git', [...noHooks, 'checkout', '-q', '-f', '--detach', `origin/${base}`], { cwd: path });
  await run('git', ['clean', '-fdq'], { cwd: path });
  borrowModules(path);
  return path;
}
const prFacts = pr => [`PR: #${pr.number}`, `Task: ${pr.task.id}`, `Title: ${pr.task.title}`, `Branch: ${pr.headRefName}`, `Base: ${base}`];
async function startReview(pr, row) {
  reviewed.add(pr.number);
  saveReviewed();
  let n = 1; // the first reviewer worktree no running reviewer uses
  while ([...running].some(job => job.cwd === join(trees, `reviewer-${n}`))) n++;
  const path = await freshTree(`reviewer-${n}`);
  if (stopping) return; // q came during the git calls: no new agent
  launch(row, 'reviewer', `review-${pr.number}`, path, prFacts(pr));
}
async function startMerger(pr) {
  const row = await pick(mergerStage);
  if (!row) return log(`No ${mergerStage} agent available now to merge ${base} into PR #${pr.number}; waiting.`);
  if (stopping) return;
  const path = await freshTree('merger');
  if (stopping) return;
  log(`PR #${pr.number} (${pr.task.id}) conflicts with ${base}; the merger merges ${base} into it.`);
  launch(row, 'merger', `merge-${pr.number}`, path, prFacts(pr));
}
// The reviewer takes the PR that unblocks the most open tasks first, counting the tasks those block in turn.
async function blocking() {
  const blocks = new Map(); // task -> the open tasks waiting on it directly
  for (const issue of await json('bd', ['list', '--status', 'open,in_progress,blocked', '--json', '--limit', '0']) ?? []) {
    for (const dep of issue.dependencies ?? []) if (dep.type === 'blocks') blocks.set(dep.depends_on_id, [...(blocks.get(dep.depends_on_id) ?? []), issue.id]);
  }
  return id => {
    const seen = new Set();
    for (const todo = [id]; todo.length;) for (const next of blocks.get(todo.pop()) ?? []) if (!seen.has(next)) { seen.add(next); todo.push(next); }
    return seen.size;
  };
}
// The supervisor merges approved PRs (with reviewer|none, every PR in review) and starts reviews for the rest.
async function advance(waiting) {
  const approved = pr => labelled(pr.task, noReview ? 'in-review' : 'approved');
  // A reviewer's fix or the merger's merge turned CI red: a reviewer fixes it, up to maxTries times.
  for (const pr of noReview ? [] : waiting.filter(pr => approved(pr) && settled(pr) && !passed(pr))) {
    if (await attempt('bd', ['update', pr.task.id, '--remove-label', 'approved']) === null) continue;
    pr.task.labels = pr.task.labels.filter(label => label !== 'approved');
    log(`PR #${pr.number} (${pr.task.id}): CI failed after the review; back to a reviewer.`);
    if (await failed(pr.task.id, 'CI after the review')) pr.task.labels.push('needs-human');
  }
  const review = noReview ? [] : waiting.filter(pr => !labelled(pr.task, 'approved', 'needs-human') && settled(pr) && (passed(pr) || reviewed.has(pr.number)));
  const done = waiting.filter(approved);
  if (!review.length && !done.length) return;
  const blocks = await blocking();
  const first = list => list.sort((a, b) => blocks(b.task.id) - blocks(a.task.id)); // stable: the oldest PR on a tie
  // One merge per check, since each merge can make the other PRs conflict. Merge before the merger starts, so it merges the newest base.
  const green = first(done.filter(pr => pr.mergeable === 'MERGEABLE' && settled(pr) && passed(pr)))[0];
  if (green) await merge(green);
  const conflict = first(done.filter(pr => pr !== green && pr.mergeable === 'CONFLICTING'))[0];
  if (conflict && ![...running].some(job => job.stage === 'merger')) await startMerger(conflict);
  let free = reviewerSlots - [...running].filter(job => job.stage === 'reviewer').length;
  for (const pr of first(review)) {
    if (free-- <= 0 || stopping) break;
    const row = await pick('reviewer');
    if (!row) { log('No reviewer agent available now; waiting.'); break; }
    if (!stopping) await startReview(pr, row); // not when q was pressed while the probe ran
  }
}
async function merge(pr) {
  if (await attempt('gh', ['pr', 'merge', String(pr.number), '--squash', '--subject', `task: ${pr.task.id} ${pr.task.title}`]) === null) {
    log(`Could not merge PR #${pr.number} (${pr.task.id}).`);
    return failed(pr.task.id, 'merging');
  }
  await merged(pr.task.id, pr.number);
}
let merges = 0;
let slow = null; // the dispatched slow-suite run being watched
async function reviewDone(job) {
  const number = job.PR.slice(1);
  const state = JSON.parse(await attempt('gh', ['pr', 'view', number, '--json', 'state']) ?? '{}').state;
  if (state === 'MERGED') return merged(job.Task, number); // a project's own older reviewer prompt may still merge
  const task = await show(job.Task) ?? {};
  if (labelled(task, 'needs-human')) return log(`PR ${job.PR} needs a human; skipping it until the label is gone.`);
  if (labelled(task, 'approved')) return log(`PR ${job.PR} approved; it merges once its CI passes.`);
  log(`PR ${job.PR}: ${job.agent} exited with ${job.code} without approving.`);
  if (Date.now() - job.started < 120000) down(job.agent);
  return failed(job.Task, 'the review');
}
async function mergerDone(job) {
  const pr = JSON.parse(await attempt('gh', ['pr', 'view', job.PR.slice(1), '--json', 'mergeable']) ?? '{}');
  if (!job.code && pr.mergeable !== 'CONFLICTING') return log(`PR ${job.PR}: merged ${base} into it; it merges once its CI passes.`);
  if (labelled(await show(job.Task) ?? {}, 'needs-human')) return log(`PR ${job.PR} needs a human; skipping it until the label is gone.`);
  log(`PR ${job.PR}: ${job.agent} exited with ${job.code}${pr.mergeable === 'CONFLICTING' ? ` and it still conflicts with ${base}` : ''}.`);
  if (Date.now() - job.started < 120000) down(job.agent);
  return failed(job.Task, `merging ${base}`);
}
async function merged(id, number) {
  // Close last: a hard stop before it leaves the task in review with a merged PR, and strays() redoes all of this.
  const path = join(trees, id);
  if (existsSync(path)) await attempt('git', ['worktree', 'remove', '--force', path]);
  await attempt('git', ['branch', '-D', id]);
  await attempt('git', [...noHooks, 'push', '-q', 'origin', '--delete', id]); // GitHub keeps merged branches unless asked
  await attempt('bd', ['close', id, '--reason', `Merged in PR #${number}`]);
  if (tries.delete(id)) saveTries();
  if (delete sessions[id]) saveSessions();
  if (reviewed.delete(Number(number))) saveReviewed();
  log(`Merged PR #${number} (${id}).`);
  await pull();
  if (++merges % slowEvery === 0) await dispatchSlow();
}
// A task in review whose PR left the open list: merged while no reviewer was watching (a crash or a failed
// gh call), closed by hand, or never opened. A merged one is finished here; the rest wait for the owner.
async function strays(open) {
  const waiting = await json('bd', ['list', '--label', 'in-review', '--status', 'in_progress', '--json', '--limit', '0']) ?? [];
  for (const task of waiting) {
    if (labelled(task, 'needs-human') || open.some(pr => pr.headRefName === task.id) || [...running].some(job => job.Task === task.id)) continue;
    const prs = await json('gh', ['pr', 'list', '--head', task.id, '--author', me, '--state', 'all', '--json', 'number,state']) ?? [];
    if (prs.some(pr => pr.state === 'OPEN')) continue; // opened after the open list was read
    const done = prs.find(pr => pr.state === 'MERGED');
    if (done) { await merged(task.id, done.number); continue; }
    const why = prs.length ? `its PR #${prs[0].number} is ${prs[0].state.toLowerCase()}` : 'it has no PR';
    await attempt('bd', ['update', task.id, '--add-label', 'needs-human']);
    await attempt('bd', ['note', task.id, `ralph-afk --pr: labelled in-review but ${why}.`]);
    log(`${task.id} is in review but ${why}; labelled needs-human.`);
  }
}
// The owner's checkout follows GitHub only while it has nothing of its own; the Beads export does not count.
async function pull() {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const changes = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).split('\n')
    .filter(line => line && !line.endsWith(' .beads/issues.jsonl'));
  if (branch !== base || changes.length) return log(`Not pulling the main checkout: it is on ${branch} or has local changes.`);
  if (await attempt('git', [...noHooks, 'pull', '-q', '--ff-only', 'origin', base]) === null) log(`Could not fast-forward the main checkout to origin/${base}.`);
}
async function dispatchSlow() {
  // A second run before the open fix merges fails the same way and files a duplicate task.
  const pending = await json('bd', ['list', '--title', SLOW_FIX, '--json', '--limit', '0']);
  if (pending?.length) return log(`${pending[0].id} still fixes the last slow-test failure; not starting the slow-test workflow.`);
  const since = new Date(Date.now() - 60000).toISOString(); // a minute of clock skew
  if (await attempt('gh', ['workflow', 'run', 'slow-tests.yml', '--ref', base]) === null) return log('Could not start the slow-test workflow.');
  slow = { since, until: Date.now() + 3600000 };
  log(`${merges} merges: started the slow-test workflow.`);
}
async function checkSlow() {
  if (!slow) return;
  const runs = await json('gh', ['run', 'list', '--workflow', 'slow-tests.yml', '--event', 'workflow_dispatch', '--limit', '1', '--json', 'status,conclusion,url,createdAt']);
  const latest = runs.find(entry => entry.createdAt >= slow.since);
  if (!latest || latest.status !== 'completed') {
    if (Date.now() > slow.until) { log('The slow-test workflow did not finish within an hour; no longer waiting.'); slow = null; }
    return;
  }
  slow = null;
  if (latest.conclusion === 'success') return log('The slow-test workflow passed.');
  const id = await createTask(SLOW_FIX, `The slow-test workflow failed on ${base}: ${latest.url}. Reproduce from the run log, fix every failure and open a PR.`);
  log(`The slow-test workflow failed (${latest.url}); filed ${id ?? 'nothing: bd create failed'}.`);
}
// Same as ralph-afk: bd cannot change a database's prefix, so honour config.yaml's issue-prefix with an explicit ID.
async function createTask(title, description) {
  const config = existsSync('.beads/config.yaml') ? readFileSync('.beads/config.yaml', 'utf8') : '';
  const prefix = /^issue-prefix: *"?([^"\n]*)"? *$/m.exec(config)?.[1];
  let id = [];
  if (prefix) {
    let candidate;
    do candidate = `${prefix}-${Math.random().toString(36).slice(2, 5)}`; while (await show(candidate));
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

async function listParked() {
  const parked = await json('bd', ['list', '--label', 'needs-human', '--status', 'open,in_progress,blocked', '--json', '--limit', '0']) ?? [];
  if (!parked.length) return;
  const say = screen ? log : console.log;
  say('Waiting for a human:');
  for (const task of parked) say(`  ${task.id} ${task.title}`);
}
const minutes = start => `${Math.floor((Date.now() - start) / 60000)}m`;
// The reviewer and merger fields of the status line and the dashboard header.
function reviewFields(jobs, count) {
  if (human) return ['reviewer you'];
  const merger = `merger ${jobs.some(job => job.stage === 'merger') ? 'busy' : 'free'}`;
  if (noReview) return ['reviewer none', merger];
  return [`${count(jobs.filter(job => job.stage === 'reviewer').length, reviewerSlots)} reviewers busy`, merger];
}
function status(prs, waiting) {
  const jobs = [...running];
  log(`Status: ${humanWorker ? 'worker you' : `${jobs.filter(job => job.stage === 'worker').length} of ${slots} workers busy`}, ${reviewFields(jobs, (n, of) => `${n} of ${of}`).join(', ')}; ${waiting} ready tasks waiting; ${merges} merged this run.`);
  for (const job of jobs) console.log(`  ${job.stage} ${job.name} (${agentLabel(job)}, ${minutes(job.started)}): ${job.last ?? 'starting'}`.slice(0, 240));
  for (const pr of prs) console.log(`  ${prState(pr, jobs)}`);
}
function prState(pr, jobs) {
  const ci = !pr.statusCheckRollup?.length ? 'no CI yet' : !settled(pr) ? 'CI running' : passed(pr) ? 'CI passed' : 'CI failed';
  const labels = (pr.task.labels ?? []).filter(label => ['in-review', 'approved', 'needs-human'].includes(label));
  const agent = jobs.find(job => job.Task === pr.task.id)?.stage;
  return `PR #${pr.number} ${pr.task.id}${labels.length ? ` [${labels.join(', ')}]` : ''}: ${ci}${agent ? `, ${agent} running` : ''}`;
}
function dashboard() {
  const jobs = [...running].sort((a, b) => a.slot - b.slot);
  const workers = jobs.filter(job => job.stage === 'worker').length;
  return {
    header: [base, humanWorker ? 'worker you' : `${workers}/${slots} workers busy`, ...reviewFields(jobs, (n, of) => `${n}/${of}`), `${latest.waiting} ready`, `${merges} merged`,
      ...(idle ? ['out of work'] : []), ...(stopping ? ['stopping'] : [])],
    stopping,
    jobs, prs: latest.prs.map(pr => prState(pr, jobs)), logs: events,
  };
}

let idle = false;
let shown = 0; // when the last status block printed
let latest = { prs: [], waiting: 0 }; // the last check, for the dashboard
let wake = () => {}; // a save in the settings view ends the wait, so a new worker count applies at once
// The settings view saves to the project's own file, so a change made here never reaches other projects: the first
// save copies the shared file there. RALPH_AGENTS names the file to use, so that one is edited in place.
const own = env.RALPH_AGENTS ? agentsFile : '.ralph-tui/agents';
if (process.stdin.isTTY && process.stdout.isTTY) screen = startTui(dashboard, interrupt, () => agentsFile, own, () => { agentsFile = own; reload(); wake(); });
log(`PR mode on ${base}: ${humanWorker ? 'you write the code' : `up to ${slots} workers`}, ${human ? 'you review on GitHub' : noReview ? 'no reviewer, green PRs merge at once' : `up to ${reviewerSlots} reviewers`}.`);
// One pass over the queue; true once a requested stop has nothing left running.
async function poll() {
  reload();
  const closed = JSON.parse(await attempt('bd', ['epic', 'close-eligible', '--json']) ?? '{}').closed ?? [];
  if (closed.length) log(`Closed finished epics: ${closed.join(' ')}`);
  await checkSlow();
  const workers = [...running].filter(job => job.stage === 'worker');
  const ready = stopping ? [] : (await readyTasks()).filter(task => !workers.some(job => job.Task === task.id));
  for (const task of humanWorker ? [] : ready.slice(0, Math.max(0, slots - workers.length))) { // the count may have dropped
    const row = await pick('worker');
    if (stopping) break; // q pressed while the probe ran
    if (!row) { log('No worker agent available now.'); break; }
    await startWorker(task, row);
  }
  const open = await taskPrs();
  // worker|human: the owner's PR is in review once its CI passes; in-review keeps the rest of the flow as for a worker's.
  for (const pr of humanWorker ? open.filter(pr => !labelled(pr.task, 'in-review', 'needs-human') && settled(pr) && passed(pr)) : []) {
    if (await attempt('bd', ['update', pr.task.id, '--status', 'in_progress', '--add-label', 'in-review']) === null) continue;
    pr.task.labels = [...(pr.task.labels ?? []), 'in-review'];
    log(`PR #${pr.number} (${pr.task.id}): CI passed; in review.`);
  }
  await strays(open);
  const prs = open.filter(pr => !labelled(pr.task, 'needs-human'));
  // A worker labels a PR in-review only on green CI; one that is red anyway waits for the owner.
  // The owner's own PR going red before a review is theirs to fix: it just waits.
  const busy = pr => [...running].some(job => job.Task === pr.task.id);
  for (const pr of humanWorker ? [] : prs.filter(pr => labelled(pr.task, 'in-review') && settled(pr) && !passed(pr) && !reviewed.has(pr.number) && !busy(pr))) {
    await attempt('bd', ['update', pr.task.id, '--add-label', 'needs-human']);
    await attempt('bd', ['note', pr.task.id, `ralph-afk --pr: PR #${pr.number} is in review but its CI failed.`]);
    log(`PR #${pr.number} is in review but its CI failed; labelled needs-human. Remove in-review too to hand it back to a worker.`);
  }
  for (const pr of human && !stopping ? prs.filter(pr => labelled(pr.task, 'in-review') && !busy(pr)) : []) {
    // In review with no session kept (in review before reviewer|human, or a stop came before the worker's end was
    // handled): what came after the PR's last commit is new, so a comment posted while this was down still counts.
    if (!sessions[pr.task.id]) { sessions[pr.task.id] = { since: pr.commits.at(-1).committedDate }; saveSessions(); }
    const held = sessions[pr.task.id];
    const since = Date.parse(held.since);
    if ([...pr.reviews, ...pr.comments].some(item => mine(item) && Date.parse(item.submittedAt ?? item.createdAt) > since) && !stopping) await startFix(pr, held);
  }
  if (!human && !stopping) await advance(prs.filter(pr => labelled(pr.task, 'in-review') && !busy(pr)));
  if (stopping && !running.size) return true;
  // Out of work: keep checking, so tasks filed later start without a restart.
  const nothing = !running.size && !(humanWorker ? 0 : ready.length) && !prs.length && !slow;
  if (nothing && !idle) {
    log(`Out of work. Checking for new tasks every ${pollMs / 1000}s; Ctrl+C to stop.`);
    await listParked();
  }
  idle = nothing;
  latest = { prs: open, waiting: ready.filter(task => ![...running].some(job => job.Task === task.id)).length };
  // The dashboard shows the same, live.
  if (!screen && !idle && Date.now() - shown >= pollMs) {
    shown = Date.now();
    status(open, latest.waiting);
  }
}
// The dashboard opens waiting, so settings can change before anything starts: Enter starts, q stops without a check, --go skips the wait.
if (screen && !stopping && !process.argv.includes('--go')) await Promise.race([screen.started, new Promise(resolve => halt.signal.addEventListener('abort', resolve))]);
while (!stopping || running.size) {
  // A failed gh, bd or git call (network, rate limit) must not end the run: its agents run detached and would be orphaned.
  try { if (await poll()) break; } catch (error) {
    log(`Check failed: ${firstLine(error.stderr || error.message)}; trying again in ${pollMs / 1000}s.`);
  }
  if (stopping && !running.size) break; // also when the stop came during the check
  // Once stopping, halt stays aborted and its sleep returns at once: wait for the agents only, or this spins on gh and bd.
  // An agent whose end failed to be handled waits a poll too, also when stopping. Kept ref'd: with nothing else pending, an unref'd timer lets Node exit mid-await.
  await Promise.race([...(stopping ? [] : [sleep(pollMs, null, { signal: halt.signal }).catch(() => {}), new Promise(resolve => { wake = resolve; })]),
    ...[...running].map(job => job.retry ? sleep(pollMs) : job.done)]);
  for (const job of [...running]) {
    if (job.code === undefined) continue;
    running.delete(job);
    // A failed call here must not end the run either: the agent stays in running, so no check acts on its task, and its end is handled again.
    try {
      progress(job);
      await (job.compact ? compactDone : { worker: workerDone, reviewer: reviewDone, merger: mergerDone }[job.stage])(job);
    } catch (error) {
      running.add(job);
      job.retry = true;
      log(`Handling the end of ${job.name} failed: ${firstLine(error.stderr || error.message)}; trying again in ${pollMs / 1000}s.`);
    }
  }
}

if (screen) {
  screen.stop();
  screen = null;
  log('Dashboard closed; its log is in .ralph-tui/pr-logs/ralph-pr.log.');
}
log('Stop requested. Stopping.');
// Commit the export once here so the next start pushes it with the planning commits.
await commitBeads('chore(beads): export after ralph-afk --pr');
await listParked();
