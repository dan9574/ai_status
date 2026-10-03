import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, normalizeHook, snippet } from '../src/store.js';

function mk(threshold = 60) {
  let t = 1_000_000;
  const store = new SessionStore({ swipeThresholdSec: threshold, now: () => t });
  const hook = (tool, payload) => store.apply(normalizeHook(tool, payload));
  return { store, hook, advance: (ms) => (t += ms), now: () => t };
}

const base = (id, ev, extra = {}) => ({ session_id: id, cwd: '/Users/x/projects/alpha', hook_event_name: ev, ...extra });

test('SessionStart creates an idle session that is not shown', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'SessionStart', { source: 'startup' }));
  assert.equal(store.sessions.size, 1);
  assert.equal(store.cards().length, 0);
});

test('full lifecycle: prompt -> waiting -> running -> done (short => swipe)', () => {
  const { store, hook, advance, now } = mk();
  hook('claude', base('s1', 'SessionStart'));
  const t0 = now();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'fix   the\ntests' }));
  let [c] = store.cards();
  assert.equal(c.status, 'running');
  assert.equal(c.startedAt, t0);
  assert.equal(c.project, 'alpha');
  assert.equal(c.lastMessage, 'fix the tests');
  assert.equal(c.id, 'claude:s1');

  advance(5000);
  hook('claude', base('s1', 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
  [c] = store.cards();
  assert.equal(c.status, 'waiting');
  assert.equal(c.waitingReason, 'permission');
  assert.equal(c.waitingSince, now());

  advance(5000);
  hook('claude', base('s1', 'PostToolUse', { tool_name: 'Bash' }));
  [c] = store.cards();
  assert.equal(c.status, 'running');
  assert.equal(c.waitingSince, null);

  advance(10_000);
  hook('claude', base('s1', 'Stop', { last_assistant_message: 'All tests pass.' }));
  [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.finishedAt, now());
  assert.equal(c.runDurationMs, 20_000);
  assert.equal(c.dismissPolicy, 'swipe');
  assert.equal(c.lastMessage, 'All tests pass.');
});

test('long run => confirm; threshold is configurable', () => {
  const { store, hook, advance } = mk(60);
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'x' }));
  advance(61_000);
  hook('claude', base('s1', 'Stop'));
  assert.equal(store.cards()[0].dismissPolicy, 'confirm');
  store.swipeThresholdSec = 120;
  assert.equal(store.cards()[0].dismissPolicy, 'swipe');
});

test('idle_prompt notification after Stop does not flip done to waiting', () => {
  const { store, hook, advance } = mk();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'x' }));
  hook('claude', base('s1', 'Stop'));
  advance(60_000);
  hook('claude', base('s1', 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }));
  hook('claude', base('s1', 'Notification', { message: 'Claude is waiting for your input' })); // legacy, no type
  assert.equal(store.cards()[0].status, 'done');
});

test('new UserPromptSubmit on a done session restarts it as running', () => {
  const { store, hook, advance, now } = mk();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'a' }));
  advance(1000);
  hook('claude', base('s1', 'Stop'));
  advance(100_000);
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'b' }));
  const [c] = store.cards();
  assert.equal(c.status, 'running');
  assert.equal(c.startedAt, now());
  assert.equal(c.finishedAt, null);
  assert.equal(c.runDurationMs, null);
});

test('SessionStart (e.g. compact) mid-run does not reset status', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'a' }));
  hook('claude', base('s1', 'SessionStart', { source: 'compact' }));
  assert.equal(store.cards()[0].status, 'running');
});

test('SessionEnd keeps done cards until dismissed, removes others', () => {
  const { store, hook } = mk();
  hook('claude', base('a', 'UserPromptSubmit', { prompt: 'a' }));
  hook('claude', base('a', 'Stop'));
  hook('claude', base('a', 'SessionEnd', { reason: 'prompt_input_exit' }));
  hook('claude', base('b', 'UserPromptSubmit', { prompt: 'b' }));
  hook('claude', base('b', 'SessionEnd', { reason: 'other' }));
  hook('claude', base('c', 'SessionStart'));
  hook('claude', base('c', 'SessionEnd', { reason: 'clear' }));
  const cards = store.cards();
  assert.deepEqual(cards.map((c) => [c.id, c.status, c.ended]), [['claude:a', 'done', true]]);
  assert.equal(store.sessions.size, 1);
  store.dismiss('claude:a');
  assert.equal(store.sessions.size, 0, 'ended + dismissed is forgotten');
});

test('dismiss hides a card; late activity on a dismissed run does not resurrect it', () => {
  const { store, hook } = mk();
  hook('claude', base('abcdef12', 'UserPromptSubmit', { prompt: 'a' }));
  assert.equal(store.dismiss('abc').id, 'claude:abcdef12'); // prefix
  assert.equal(store.cards().length, 0);
  hook('claude', base('abcdef12', 'PostToolUse'));
  hook('claude', base('abcdef12', 'Stop'));
  assert.equal(store.cards().length, 0);
  hook('claude', base('abcdef12', 'UserPromptSubmit', { prompt: 'again' }));
  assert.equal(store.cards()[0].status, 'running');
});

test('dismiss with ambiguous prefix or unknown id returns null', () => {
  const { store, hook } = mk();
  hook('claude', base('aa1', 'UserPromptSubmit'));
  hook('codex', base('aa2', 'UserPromptSubmit'));
  assert.equal(store.dismiss('aa'), null);
  assert.equal(store.dismiss('zzz'), null);
  assert.equal(store.cards().length, 2);
});

test('events for unknown sessions (daemon was down) create approximate cards', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'PostToolUse'));
  let [c] = store.cards();
  assert.equal(c.status, 'running');
  assert.equal(c.startedAtApprox, true);
  hook('claude', base('s2', 'Stop'));
  c = store.cards().find((x) => x.id === 'claude:s2');
  assert.equal(c.status, 'done');
  assert.equal(c.runDurationMs, null);
  assert.equal(c.dismissPolicy, 'confirm');
});

test('PermissionRequest and AskUserQuestion => waiting; tool activity resumes', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', base('s1', 'PreToolUse', { tool_name: 'AskUserQuestion' }));
  assert.equal(store.cards()[0].waitingReason, 'question');
  hook('claude', base('s1', 'PostToolUse', { tool_name: 'AskUserQuestion' }));
  assert.equal(store.cards()[0].status, 'running');
  hook('claude', base('s1', 'PermissionRequest', { tool_name: 'Bash' }));
  assert.equal(store.cards()[0].status, 'waiting');
  assert.equal(store.cards()[0].lastMessage, 'Permission: Bash');
  hook('claude', base('s1', 'PermissionDenied', { tool_name: 'Bash' }));
  assert.equal(store.cards()[0].status, 'running');
});

test('Codex Interrupt => done + interrupted', () => {
  const { store, hook } = mk();
  hook('codex', base('c1', 'UserPromptSubmit', { turn_id: 't1' }));
  hook('codex', base('c1', 'Interrupt', { turn_id: 't1' }));
  const [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.interrupted, true);
  assert.equal(c.tool, 'codex');
});

test('tool activity shortly after Stop continues the same run', () => {
  const { store, hook, advance, now } = mk();
  const t0 = now();
  hook('claude', base('s1', 'UserPromptSubmit'));
  advance(1000);
  hook('claude', base('s1', 'Stop', { stop_hook_active: false }));
  advance(1000);
  hook('claude', base('s1', 'PostToolUse'));
  assert.equal(store.cards()[0].status, 'running');
  assert.equal(store.cards()[0].startedAt, t0);
});

test('cards are sorted waiting, running, done', () => {
  const { store, hook, advance } = mk();
  hook('claude', base('d', 'UserPromptSubmit'));
  hook('claude', base('d', 'Stop'));
  advance(1);
  hook('claude', base('r', 'UserPromptSubmit'));
  advance(1);
  hook('codex', base('w', 'UserPromptSubmit'));
  hook('codex', base('w', 'PermissionRequest'));
  assert.deepEqual(store.cards().map((c) => c.status), ['waiting', 'running', 'done']);
});

test('persistence round-trip via toJSON/load', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'p' }));
  const copy = new SessionStore();
  copy.load(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(copy.cards(), store.cards());
});

test('prune forgets old idle sessions only', () => {
  const { store, hook, advance } = mk();
  hook('claude', base('idle', 'SessionStart'));
  hook('claude', base('run', 'UserPromptSubmit'));
  advance(25 * 3600_000);
  store.prune(24 * 3600_000);
  assert.deepEqual([...store.sessions.keys()], ['claude:run']);
});

test('normalizeHook ignores junk and irrelevant events', () => {
  assert.equal(normalizeHook('claude', null), null);
  assert.equal(normalizeHook('claude', { hook_event_name: 'Stop' }), null);
  assert.equal(normalizeHook('claude', base('s', 'SubagentStop')), null);
  assert.equal(normalizeHook('claude', base('s', 'Notification', { notification_type: 'auth_success' })), null);
  assert.equal(snippet('x'.repeat(500)).length, 160);
});
