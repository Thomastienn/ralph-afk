# ralph-afk

Unattended runners for [Ralph](https://github.com/subsy/ralph-tui) on a
[Beads](https://github.com/steveyegge/beads) backlog. They keep coding agents
working through your epics while you are away. When one agent runs out of
usage, they switch to another and wait for usage limits to reset.

- `ralph` runs Ralph headless on one epic.
- `ralph-afk` works through every ready epic, one task at a time, and switches
  agents when one runs out of usage.
- `ralph-afk --pr` runs several workers in parallel. Each task becomes its own
  pull request, and a reviewer agent merges the PRs once CI passes.

## Requirements

- Git, Node.js, `jq`, and GNU coreutils and util-linux (`timeout`, `flock`)
- [`ralph-tui`](https://github.com/subsy/ralph-tui) 0.12.0, on `PATH` or in `~/.bun/bin`
- [`bd`](https://github.com/steveyegge/beads) (Beads), with the project's issues set up
- The `beads-resume` tracker plugin at
  `~/.config/ralph-tui/plugins/trackers/beads-resume.js`
- At least one agent CLI, such as `claude` (Claude Code) or `codex`
- For `--pr` mode: `gh`, authenticated, and a GitHub remote with CI

## Setup

1. Put the runners on your `PATH`:

   ```bash
   ln -s "$PWD/bin/ralph" "$PWD/bin/ralph-afk" ~/.local/bin/
   ```

2. Create your agents file from the example, then edit it:

   ```bash
   cp agents.example agents
   ```

   `agents` is ignored by Git, so changing your models or agents never touches
   the repository. To keep the file somewhere else, set `RALPH_AGENTS` to its
   path.

3. Check each probe by hand. A working probe prints `pong`. Then run one task:

   ```bash
   ralph --agent codex --iterations 1
   ```

## Agents file

Each line enables one agent for one stage:

```text
stage|agent|model|effort|probe
```

| Field | Meaning |
| --- | --- |
| `stage` | `ralph` for `ralph` and `ralph-afk`; `worker` or `reviewer` for `ralph-afk --pr`. |
| `agent` | A Ralph agent plugin, as listed by `ralph-tui plugins agents`. `--pr` supports `claude` and `codex` only. |
| `model` | The work model, passed as `--model`. `RALPH_<AGENT>_MODEL` overrides it for the `ralph` stage, for example `RALPH_CODEX_MODEL`. |
| `effort` | Reasoning effort for `--pr` agents. `-` keeps the CLI default. The `ralph` stage ignores it. |
| `probe` | A cheap request, run in `/tmp`. The agent counts as usable when the reply contains `pong`. |

Probes use a cheap model, so they cost almost nothing. A probe cannot detect a
limit that applies only to the work model. Claude and Codex have done real
runs. Cursor and Copilot have only had their probes checked.

## ralph

Runs Ralph headless on one epic of the current checkout. You can run it from
anywhere inside the checkout.

```bash
ralph                            # oldest ready epic, the project's default agent
ralph my-epic --iterations 10
ralph --agent codex              # Codex, with its model from the agents file
ralph --agent codex --takeover   # stop the Ralph running here, then start
```

- `--agent <name>` without `--model` adds that agent's work model. The model in
  a project's `.ralph-tui/config.toml` belongs to the project's default agent.
- `--takeover` safely stops the Ralph session that holds this checkout's lock.
  It first checks that the lock matches a live Ralph process on this host and
  checkout. Ralph gets 30 seconds to stop. Its child agents then get a
  SIGTERM, and a SIGKILL 5 seconds later if needed. The interrupted task keeps
  its claim, so `beads-resume` recovers its pending edits. Old session files
  move to `.ralph-tui/reports/takeover-*`. Do not combine `--takeover` with
  `--force` or `--resume`.
- Other options pass through to `ralph-tui run --headless` unchanged.

## ralph-afk

Keeps the backlog moving while nobody is at the keyboard. Start it once, in
tmux or with `nohup`:

```bash
ralph-afk                          # every ready epic, oldest first
ralph-afk my-epic other-epic       # only these epics, in this order
ralph-afk -a codex                 # only Codex for this run
ralph-afk -a claude,codex my-epic  # only Claude and Codex, only this epic
RALPH_AFK_SCHEDULE='00-07=codex 07-24=claude,codex' ralph-afk
```

### How it works

On each cycle, `ralph-afk` takes these steps:

1. Closes every epic whose children are all closed (`bd epic close-eligible`).
   This unblocks the epics that depend on it.
2. Picks the first epic, oldest first or in the order you gave, that has a
   ready or in-progress task. An open issue with no parent that blocks one of
   the epic's tasks, such as a bug filed mid-task, moves under the epic so that
   Ralph can work on it.
3. Probes the scheduled agents and picks the first one that answers. It stays
   on the agent that ran last and switches only when that agent stops
   answering.
4. Runs one task with `ralph --takeover --iterations 1` and waits for it to
   end.

It re-reads epics before every task, so epics you add or unblock mid-run take
effect. Blocking dependencies between epics set the order in which they are
released. Only one `ralph-afk` can run per checkout. Its first takeover stops
any Ralph already running there, including an interactive one.

Ralph 0.12.0 headless does not report a failed auto-commit. When a task closes
but its edits are left uncommitted, `ralph-afk` commits them as
`<type>: <id> <title>`. If a hook rejects that commit, it retries with
`--no-verify`.

When every epic is out of ready work, `ralph-afk` creates a full-suite gate
epic. Its single task runs the project's full test suites, fixes the failures,
and reviews the commits made since the last gate. It does this only if a task
has closed since the last gate and no gate is still open. If you name epics on
the command line, no gate is created. `ralph-afk` stops when no ready work is
left.

### Usage limits

Ralph's own `fallbackAgents` is not used. Ralph 0.12.0 does not recognise
subscription usage-limit errors, so a limited agent would fail every few
seconds until the iteration limit runs out. `ralph-afk` probes the agents
itself instead:

- If no scheduled agent answers, `ralph-afk` sleeps until the earliest time one
  of them may be back. It then probes them all again and uses the first that
  answers.
- A limited Claude or Codex reports when its usage resets. It counts as back
  one minute after that time. Claude reports the reset only when its probe uses
  `--output-format stream-json --verbose`.
- Any other agent, or a failure that is not a usage limit (auth, network),
  counts as back after `RALPH_AFK_WAIT` seconds.
- With more than one schedule window, it also wakes at the next full hour,
  because a new window may bring an agent that is usable.
- If a run ends within two minutes without closing or blocking a task, it
  waits `RALPH_AFK_WAIT` seconds before the next try. That covers a limit hit
  at once, a startup failure, or a crash. A task that finishes quickly starts
  the next one at once.
- A running task is never probed. If it hits a limit, the Ralph run ends. The
  next available agent then resumes the task and its pending edits through
  `beads-resume`.

### Schedule

`RALPH_AFK_SCHEDULE` is a space-separated list of `FROM-TO=agents` windows in
local hours. Agents in a window are tried in order. The default is
`00-24=claude,codex`.

- No agent runs in an hour outside every window.
- A window that crosses midnight must be written as two windows:
  `22-24=codex 00-06=codex`.
- The schedule is read when a task starts. A running task is not interrupted at
  a window boundary.
- `-a` narrows the schedule. It does not replace it. An agent named with `-a`
  that is unknown, or that is in no window, is refused at start.

### Stopping

Press Ctrl+C once to let the current task finish and commit, then exit. Press
it again to stop at once. The task runs in its own session, so Ctrl+C never
reaches it directly.

## ralph-afk --pr

Parallel mode. Up to N workers each take a ready task into their own worktree
and branch, open a PR, and wait for CI. One reviewer at a time reviews, fixes
and squash-merges PRs whose checks have finished.

```bash
ralph-afk --pr      # 3 workers
ralph-afk --pr 5    # 5 workers
```

The project needs two prompts that describe how its workers and reviewer work:
`.ralph-tui/pr-worker.md` and `.ralph-tui/pr-reviewer.md`.

- At start, your local default branch is pushed to `origin`, so that workers
  branch from your latest planning commits.
- Worktrees live outside the checkout, in `../<repo>-pr/`. Agent logs go to
  `.ralph-tui/pr-logs/`.
- Workers take tasks with no parent first, then tasks in epic age order. Tasks
  labelled `gate:backlog`, `in-review` or `needs-human` are skipped. A `new-ui`
  task waits until its description has a `Mockup:` line.
- After a merge, the task closes and its branch and worktree are removed. The
  main checkout fast-forwards if it is on the default branch with no local
  changes.
- Every 5 merges, the `slow-tests.yml` workflow is dispatched. If it fails, a
  task is filed to fix it.
- A task or PR whose agent fails 3 times is labelled `needs-human`. Other work
  continues, and the run lists these items when it ends.
- A limited agent is not probed again before its reported reset. Meanwhile,
  the next line of the same stage takes over.
- Ctrl+C works as in sequential mode: once to let running agents finish, twice
  to stop them.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RALPH_AGENTS` | `agents` next to `bin/` | Path to the agents file. |
| `RALPH_AFK_SCHEDULE` | `00-24=claude,codex` | Which agents may run in each hour. |
| `RALPH_AFK_WAIT` | `600` | Seconds before an agent with no known reset time is probed again. |
| `RALPH_<AGENT>_MODEL` | from `agents` | Work model override for the `ralph` stage. |
| `RALPH_PR_WORKERS` | `3` | Worker count for `--pr` when none is given. |
| `RALPH_PR_POLL` | `120` | Seconds between `--pr` checks of tasks and PRs. |

## Tests

```bash
node --test test/*.test.mjs
```

The tests run the scripts against fake CLIs in a temporary checkout. They make
no model calls and read `agents.example`, not your own `agents` file.
