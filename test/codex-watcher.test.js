import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, normalizeHook } from '../src/store.js';
import { CodexWatcher } from '../src/codex-watcher.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-codex-'));
  const day = path.join(dir, '2026', '10', '02');
  fs.mkdirSync(day, { recursive: true });
  const store = new SessionStore();
  return { dir, day, store };
}

const line = (ts, type, payload) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload }) + '\n';
const meta = (ts, id, cwd) => line(ts, 'session_meta', { id, session_id: id, cwd, originator: 'codex_work_desktop', base_instructions: 'x' });
const ev = (ts, type, extra = {}) => line(ts, 'event_msg', { type, ...extra });

test('new rollout file: task_started -> running, approval -> waiting, task_complete -> done', () => {
  const { dir, day, store } = setup();
  const w = new CodexWatcher({ store, dir });
  w.initialScan();
  const f = path.join(day, 'rollout-2026-10-02T10-00-00-aaaa.jsonl');
  const t = Date.now() - 50_000;
  fs.writeFileSync(f, meta(t, 'aaaa', '/Users/x/projects/webapp') + ev(t + 10, 'task_started', { turn_id: 't1' }));
  w.poll();
  let [c] = store.cards();
  assert.equal(c.id, 'codex:aaaa');
  assert.equal(c.status, 'running');
  assert.equal(c.project, 'webapp');
  assert.equal(c.startedAt, t + 10);

  fs.appendFileSync(f, ev(t + 1000, 'exec_approval_request', { command: ['ls'] }));
  w.poll();
  assert.equal(store.cards()[0].status, 'waiting');
  fs.appendFileSync(f, line(t + 2000, 'response_item', { type: 'function_call_output' }));
  w.poll();
  assert.equal(store.cards()[0].status, 'running');

  // partial line is buffered until complete
  const done = ev(t + 40_000, 'task_complete', { last_agent_message: 'Refactor complete', duration_ms: 39990 });
  fs.appendFileSync(f, done.slice(0, 20));
  w.poll();
  assert.equal(store.cards()[0].status, 'running');
  fs.appendFileSync(f, done.slice(20));
  w.poll();
  [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.runDurationMs, 39_990);
  assert.equal(c.dismissPolicy, 'swipe');
  assert.equal(c.lastMessage, 'Refactor complete');
});

test('turn_aborted => interrupted done', () => {
  const { dir, day, store } = setup();
  const w = new CodexWatcher({ store, dir });
  w.initialScan();
  const f = path.join(day, 'rollout-x-bbbb.jsonl');
  const t = Date.now();
  fs.writeFileSync(f, meta(t, 'bbbb', '/p/q') + ev(t, 'task_started') + ev(t + 5, 'turn_aborted', { reason: 'interrupted' }));
  w.poll();
  assert.equal(store.cards()[0].interrupted, true);
});

test('startup replay: shows active sessions, skips old finished ones', () => {
  const { dir, day, store } = setup();
  const now = Date.now();
  fs.writeFileSync(path.join(day, 'rollout-a-run1.jsonl'), meta(now - 120_000, 'run1', '/p/active') + ev(now - 100_000, 'task_started'));
  fs.writeFileSync(
    path.join(day, 'rollout-a-old1.jsonl'),
    meta(now - 3600_000, 'old1', '/p/old') + ev(now - 3600_000, 'task_started') + ev(now - 3500_000, 'task_complete'),
  );
  fs.writeFileSync(
    path.join(day, 'rollout-a-new1.jsonl'),
    meta(now - 60_000, 'new1', '/p/recent') + ev(now - 60_000, 'task_started') + ev(now - 30_000, 'task_complete'),
  );
  const w = new CodexWatcher({ store, dir });
  w.initialScan();
  const ids = store.cards().map((c) => `${c.id}:${c.status}`).sort();
  assert.deepEqual(ids, ['codex:new1:done', 'codex:run1:running']);
  assert.equal(store.cards().find((c) => c.id === 'codex:run1').startedAt, now - 100_000);

  // tailing continues from the end for existing files
  fs.appendFileSync(path.join(day, 'rollout-a-old1.jsonl'), ev(now, 'task_started'));
  w.poll();
  assert.equal(store.cards().find((c) => c.id === 'codex:old1').status, 'running');
});

test('replay after restart does not resurrect a dismissed card', () => {
  const { dir, day, store } = setup();
  const now = Date.now();
  fs.writeFileSync(path.join(day, 'rollout-a-d1.jsonl'), meta(now - 60_000, 'd1', '/p/x') + ev(now - 60_000, 'task_started') + ev(now - 30_000, 'task_complete'));
  new CodexWatcher({ store, dir }).initialScan();
  assert.equal(store.cards().length, 1);
  store.dismiss('codex:d1');
  const persisted = JSON.parse(JSON.stringify(store.toJSON()));
  const store2 = new SessionStore();
  store2.load(persisted);
  new CodexWatcher({ store: store2, dir }).initialScan();
  assert.equal(store2.cards().length, 0);
});

test('hooks take precedence over the watcher for the same rollout file', () => {
  const { dir, day, store } = setup();
  const w = new CodexWatcher({ store, dir });
  w.initialScan();
  const f = path.join(day, 'rollout-x-cccc.jsonl');
  const t = Date.now();
  fs.writeFileSync(f, meta(t, 'cccc', '/p/h') + ev(t, 'task_started'));
  w.poll();
  assert.equal(store.cards().length, 1);
  // hook arrives (even with a different session id) for the same transcript
  store.apply(normalizeHook('codex', { session_id: 'hook-id', cwd: '/p/h', transcript_path: f, hook_event_name: 'UserPromptSubmit' }));
  assert.deepEqual(store.cards().map((c) => c.id), ['codex:hook-id']);
  fs.appendFileSync(f, ev(t + 10, 'task_complete'));
  w.poll();
  assert.equal(store.cards()[0].status, 'running', 'watcher ignored once hooks own the file');
});
