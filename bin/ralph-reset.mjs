// When a usage-limited agent is worth probing again, read from its probe output.
// `node ralph-reset.mjs < output` prints epoch seconds, or nothing when the output names no reset time.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARGIN = 60000; // probe a minute after the reset, so the limit has surely lifted

// Returns epoch ms, or undefined for an agent whose format is unknown: the caller then uses its fixed wait.
export function retryAt(text, now = Date.now()) {
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // claude -p --output-format stream-json --verbose
    const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : undefined;
    if (info?.status === 'rejected' && info.resetsAt * 1000 > now) return info.resetsAt * 1000 + MARGIN;
  }
  // codex: "... or try again at 3:45 PM." when it resets today, else "... at Nov 20th, 2026 3:45 PM."
  const at = /try again at ([^.]*?[AP]M)/i.exec(text)?.[1].replace(/(\d)(st|nd|rd|th),/, '$1,');
  if (!at) return;
  const time = Date.parse(/\d{4}/.test(at) ? at : `${new Date(now).toDateString()} ${at}`);
  return time > now ? time + MARGIN : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = retryAt(readFileSync(0, 'utf8'));
  if (at) console.log(Math.ceil(at / 1000));
}
