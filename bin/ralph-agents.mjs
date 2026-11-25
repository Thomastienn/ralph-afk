// The agents file: agent lines, mode lines (worker|human, reviewer|human, reviewer|none) and settings.
// ralph-pr.mjs reads it at start and again whenever it changes; the dashboard's settings view edits it one line
// at a time, so comments and line order stay. bin/ralph-afk runs `node ralph-agents.mjs FILE` to check the file.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The settings a file may leave out. bin/ralph-afk keeps its own copy of the schedule and wait defaults.
export const DEFAULTS = { workers: '3', reviewers: '2', tries: '3', 'slow-every': '5', schedule: '00-24=claude,codex', wait: '600', poll: '120' };
const count = [/^[1-9][0-9]*$/, 'a whole number from 1'];
const window = '[0-9]+-[0-9]+=(claude|codex)(,(claude|codex))*';
const windows = new RegExp(`^${window}( +${window})*$`);
// A window runs hours FROM to TO-1, so any other one would never match.
const reachable = w => { const [from, to] = w.split('=')[0].split('-').map(Number); return from < to && to <= 24; };
const CHECKS = {
  workers: count, reviewers: count, tries: count, 'slow-every': count,
  wait: [/^[0-9]+$/, 'whole seconds'],
  poll: [/^(?=.*[1-9])[0-9]*\.?[0-9]+$/, 'seconds above 0'],
  schedule: [{ test: value => windows.test(value) && value.split(/ +/).every(reachable) },
    'space-separated FROM-TO=agents windows, FROM below TO and TO at most 24, agents claude or codex'],
};
const MODES = ['worker|human', 'reviewer|human', 'reviewer|none'];
const OFF = /^\s*#\s*/; // an agent line commented out is off: the dashboard lists it so it can be turned back on
const agentLine = ([stage, agent, model, effort, ...rest]) => ['worker', 'reviewer', 'merger'].includes(stage) && ['claude', 'codex'].includes(agent)
  && !rest.length && model && effort ? { stage, agent, model, effort: effort !== '-' ? effort : null } : null;

// rows: the agent and mode lines in file order, each with its line index; off: the agent lines commented out, the same
// way; settings: the first line of each setting, else its default. Throws `line N: ...` on the first line that is none of these.
export function parseAgents(text) {
  const rows = [];
  const off = [];
  const settings = { ...DEFAULTS };
  const seen = new Set();
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    if (OFF.test(line)) {
      const row = agentLine(line.replace(OFF, '').split('|'));
      if (row) off.push({ ...row, line: index });
      return;
    }
    const fields = line.split('|');
    const [stage, agent] = fields;
    const bad = why => { throw new Error(`line ${index + 1}: ${why}`); };
    if (stage in CHECKS) {
      const [check, hint] = CHECKS[stage];
      if (fields.length !== 2 || !check.test(agent)) bad(`${stage} must be ${hint}`);
      if (!seen.has(stage)) settings[stage] = agent;
      seen.add(stage);
    } else if (MODES.includes(line)) rows.push({ stage, agent, line: index });
    else if (agentLine(fields)) rows.push({ ...agentLine(fields), line: index });
    else bad('expected stage|agent|model|effort (stage worker, reviewer or merger; agent claude or codex), worker|human, reviewer|human, reviewer|none or a setting such as workers|3');
  });
  return { rows, off, settings };
}

// target: a setting's name, or { line, col } for column col (0 agent, 1 model, 2 effort) of an agent line.
// Returns the new text; throws when the result would not parse. A missing setting gets a line at the end.
export function edit(text, target, value) {
  const lines = text.split('\n');
  if (typeof target === 'string') {
    const at = lines.findIndex(line => line.split('|')[0] === target);
    if (at >= 0) lines[at] = `${target}|${value}`;
    else lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, `${target}|${value}`);
  } else {
    const fields = lines[target.line].split('|');
    fields[target.col + 1] = value;
    lines[target.line] = fields.join('|');
    // An off line is a comment, so check it as it would be once on.
    if (OFF.test(lines[target.line])) parseAgents(lines.map((line, i) => i === target.line ? line.replace(OFF, '') : line).join('\n'));
  }
  const next = lines.join('\n');
  parseAgents(next);
  return next;
}

// op on agent line `line`: 'copy' adds a copy below it, 'delete' removes it, 'toggle' turns it off (comments it out)
// or back on. 'copy' with no line adds worker|claude|sonnet|- at the end. Returns the new text; throws when it would not parse.
export function change(text, line, op) {
  const lines = text.split('\n');
  if (line === undefined) lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, 'worker|claude|sonnet|-');
  else if (op === 'copy') lines.splice(line + 1, 0, lines[line]);
  else if (op === 'delete') lines.splice(line, 1);
  else lines[line] = OFF.test(lines[line]) ? lines[line].replace(OFF, '') : `#${lines[line]}`;
  const next = lines.join('\n');
  parseAgents(next);
  return next;
}

// `node ralph-agents.mjs FILE` exits 1 and names the first bad line.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { parseAgents(readFileSync(process.argv[2], 'utf8')); } catch (error) { console.error(`${process.argv[2]} ${error.message} (see agents.example).`); process.exit(1); }
}
