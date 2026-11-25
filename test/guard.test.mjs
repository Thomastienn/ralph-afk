import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// bin/guard/gh ahead of a fake real gh that echoes its arguments, as ralph-pr.mjs puts it on agents' PATH.
const guard = realpathSync(fileURLToPath(new URL('../bin/guard', import.meta.url)));
const real = mkdtempSync(join(tmpdir(), 'guard-'));
writeFileSync(join(real, 'gh'), '#!/bin/sh\necho "real $*"\n', { mode: 0o755 });
const gh = (...args) => spawnSync(join(guard, 'gh'), args, { encoding: 'utf8', env: { ...process.env, PATH: `${guard}:${real}:${process.env.PATH}` } });

test('gh calls that return text other accounts can write are refused', () => {
  for (const args of [
    ['issue', 'view', '7'], ['issue', 'list'], ['search', 'prs', 'x'],
    ['pr', 'view', '3', '--comments'], ['pr', 'view', '3', '-c'], ['pr', 'status', '--comments'],
    ['pr', 'view', '3', '--json', 'title,comments'], ['pr', 'view', '3', '--json=reviews'], ['pr', 'list', '--author', '@me', '--json', 'latestReviews'],
    ['pr', 'list'], ['pr', 'list', '--head', 'T-1'],
    ['api', 'repos/{owner}/{repo}/pulls/3/comments'], ['api', 'repos/{owner}/{repo}/issues/3/comments?per_page=100'], ['api', '/repos/o/r/pulls/3/reviews'],
    ['api', 'repos/o/r/issues'], ['api', 'repos/o/r/pulls'], ['api', 'repos/o/r/issues/3/timeline'], ['api', 'graphql', '-f', 'query=x'],
    ['status'], ['run', 'list'], ['run', 'ls'], ['run', '-R', 'o/r', 'list', '--workflow', 'ci.yml'],
    ['api', 'notifications'], ['api', '/notifications?all=true'], ['api', '-X', 'GET', 'notifications/threads/1'],
    ['api', 'repos/o/r/actions/runs'], ['api', '/repos/o/r/actions/runs?branch=T-1'], ['api', '--method', 'GET', 'repos/o/r/actions/runs/9/jobs'],
    ['api', 'repos/o/r/actions/workflows/ci.yml/runs'],
    ['pr', 'list', '--author', 'stranger'], ['pr', 'list', '--author=stranger'], ['pr', 'list', '-A', 'stranger'], ['pr', 'ls'],
    ['pr', '-R', 'o/r', 'list'], ['pr', '--repo', 'o/r', 'list', '--head', 'T-1'], ['pr', 'list', '--author', '@me', '-Astranger'],
  ]) {
    const result = gh(...args);
    assert.equal(result.status, 64, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.match(result.stderr, /ralph-afk blocked/, args.join(' '));
  }
});

test('the gh calls agents need reach the real gh', () => {
  for (const args of [
    ['pr', 'view', '3'], ['pr', 'view', 'T-1', '--json', 'mergeable'], ['pr', 'list', '--head', 'T-1', '--author', '@me'],
    ['pr', 'create', '--head', 'T-1', '--title', 'x'], ['pr', 'checks', 'T-1', '--watch'], ['pr', 'diff', '3'],
    ['pr', 'comment', '3', '--body', 'these comments are fixed'], ['pr', 'merge', '3', '--squash'],
    ['run', 'view', '9', '--log-failed'], ['workflow', 'run', 'slow.yml', '--ref', 'T-1'], ['api', 'repos/o/r/pulls/3'],
    ['pr', 'list', '--author', '@me'], ['pr', 'list', '--author=@me'], ['pr', 'ls', '-A', '@me'], ['pr', '-R', 'o/r', 'list', '--author', '@me'],
    ['pr', 'list', '--state', 'all', '--head', 'T-1', '--author', '@me', '--json', 'number,state'], ['pr', 'status'],
  ]) {
    const result = gh(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, `real ${args.join(' ')}\n`);
  }
});
