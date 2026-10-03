import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, renderCards, strWidth, truncate } from '../src/render.js';

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59_999), '59s');
  assert.equal(formatDuration(61_000), '1m 01s');
  assert.equal(formatDuration(3_725_000), '1h 02m');
  assert.equal(formatDuration(90_000_000), '1d 1h');
  assert.equal(formatDuration(null), '?');
});

test('CJK width and truncation', () => {
  assert.equal(strWidth('项目abc'), 7);
  assert.equal(strWidth(truncate('这是一个很长的项目名称', 9)), 9);
});

test('renderCards shows timers computed from absolute timestamps', () => {
  const now = 1_000_000_000;
  const out = renderCards(
    {
      sessions: [
        { id: 'claude:a', tool: 'claude', sessionId: 'aaaaaaaa1', project: 'p1', status: 'running', startedAt: now - 65_000 },
        { id: 'codex:b', tool: 'codex', sessionId: 'bbbbbbbb2', project: 'p2', status: 'done', runDurationMs: 30_000, finishedAt: now - 5000, dismissPolicy: 'swipe', lastMessage: 'ok' },
      ],
    },
    { now, color: false },
  );
  assert.match(out, /RUNNING\s+claude\s+p1\s+1m 05s/);
  assert.match(out, /DONE\s+codex\s+p2\s+ran 30s · idle 5s · swipe/);
  assert.match(out, /\n   ok/);
});
