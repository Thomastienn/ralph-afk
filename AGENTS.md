# AGENTS.md

Notes for coding agents working on this repository.

## Rules

- Update `README.md` in the same change whenever behavior, flags, files or
  environment variables change.
- Run `node --test test/*.test.mjs` before you finish. Tests use fake CLIs and
  `agents.example`, never the owner's `agents` file.

## Layout

- `bin/ralph`: one headless Ralph run on an epic.
- `bin/ralph-afk`: unattended supervisor; `--pr` hands off to `bin/ralph-pr.mjs`.
- `bin/ralph-probe.mjs`: built-in Claude and Codex usage probes.
- `bin/ralph-takeover.mjs`: stops a running Ralph safely before a new one starts.
- `ralph-tui/`: global ralph-tui config, tracker plugin and prompt template.

## Agents file lookup

All three launchers (`ralph`, `ralph-afk`, `ralph-pr.mjs`) resolve it the same
way, in this order:

1. `RALPH_AGENTS`, if set and not empty.
2. `.ralph-tui/agents` in the checkout root, if present.
3. `agents` next to `bin/` (ignored by Git).

Keep the three in sync when this changes.
