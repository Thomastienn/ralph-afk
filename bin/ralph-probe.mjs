// Is an agent usable now, and if it is usage-limited, when is it worth probing again?
// `node ralph-probe.mjs agent` exits 0 when usable; otherwise it exits 1 and prints the reset in epoch seconds, if known.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const MARGIN = 60000; // probe a minute after the reset, so the limit has surely lifted

// A cheap request to each supported CLI. Ralph 0.12.0 does not recognise subscription usage-limit
// errors, and matching its log would also match text the agent prints. Both replies name the reset time.
export const probes = {
  claude: ['claude', '-p', 'Reply with exactly: pong', '--model', 'haiku', '--effort', 'low', '--output-format', 'stream-json', '--verbose'],
  codex: ['codex', 'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', 'Reply with exactly: pong'],
};

// Returns { ok, until }: until is the reset in epoch ms, or undefined when the agent named none.
// Async, so the --pr dashboard still answers keys while a probe runs.
export async function probe(agent) {
  const [command, ...args] = probes[agent];
  // A failed run rejects with an error that holds its stdout and stderr too.
  const run = promisify(execFile)(command, args, { cwd: '/tmp', encoding: 'utf8', timeout: 180000 });
  run.child.stdin.end(); // execFile always pipes stdin, and codex exec waits for EOF on a piped stdin
  const reply = await run.catch(error => error);
  const ok = !(reply instanceof Error) && reply.stdout.toLowerCase().includes('pong');
  return { ok, until: ok ? undefined : retryAt(`${reply.stdout}\n${reply.stderr}`) };
}

// Returns epoch ms, or undefined when the text names no future reset: the caller then uses its fixed wait.
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
  const { ok, until } = await probe(process.argv[2]);
  if (until) console.log(Math.ceil(until / 1000));
  process.exit(ok ? 0 : 1);
}
