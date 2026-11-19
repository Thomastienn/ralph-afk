import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryAt } from '../bin/ralph-reset.mjs';

const now = new Date(2026, 10, 19, 14, 0).getTime(); // 19 Nov 2026 14:00 local
const minute = 60000;
const claude = info => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });

test('a limited Claude or Codex probe gives the reset time plus a minute; anything else gives none', () => {
  const reset = now / 1000 + 3600;
  assert.equal(retryAt(`{"type":"system"}\n${claude({ status: 'rejected', resetsAt: reset })}\n`, now), reset * 1000 + minute);
  assert.equal(retryAt('ERROR: You\'ve hit your usage limit. Upgrade to Pro or try again at 3:45 PM.', now), new Date(2026, 10, 19, 15, 46).getTime());
  assert.equal(retryAt('or try again at Nov 21st, 2026 9:05 AM.', now), new Date(2026, 10, 21, 9, 6).getTime());
  for (const text of [
    claude({ status: 'allowed', resetsAt: reset }), // not limited
    claude({ status: 'rejected', resetsAt: now / 1000 - 1 }), // already past
    'or try again at 1:00 PM.', // earlier today: stale
    "You've hit your usage limit", // an agent with an unknown format
    'or try again later.',
  ]) assert.equal(retryAt(text, now), undefined, text);
});
