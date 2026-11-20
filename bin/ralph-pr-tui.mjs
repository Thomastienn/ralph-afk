// Live dashboard for ralph-afk --pr: one panel per running agent, or one agent full screen.
// ralph-pr.mjs starts it only when stdin and stdout are a terminal and supplies the data.

// Agent output may hold tabs or escape codes; they would break the layout.
const clean = text => String(text).replace(/[\x00-\x1f\x7f]/g, ' ');
const minutes = ms => `${Math.floor(ms / 60000)}m`;
const STEPS = 5; // steps per panel in the overview
const bodyRows = rows => Math.max(1, rows - 4); // detail view: everything but its two rules, title and key line

// view: { header, jobs, prs, logs, focus, scroll, now }; jobs carry slot, stage, Task, Title, PR, agent, model, started, steps, file.
// Returns the screen as rows lines, each at most cols characters.
export function render({ header, jobs, prs, logs, focus, scroll = 0, now }, cols, rows) {
  const rule = '─'.repeat(cols);
  const label = job => `[${job.slot}] ${job.stage}  ${job.PR ? `${job.PR} ` : ''}${job.Task}  ${job.Title ?? ''}  ${job.agent} ${job.model}  ${minutes(now - job.started)}`;
  let lines;
  if (focus) {
    const body = bodyRows(rows);
    const end = focus.steps.length - Math.min(scroll, Math.max(0, focus.steps.length - body));
    const steps = focus.steps.slice(Math.max(0, end - body), end);
    lines = [`${label(focus)}${focus.file ? `  ${focus.file}` : ''}`, rule, ...(steps.length ? steps : ['starting']),
      ...Array(Math.max(0, body - Math.max(1, steps.length))).fill(''), rule,
      `Esc back · ↑/↓ scroll · 1-9 switch agent${scroll ? ` · ${focus.steps.length - end} lines up` : ''}`];
  } else {
    const room = rows - 2 - 6; // header and rule above; rule, PRs, at least 3 log lines and the key line below
    const per = jobs.length ? Math.max(0, Math.min(STEPS, Math.floor(room / jobs.length) - 1)) : 0;
    const panels = jobs.length
      ? jobs.flatMap(job => [label(job), ...(job.steps.length ? job.steps.slice(-per) : ['starting']).slice(0, per).map(step => `    ${step}`)])
      : ['No agents running.'];
    const top = [`${header}  ${new Date(now).toLocaleTimeString('sv')}`, rule, ...panels].slice(0, Math.max(1, rows - 4));
    const n = rows - top.length - 3;
    const shown = n > 0 ? logs.slice(-n) : []; // slice(-0) would be every line
    lines = [...top, rule, `PRs  ${prs.join(' · ') || 'none'}`, ...shown.map((line, i) => `${i ? '     ' : 'Log  '}${line}`),
      '1-9 open agent · q/Ctrl+C stop'];
  }
  return lines.slice(0, rows).map(line => clean(line).slice(0, cols));
}

// state() returns { header, jobs, prs, logs }; interrupt runs on q or Ctrl+C (raw mode turns off SIGINT).
export function startTui(state, interrupt) {
  const { stdin, stdout } = process;
  let focus = null;
  let scroll = 0;
  let on = true;
  const draw = () => {
    if (!on) return;
    const view = state();
    if (focus && !view.jobs.includes(focus)) { focus = null; scroll = 0; } // its agent finished
    const lines = render({ ...view, focus, scroll, now: Date.now() }, stdout.columns, stdout.rows);
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
