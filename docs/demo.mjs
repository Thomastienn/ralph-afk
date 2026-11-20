// Renders the --pr dashboard with made-up data as SVG, for docs/ralph-pr.png:
//   node docs/demo.mjs > /tmp/ralph-pr.svg, then screenshot it (e.g. headless Chrome) at its width and height.
import { render } from '../bin/ralph-pr-tui.mjs';
const now = new Date('2026-11-19T14:32:10').getTime();
const ago = m => now - m * 60000;
const jobs = [
  { slot: 1, stage: 'worker', Task: 'rt-12', Title: 'Add CSV export to reports page', agent: 'claude', model: 'opus', effort: 'high', context: 87400, started: ago(14),
    file: '/home/me/app/.ralph-tui/logs/rt-12.jsonl',
    steps: ['Read: src/reports/page.tsx', 'Grep: exportRows', 'Edit: src/reports/export.ts', 'Bash: npm test -- reports', 'Bash: git push -u origin ralph/rt-12'] },
  { slot: 2, stage: 'reviewer', PR: '#41', Task: 'rt-9', Title: 'Rate-limit login endpoint', agent: 'codex', model: 'gpt-5', effort: 'medium', context: 52800, started: ago(6),
    file: '/home/me/app/.ralph-tui/logs/rt-9-review.jsonl',
    steps: ['Bash: gh pr diff 41', 'Read: src/auth/limit.ts', 'error: test auth/limit.test.ts failed (expected 429, got 200)', 'Edit: src/auth/limit.ts', 'Bash: npm test -- auth'] },
  { slot: 3, stage: 'worker', Task: 'rt-15', Title: 'Fix timezone bug in invoice dates', agent: 'claude', model: 'sonnet', effort: 'high', context: 31200, started: ago(2),
    file: '/home/me/app/.ralph-tui/logs/rt-15.jsonl', steps: ['Read: src/invoice/date.ts', 'Grep: toLocaleDateString'] },
];
const prs = ['PR #41 rt-9: CI failed, reviewer running', 'PR #43 rt-11: CI passed', 'PR #44 rt-10: CI running', 'PR #38 rt-7 [needs-human]: CI failed'];
const logs = ['14:18:02 Started worker 1 on rt-12 (claude opus high).', '14:24:40 Merged PR #40 (rt-8).', '14:26:11 Started reviewer 2 on PR #41 (codex gpt-5 medium).',
  '14:28:57 PR #38: claude exited with 1 without merging.', '14:30:03 Started worker 3 on rt-15 (claude sonnet high).'];
const [cols, rows] = [100, 30];
const view = { header: ['master', '3/3 agents', '12 tasks left'], jobs, prs, logs, now };
const lines = render(process.argv[2] === 'focus' ? { ...view, focus: jobs[1] } : view, cols, rows);

// ANSI to SVG for the few SGR codes render() uses: 0, 1, 2, 7 and 31-36.
const fg = { 31: '#f7768e', 32: '#9ece6a', 33: '#e0af68', 34: '#7aa2f7', 35: '#bb9af7', 36: '#7dcfff' };
const [bg, text, cw, lh, pad] = ['#1a1b26', '#c0caf5', 8.4, 19, 16];
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let body = '';
lines.forEach((line, y) => {
  let x = 0, st = {};
  for (const [, codes, chunk] of line.matchAll(/(?:\x1b\[([\d;]*)m)?([^\x1b]*)/g)) {
    if (codes !== undefined) for (const c of codes.split(';').map(Number)) st = c === 0 ? {} : c === 1 ? { ...st, bold: 1 } : c === 2 ? { ...st, dim: 1 } : c === 7 ? { ...st, inv: 1 } : { ...st, fg: fg[c] };
    if (!chunk) continue;
    const X = pad + x * cw, Y = pad + y * lh, color = st.fg ?? text;
    if (st.inv) body += `<rect x="${X}" y="${Y}" width="${chunk.length * cw}" height="${lh}" fill="${color}"/>`;
    body += `<text x="${X}" y="${Y + 14}" fill="${st.inv ? bg : color}"${st.bold ? ' font-weight="bold"' : ''}${st.dim ? ' opacity="0.55"' : ''} xml:space="preserve">${esc(chunk)}</text>`;
    x += chunk.length;
  }
});
const W = pad * 2 + cols * cw, H = pad * 2 + lines.length * lh;
console.log(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" font-size="14"><rect width="100%" height="100%" rx="8" fill="${bg}"/>${body}</svg>`);
