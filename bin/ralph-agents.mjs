// The agents file: agent lines, mode lines (worker|human, reviewer|human, reviewer|none) and settings.
// ralph-pr.mjs reads it at start and again whenever it changes; the dashboard's settings view edits it one line
// at a time, so comments and line order stay. bin/ralph-afk runs `node ralph-agents.mjs FILE` to check the file.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The settings a file may leave out. bin/ralph-afk keeps its own copy of the schedule and wait defaults.
export const DEFAULTS = { workers: '3', reviewers: '2', tries: '3', 'slow-every': '5', schedule: '00-24=claude,codex', wait: '600', poll: '120' };
const count = [/^[1-9][0-9]*$/, 'a whole number from 1'];
const window = '[0-9]+-[0-9]+=(claude|codex)(,(claude|codex))*';
const CHECKS = {
  workers: count, reviewers: count, tries: count, 'slow-every': count,
  wait: [/^[0-9]+$/, 'whole seconds'],
  poll: [/^(?=.*[1-9])[0-9]*\.?[0-9]+$/, 'seconds above 0'],
  schedule: [new RegExp(`^${window}( +${window})*$`), 'space-separated FROM-TO=agents windows, agents claude or codex'],
};
const MODES = ['worker|human', 'reviewer|human', 'reviewer|none'];

// rows: the agent and mode lines in file order, each with its line index; settings: the first line of each
// setting, else its default. Throws `line N: ...` on the first line that is none of these.
export function parseAgents(text) {
  const rows = [];
  const settings = { ...DEFAULTS };
  const seen = new Set();
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const fields = line.split('|');
    const [stage, agent, model, effort] = fields;
    const bad = why => { throw new Error(`line ${index + 1}: ${why}`); };
    if (stage in CHECKS) {
      const [check, hint] = CHECKS[stage];
      if (fields.length !== 2 || !check.test(agent)) bad(`${stage} must be ${hint}`);
      if (!seen.has(stage)) settings[stage] = agent;
      seen.add(stage);
    } else if (MODES.includes(line)) rows.push({ stage, agent, line: index });
    else if (['worker', 'reviewer', 'merger'].includes(stage) && ['claude', 'codex'].includes(agent) && fields.length === 4 && model && effort) {
      rows.push({ stage, agent, model, effort: effort !== '-' ? effort : null, line: index });
    } else bad('expected stage|agent|model|effort (stage worker, reviewer or merger; agent claude or codex), worker|human, reviewer|human, reviewer|none or a setting such as workers|3');
  });
  return { rows, settings };
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
  }
  const next = lines.join('\n');
  parseAgents(next);
  return next;
}

// `node ralph-agents.mjs FILE` exits 1 and names the first bad line.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { parseAgents(readFileSync(process.argv[2], 'utf8')); } catch (error) { console.error(`${process.argv[2]} ${error.message} (see agents.example).`); process.exit(1); }
}
