# AGENTS.md

Notes for coding agents working on this repository.

## Rules

- Update `README.md` in the same change whenever behavior, flags, files or
  environment variables change.
- When a change alters what the `--pr` dashboard shows, update the made-up
  data in `docs/demo.mjs` to match and regenerate the README screenshot
  `docs/ralph-pr.png` in the same change. Nothing in CI does it:
  `node docs/demo.mjs > /tmp/ralph-pr.svg`, then
  `google-chrome --headless --hide-scrollbars --window-size=<W>,<H> --screenshot=docs/ralph-pr.png file:///tmp/ralph-pr.svg`,
  with `<W>`,`<H>` the SVG's `width` and `height`. Look at the PNG before
  committing.
- Run `nice -n 19 node --test --test-concurrency=2 test/*.test.mjs` before
  you finish. Tests use fake CLIs and `agents.example`, never the owner's
  `agents` file.

## Layout

- `bin/ralph`: one headless Ralph run on an epic.
- `bin/ralph-afk`: unattended supervisor; `--pr` hands off to `bin/ralph-pr.mjs`.
- `bin/ralph-pr-tui.mjs`: the `--pr` terminal dashboard.
- `bin/ralph-agents.mjs`: parses, checks and edits the agents file and its settings;
  `bin/ralph-afk` checks the same lines with awk, so keep the two in sync.
- `bin/ralph-probe.mjs`: built-in Claude and Codex usage probes.
- `bin/ralph-takeover.mjs`: stops a running Ralph safely before a new one starts.
- `ralph-tui/`: global ralph-tui config, tracker plugin and prompt template.
- `prompts/`: built-in `--pr` worker, reviewer and merger prompts; a checkout's
  `.ralph-tui/pr-<stage>.md` overrides them.

## Agents file lookup

All three launchers (`ralph`, `ralph-afk`, `ralph-pr.mjs`) resolve it the same
way, in this order:

1. `RALPH_AGENTS`, if set and not empty.
2. `.ralph-tui/agents` in the checkout root, if present.
3. `agents` next to `bin/` (ignored by Git).

Keep the three in sync when this changes.
