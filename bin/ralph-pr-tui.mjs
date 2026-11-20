// Live dashboard for ralph-afk --pr: one panel per running agent, or one agent full screen.
// ralph-pr.mjs starts it only when stdin and stdout are a terminal and supplies the data.

// Agent output may hold tabs or escape codes; they would break the layout.
const clean = text => String(text).replace(/[\x00-\x1f\x7f]/g, ' ');
const minutes = ms => `${Math.floor(ms / 60000)}m`;
// effort is null when the CLI default applies; context (tokens) is known only for Claude, after its first reply.
export const agentLabel = job => [job.agent, job.model, job.effort, job.context && `${Math.round(job.context / 1000)}k ctx`].filter(Boolean).join(' ');
const STEPS = 5; // steps per panel in the overview
const bodyRows = rows => Math.max(1, rows - 4); // detail view: everything but its title bar, path line, rule and key line
// SGR codes from the terminal's own 16 colours, so light and dark themes both keep their contrast.
const STAGE = { worker: '36', reviewer: '35' }; // cyan, magenta
const STATE = { 'CI passed': '32', 'CI failed': '31', 'CI running': '33', 'no CI yet': '2', 'needs-human': '1;31' };
const tone = text => /fail|could not|exited|needs a human|needs-human|not usable/i.test(text) ? '31' : /^Merged|passed/.test(text) ? '32' : '';

// view: { header, stopping, jobs, prs, logs, focus, scroll, now, color }; header is a list of fields;
// jobs carry slot, stage, Task, Title, PR, agent, model, effort, context, started, steps, file.
// Returns the screen as at most rows lines, each at most cols characters wide.
export function render({ header, stopping, jobs, prs, logs, focus, scroll = 0, now, color = true }, cols, rows) {
  // A line is a list of [text, SGR style] parts, cut to the terminal width before it is styled.
  const paint = parts => {
    let room = cols;
    let out = '';
    for (const [text, style] of parts) {
      const piece = clean(text).slice(0, room);
      room -= piece.length;
      out += style && color && piece ? `\x1b[${style}m${piece}\x1b[0m` : piece;
    }
    return out;
  };
  const width = parts => parts.reduce((sum, [text]) => sum + clean(text).length, 0);
  const bar = (left, right, style) => [[`${left}${' '.repeat(Math.max(1, cols - left.length - right.length))}${right}`, style]];
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
  if (focus) {
    const body = bodyRows(rows);
    const end = focus.steps.length - Math.min(scroll, Math.max(0, focus.steps.length - body));
    const steps = focus.steps.slice(Math.max(0, end - body), end);
    lines = [bar(` ${focus.slot}  ${focus.stage}  ${what(focus)}  ${focus.Title ?? ''}`, `${who(focus)} `, `7;${tint(focus)}`),
      [[` ${focus.file ?? ''}`, '2']],
      ...(steps.length ? steps.map(text => step(focus, text, false)) : [[[' │ ', tint(focus)], ['starting', '2']]]),
      ...Array(Math.max(0, body - Math.max(1, steps.length))).fill([]), rule,
      [...keys([['Esc', 'back'], ['↑↓', 'scroll'], ['1-9', 'switch agent']]), ...(scroll ? [[`${focus.steps.length - end} lines up`, '33']] : [])]];
  } else {
    const room = rows - 2 - 6; // header and a blank line above; rule, PRs, at least 3 log lines and the key line below
    const gap = room >= jobs.length * (STEPS + 2) - 1 ? 1 : 0; // a blank line between panels when everything fits
    const per = jobs.length ? Math.max(0, Math.min(STEPS, Math.floor((room - gap * (jobs.length - 1)) / jobs.length) - 1)) : 0;
    const panels = jobs.length ? jobs.flatMap((job, index) => {
      const left = [[` ${job.slot} `, `7;${tint(job)}`], [` ${job.stage}  `, `1;${tint(job)}`], [`${what(job)}  `, '1']];
      const right = [[` ${who(job)}`, '2']];
      const name = (job.Title ?? '').slice(0, Math.max(0, cols - width(left) - width(right) - 4));
      const steps = job.steps.slice(-per).slice(0, per);
      return [[...left, [name, ''], [` ${'─'.repeat(Math.max(1, cols - width(left) - name.length - width(right) - 1))}`, '2'], ...right],
        ...(job.steps.length ? steps.map((text, i) => step(job, text, i < steps.length - 1)) : [[[' │ ', tint(job)], ['starting', '2']]]).slice(0, per),
        ...(gap && index < jobs.length - 1 ? [[]] : [])];
    }) : [[[' No agents running.', '2']]];
    const time = new Date(now).toLocaleTimeString('sv');
    const top = [bar(` ${['ralph-pr', ...header].join('  ·  ')}`, `${time} `, stopping ? '7;33' : '7'), [], ...panels].slice(0, Math.max(1, rows - 4));
    // PRs flow onto as many lines as they need, leaving the rest to the log.
    const marks = text => text.replace(/^PR /, '').split(/(CI passed|CI failed|CI running|no CI yet|needs-human)/).map(piece => [piece, STATE[piece] ?? '']);
    const flow = [];
    let line = [[' PRs  ', '1']];
    for (const item of prs.map(marks)) {
      if (width(line) > 6 && width(line) + 3 + width(item) > cols) { flow.push(line); line = [['      ', '']]; }
      line = [...line, ...(width(line) > 6 ? [['   ', '']] : []), ...item];
    }
    flow.push(prs.length ? line : [...line, ['none', '2']]);
    const prLines = flow.slice(0, Math.max(1, rows - top.length - 2));
    const n = rows - top.length - 2 - prLines.length;
    const shown = n > 0 ? logs.slice(-n) : []; // slice(-0) would be every line
    lines = [...top, rule, ...prLines,
      ...shown.map((line, i) => {
        const cut = line.indexOf(' ');
        return [[i ? '      ' : ' Log  ', '1'], [line.slice(0, cut + 1), '2'], [line.slice(cut + 1), tone(line.slice(cut + 1))]];
      }),
      keys([['1-9', 'open agent'], ['q', 'stop']])];
  }
  return lines.slice(0, rows).map(paint);
}

// state() returns { header, stopping, jobs, prs, logs }; interrupt runs on q or Ctrl+C (raw mode turns off SIGINT).
export function startTui(state, interrupt) {
  const { stdin, stdout } = process;
  let focus = null;
  let scroll = 0;
  let on = true;
  const draw = () => {
    if (!on) return;
    const view = state();
    if (focus && !view.jobs.includes(focus)) { focus = null; scroll = 0; } // its agent finished
    const lines = render({ ...view, focus, scroll, now: Date.now(), color: !process.env.NO_COLOR }, stdout.columns, stdout.rows);
    stdout.write(`\x1b[H${lines.join('\x1b[K\n')}\x1b[K\x1b[J`);
  };
  const keys = data => {
    const key = data.toString();
    const job = /^[1-9]$/.test(key) && state().jobs.find(entry => entry.slot === Number(key));
    if (key === '\x03' || key === 'q') interrupt();
    else if (job) { focus = job; scroll = 0; }
    else if (key === '\x1b') { focus = null; scroll = 0; }
    else if (focus && key === '\x1b[A') scroll = Math.min(scroll + 1, Math.max(0, focus.steps.length - bodyRows(stdout.rows)));
    else if (focus && key === '\x1b[B') scroll = Math.max(0, scroll - 1);
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
