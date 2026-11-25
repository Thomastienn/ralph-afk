// Live dashboard for ralph-afk --pr: one panel per running agent, or one agent full screen.
// ralph-pr.mjs starts it only when stdin and stdout are a terminal and supplies the data.
// s opens the settings view, which edits the agents file in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULTS, edit, parseAgents } from './ralph-agents.mjs';

// Agent output may hold tabs or escape codes; they would break the layout.
const clean = text => String(text).replace(/[\x00-\x1f\x7f]/g, ' ');
const minutes = ms => `${Math.floor(ms / 60000)}m`;
// effort is null when the CLI default applies; context (tokens) is known after the agent's first reply.
export const agentLabel = job => [job.agent, job.model, job.effort, job.context && `${Math.round(job.context / 1000)}k ctx`].filter(Boolean).join(' ');
const STEPS = 5; // steps per panel in the overview
const bodyRows = rows => Math.max(1, rows - 4); // detail view: everything but its title bar, path line, rule and key line
// SGR codes from the terminal's own 16 colours, so light and dark themes both keep their contrast.
const STAGE = { worker: '36', reviewer: '35', merger: '34' }; // cyan, magenta, blue
const STATE = { 'CI passed': '32', 'CI failed': '31', 'CI running': '33', 'no CI yet': '2', 'needs-human': '1;31' };
// The settings view's tabs: Models has a row per agent line, the others a row per setting.
const TABS = ['Models', 'Capacity', 'Timing'];
const SETTINGS = {
  Capacity: [['workers', 'workers at once'], ['reviewers', 'reviewers at once'], ['tries', 'failed runs on one task or PR before needs-human'], ['slow-every', 'merges between slow-suite runs']],
  Timing: [['schedule', 'agents per hour, FROM-TO=agents'], ['wait', 'seconds before re-probing an agent with no reset time'], ['poll', 'seconds between checks']],
};
// The editable rows of a tab: cells hold the values, target(col) is what edit() changes. Throws on a bad file.
export function settingsRows(text, tab) {
  const { rows, settings } = parseAgents(text);
  if (tab === 0) return rows.filter(row => row.model).map(row => ({ label: row.stage, cells: [row.agent, row.model, row.effort ?? '-'], target: col => ({ line: row.line, col }) }));
  return SETTINGS[TABS[tab]].map(([key, help]) => ({ label: key, cells: [settings[key]], target: () => key, help: settings[key] === DEFAULTS[key] ? `default · ${help}` : help }));
}
const tone = text => /fail|could not|exited|needs a human|needs-human|not usable/i.test(text) ? '31' : /^Merged|passed/.test(text) ? '32' : '';

// view: { header, stopping, jobs, prs, logs, focus, scroll, settings, now, color }; header is a list of fields;
// jobs carry slot, stage, Task, Title, PR, agent, model, effort, context, started, steps, file.
// settings: { tab, row, col, buffer, note, text } while the settings view is open; buffer is the value being typed.
// Returns the screen as at most rows lines, each at most cols characters wide.
export function render({ header, stopping, jobs, prs, logs, focus, scroll = 0, settings, now, color = true }, cols, rows) {
  // A line is a list of [text, SGR style] parts, cut to the terminal width before it is styled.
  const cut = (parts, room) => parts.map(([text, style]) => {
    const piece = clean(text).slice(0, Math.max(0, room));
    room -= piece.length;
    return [piece, style];
  });
  const paint = parts => cut(parts, cols).map(([piece, style]) => style && color && piece ? `\x1b[${style}m${piece}\x1b[0m` : piece).join('');
  const width = parts => parts.reduce((sum, [text]) => sum + clean(text).length, 0);
  // The right end (clock, agent, minutes) always shows; the left is cut to make room for it.
  const bar = (left, right, style) => {
    const kept = clean(left).slice(0, Math.max(0, cols - right.length - 1));
    return [[`${kept}${' '.repeat(Math.max(1, cols - kept.length - right.length))}${right}`, style]];
  };
  // Lays items (lists of parts) out on as many lines as they need: lead starts the first line, pad (as wide) the others.
  const flow = (items, lead, pad, sep, first = cols) => {
    const out = [];
    let line = lead;
    for (const item of items) {
      if (width(line) > width(lead) && width(line) + width(sep) + width(item) > (out.length ? cols : first)) { out.push(line); line = pad; }
      line = [...line, ...(width(line) > width(lead) ? sep : []), ...item];
    }
    return [...out, line];
  };
  const rule = [['─'.repeat(cols), '2']];
  const keys = pairs => pairs.flatMap(([key, what]) => [[` ${key} `, '7'], [` ${what}  `, '2']]);
  const tint = job => STAGE[job.stage] ?? '';
  const what = job => `${job.PR ? `${job.PR} ` : ''}${job.Task}`;
  const who = job => `${agentLabel(job)} · ${minutes(now - job.started)}`;
  // Older steps are dim, so the newest one in each panel stands out.
  const step = (job, text, old) => {
    const gutter = [' │ ', tint(job)];
    if (text.startsWith('error:')) return [gutter, [text, old ? '31' : '1;31']];
    if (old) return [gutter, [text, '2']];
    const tool = /^[\w-]+(?=: )/.exec(text)?.[0];
    return tool ? [gutter, [tool, '1'], [text.slice(tool.length), '']] : [gutter, [text, '']];
  };
  let lines;
  if (settings) {
    const { tab, row, col, buffer, note } = settings;
    let list = [];
    let problem = null;
    try { list = settingsRows(settings.text, tab); } catch (error) { problem = `Agents file ${error.message}; fix it by hand.`; }
    const widths = [0, 1, 2].map(i => Math.max(0, ...list.map(entry => clean(entry.cells[i] ?? '').length)));
    const cell = (entry, i, at) => {
      const text = entry.cells[i].padEnd(widths[i]);
      if (at !== row || i !== col) return [` ${text} `, ''];
      return buffer === null ? [` ${text} `, '7'] : [` ${buffer}▌`.padEnd(widths[i] + 2), '1;33'];
    };
    const body = list.map((entry, at) => [[`  ${entry.label.padEnd(12)}`, at === row ? '1' : ''], ...entry.cells.map((_, i) => cell(entry, i, at)), ...(entry.help ? [[`  ${entry.help}`, '2']] : [])]);
    const tail = [rule, problem ? [[` ${problem}`, '31']] : note ? [[` ${note[0]}`, note[1]]] : [[' Changes apply to the next agent started; running agents keep theirs.', '2']],
      keys(buffer === null ? [['Tab', 'next tab'], ['↑↓←→', 'move'], ['Enter', 'edit'], ['Esc', 'back']] : [['Enter', 'save'], ['Esc', 'cancel']])];
    const top = [bar(' ralph-pr settings', '', '7'), TABS.map((name, i) => [` ${name} `, i === tab ? '7;1' : '2']), [], ...body];
    lines = [...top.slice(0, Math.max(1, rows - tail.length)), ...Array(Math.max(0, rows - tail.length - top.length)).fill([]), ...tail];
  } else if (focus) {
    const body = bodyRows(rows);
    const end = focus.steps.length - Math.min(scroll, Math.max(0, focus.steps.length - body));
    const steps = focus.steps.slice(Math.max(0, end - body), end);
    lines = [bar(` ${focus.slot}  ${focus.stage}  ${what(focus)}  ${focus.Title ?? ''}`, `${who(focus)} `, `7;${tint(focus)}`),
      [[` ${focus.file ?? ''}`, '2']],
      ...(steps.length ? steps.map(text => step(focus, text, false)) : [[[' │ ', tint(focus)], ['starting', '2']]]),
      ...Array(Math.max(0, body - Math.max(1, steps.length))).fill([]), rule,
      [...keys([['Esc', 'back'], ['↑↓', 'scroll'], ['1-9', 'switch agent']]), ...(scroll ? [[`${focus.steps.length - end} lines up`, '33']] : [])]];
  } else {
    const time = new Date(now).toLocaleTimeString('sv');
    // Header fields that do not fit beside the clock go on more header lines.
    const head = flow(['ralph-pr', ...header].map(field => [[field, '']]), [[' ', '']], [[' ', '']], [['  ·  ', '']], cols - time.length - 2)
      .map((parts, i) => bar(parts.map(([text]) => text).join(''), i ? '' : `${time} `, stopping ? '7;33' : '7'));
    // PRs flow onto as many lines as they need, but the newest 3 log lines and a line per panel stay on screen.
    const marks = text => text.replace(/^PR /, '').split(/(CI passed|CI failed|CI running|no CI yet|needs-human)/).map(piece => [piece, STATE[piece] ?? '']);
    const LOGS = 3;
    const prLines = flow(prs.length ? prs.map(marks) : [[['none', '2']]], [[' PRs  ', '1']], [['      ', '']], [['   ', '']])
      .slice(0, Math.max(1, rows - head.length - 3 - Math.max(1, jobs.length) - LOGS));
    const room = rows - head.length - 3 - prLines.length - LOGS; // header and a blank line above; rule, PRs, log and the key line below
    const gap = room >= jobs.length * (STEPS + 2) - 1 ? 1 : 0; // a blank line between panels when everything fits
    const per = jobs.length ? Math.max(0, Math.min(STEPS, Math.floor((room - gap * (jobs.length - 1)) / jobs.length) - 1)) : 0;
    const panels = jobs.length ? jobs.flatMap((job, index) => {
      const right = [[` ${who(job)}`, '2']];
      const left = cut([[` ${job.slot} `, `7;${tint(job)}`], [` ${job.stage}  `, `1;${tint(job)}`], [`${what(job)}  `, '1'], [job.Title ?? '', '']], cols - width(right) - 4);
      const steps = job.steps.slice(-per).slice(0, per);
      return [[...left, [` ${'─'.repeat(Math.max(1, cols - width(left) - width(right) - 1))}`, '2'], ...right],
        ...(job.steps.length ? steps.map((text, i) => step(job, text, i < steps.length - 1)) : [[[' │ ', tint(job)], ['starting', '2']]]).slice(0, per),
        ...(gap && index < jobs.length - 1 ? [[]] : [])];
    }) : [[[' No agents running.', '2']]];
    const top = [...head, [], ...panels].slice(0, Math.max(1, rows - 2 - prLines.length - LOGS));
    const n = rows - top.length - 2 - prLines.length;
    // A log line too long for the terminal wraps at a space, its rest indented under the message.
    const wrapped = (n > 0 ? logs.slice(-n) : []).flatMap(line => { // slice(-0) would be every line
      const time = line.slice(0, line.indexOf(' ') + 1);
      const text = clean(line.slice(time.length));
      const w = Math.max(1, cols - 6 - time.length);
      return (text.match(new RegExp(`\\S.{0,${w - 1}}(?= |$)|\\S.{0,${w - 1}}`, 'g')) ?? ['']).map((piece, i) => [[i ? ' '.repeat(time.length) : time, '2'], [piece, tone(text)]]);
    }).slice(-n);
    lines = [...top, rule, ...prLines, ...wrapped.map((parts, i) => [[i ? '      ' : ' Log  ', '1'], ...parts]),
      keys([['1-9', 'open agent'], ['s', 'settings'], ['q', 'stop']])];
  }
  return lines.slice(0, rows).map(paint);
}

// state() returns { header, stopping, jobs, prs, logs }; interrupt runs on q or Ctrl+C (raw mode turns off SIGINT).
// file is the agents file the settings view edits; saved runs after each save.
export function startTui(state, interrupt, file, saved) {
  const { stdin, stdout } = process;
  let focus = null;
  let scroll = 0;
  let settings = null;
  let on = true;
  const draw = () => {
    if (!on) return;
    const view = state();
    if (focus && !view.jobs.includes(focus)) { focus = null; scroll = 0; } // its agent finished
    const lines = render({ ...view, focus, scroll, settings, now: Date.now(), color: !process.env.NO_COLOR }, stdout.columns, stdout.rows);
    // Clear each line before writing it: erasing after a full-width line would also erase its last character.
    stdout.write(`\x1b[H${lines.map(line => `\x1b[2K${line}`).join('\n')}${lines.length < stdout.rows ? '\n\x1b[J' : ''}`);
  };
  // The settings view takes every key but Ctrl+C; q there types a q or does nothing, so it never stops the run.
  const setting = key => {
    const s = settings;
    let list = [];
    try { list = settingsRows(s.text, s.tab); } catch {}
    const entry = list[s.row];
    if (s.buffer === null) {
      if (key === '\x1b') settings = null;
      else if (key === '\t' || key === '\x1b[Z') { s.tab = (s.tab + (key === '\t' ? 1 : TABS.length - 1)) % TABS.length; s.row = 0; s.col = 0; }
      else if (key === '\x1b[A') s.row = Math.max(0, s.row - 1);
      else if (key === '\x1b[B') s.row = Math.max(0, Math.min(list.length - 1, s.row + 1));
      else if (key === '\x1b[D') s.col = Math.max(0, s.col - 1);
      else if (key === '\x1b[C') s.col = Math.min((entry?.cells.length ?? 1) - 1, s.col + 1);
      else if (key === '\r' && entry) { s.buffer = entry.cells[s.col]; s.note = null; }
      return;
    }
    if (key === '\x1b') s.buffer = null;
    else if (key === '\x7f' || key === '\b') s.buffer = s.buffer.slice(0, -1);
    else if (key !== '\r') { if (key >= ' ' && key.length === 1) s.buffer += key; }
    else {
      const now = readFileSync(file, 'utf8');
      // An edit by hand since the view opened moves lines: show the file as it is now instead of writing over it.
      if (now !== s.text) { s.text = now; s.note = ['The agents file changed on disk; showing it as it is now. Try again.', '33']; }
      else {
        try {
          s.text = edit(now, entry.target(s.col), s.buffer);
          writeFileSync(file, s.text);
          s.note = ['Saved.', '32'];
          saved();
        } catch (error) { s.note = [`Not saved: ${error.message}.`, '31']; }
      }
      s.buffer = null;
    }
  };
  // One chunk can hold several keys: presses made while the sync gh and bd calls block the loop arrive together.
  const keys = data => {
    for (const key of data.toString().match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      const job = /^[1-9]$/.test(key) && state().jobs.find(entry => entry.slot === Number(key));
      if (key === '\x03') interrupt();
      else if (settings) setting(key);
      else if (key === 'q') interrupt();
      else if (key === 's') settings = { tab: 0, row: 0, col: 0, buffer: null, note: null, text: readFileSync(file, 'utf8') };
      else if (job) { focus = job; scroll = 0; }
      else if (key === '\x1b') { focus = null; scroll = 0; }
      else if (focus && key === '\x1b[A') scroll = Math.min(scroll + 1, Math.max(0, focus.steps.length - bodyRows(stdout.rows)));
      else if (focus && key === '\x1b[B') scroll = Math.max(0, scroll - 1);
    }
    draw();
  };
  const crash = error => { stop(); console.error(error); process.exit(1); }; // else the error dies with the alternate screen
  function stop() {
    if (!on) return;
    on = false;
    stdin.off('data', keys);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.off('resize', draw);
    process.off('exit', stop);
    process.off('uncaughtException', crash);
    stdout.write('\x1b[?7h\x1b[?25h\x1b[?1049l'); // wrap and cursor back on, leave the alternate screen
  }
  // Alternate screen, hidden cursor, no line wrap: a line too wide for the terminal is cut, not wrapped.
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', keys);
  stdout.on('resize', draw);
  process.on('exit', stop);
  process.on('uncaughtException', crash);
  draw();
  return { draw, stop };
}
