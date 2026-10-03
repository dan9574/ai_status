import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, normalizeHook, snippet, projectName } from '../src/store.js';
import { sanitizeMachine } from '../src/config.js';

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

// ---------------------------------------------------------------- multi-host

const remote = (machine, ev) => ev && Object.assign(ev, { remote: true, machine });

test('local sessions carry this machine; ids stay tool:sessionId', () => {
  const store = new SessionStore({ machine: 'my-mac' });
  store.apply(normalizeHook('codex', base('s1', 'UserPromptSubmit')));
  const [c] = store.cards();
  assert.equal(c.id, 'codex:s1');
  assert.equal(c.machine, 'my-mac');
});

test('equal session ids from two machines do not collide', () => {
  const store = new SessionStore({ machine: 'my-mac' });
  store.apply(normalizeHook('codex', base('same', 'UserPromptSubmit')));
  store.apply(remote('WIN-PC', normalizeHook('codex', base('same', 'UserPromptSubmit'))));
  store.apply(remote('WIN-PC', normalizeHook('codex', base('same', 'Stop', { last_assistant_message: 'remote done' }))));
  // A remote machine that calls itself like the Mac still gets its own namespace.
  store.apply(remote('my-mac', normalizeHook('codex', base('same', 'UserPromptSubmit'))));
  const cards = store.cards();
  assert.equal(cards.length, 3);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId['codex:same'].status, 'running');
  assert.equal(byId['codex:same'].machine, 'my-mac');
  assert.equal(byId['codex@WIN-PC:same'].status, 'done');
  assert.equal(byId['codex@WIN-PC:same'].machine, 'WIN-PC');
  assert.equal(byId['codex@WIN-PC:same'].lastMessage, 'remote done');
  assert.equal(byId['codex@my-mac:same'].status, 'running');
  // exact id dismiss works; a bare session id is ambiguous
  assert.equal(store.dismiss('same'), null);
  assert.equal(store.dismiss('codex@WIN-PC:same').id, 'codex@WIN-PC:same');
  assert.equal(store.cards().length, 2);
});

test('remote events without a machine are rejected', () => {
  const store = new SessionStore();
  assert.equal(store.apply({ ...normalizeHook('codex', base('x', 'UserPromptSubmit')), remote: true }), false);
  assert.equal(store.sessions.size, 0);
});

test('project name from Windows and POSIX paths', () => {
  assert.equal(projectName('C:\\Users\\dan\\projects\\billing'), 'billing');
  assert.equal(projectName('C:\\Users\\dan\\projects\\billing\\'), 'billing');
  assert.equal(projectName('/Users/dan/projects/alpha'), 'alpha');
  assert.equal(projectName(null), null);
  const store = new SessionStore();
  store.apply(remote('WIN', normalizeHook('codex', { session_id: 'w', cwd: 'D:\\work\\repo-x', hook_event_name: 'UserPromptSubmit' })));
  assert.equal(store.cards()[0].project, 'repo-x');
});

test('a remote hook never removes a local rollout-watcher card with the same transcript path', () => {
  const store = new SessionStore();
  store.apply({ tool: 'codex', sessionId: 'w1', type: 'prompt', via: 'watcher', transcriptPath: '/x/rollout.jsonl', ts: 1 });
  store.apply(remote('WIN', { ...normalizeHook('codex', base('h1', 'UserPromptSubmit')), transcriptPath: '/x/rollout.jsonl' }));
  assert.equal(store.cards().length, 2);
});

test('machine names are sanitised and length-limited', () => {
  assert.equal(sanitizeMachine('WIN-PC'), 'WIN-PC');
  assert.equal(sanitizeMachine('  Dan\'s PC / office  '), 'Dan-s-PC-office');
  assert.equal(sanitizeMachine('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeMachine('a:b@c'), 'a-b-c', 'no id separators survive');
  assert.equal(sanitizeMachine('办公室电脑'), '办公室电脑');
  assert.equal(sanitizeMachine('x'.repeat(100)).length, 32);
  assert.equal(sanitizeMachine('<script>'), 'script');
  assert.equal(sanitizeMachine('   '), null);
  assert.equal(sanitizeMachine(''), null);
  assert.equal(sanitizeMachine(null), null);
});

test('phase-1/2 state (no machine/subagent fields) still loads as local sessions', () => {
  // Exactly what the previous version persisted (SessionStore.toJSON, version 1).
  const old = {
    version: 1,
    sessions: [
      {
        id: 'claude:old-1', tool: 'claude', sessionId: 'old-1', cwd: '/Users/me/p', project: 'p', status: 'done',
        startedAt: 1000, startedAtApprox: false, finishedAt: 5000, runDurationMs: 4000, waitingSince: null, waitingReason: null,
        lastMessage: 'ok', transcriptPath: null, interrupted: false, error: null, ended: false, dismissedAt: null,
        via: 'hook', createdAt: 1000, updatedAt: 5000,
      },
      {
        id: 'codex:old-2', tool: 'codex', sessionId: 'old-2', cwd: '/Users/me/q', project: 'q', status: 'running',
        startedAt: 2000, startedAtApprox: false, finishedAt: null, runDurationMs: null, waitingSince: null, waitingReason: null,
        lastMessage: null, transcriptPath: '/r.jsonl', interrupted: false, error: null, ended: false, dismissedAt: null,
        via: 'hook', createdAt: 2000, updatedAt: 2000,
      },
      { id: 'gemini:x', tool: 'gemini', sessionId: 'x' },
      null,
    ],
  };
  let t = 10_000;
  const store = new SessionStore({ machine: 'my-mac', now: () => t });
  store.load(old);
  assert.deepEqual([...store.sessions.keys()].sort(), ['claude:old-1', 'codex:old-2']);
  const cards = store.cards();
  assert.ok(cards.every((c) => c.machine === 'my-mac' && c.activeSubagents === 0));
  // keeps working: events continue the loaded sessions under the same ids
  store.apply(normalizeHook('codex', base('old-2', 'Stop')));
  assert.equal(store.cards().find((c) => c.id === 'codex:old-2').status, 'done');
  assert.equal(store.cards().find((c) => c.id === 'codex:old-2').runDurationMs, 8000);
  // round trip of the new format keeps remote sessions remote
  store.apply(remote('WIN', normalizeHook('codex', base('r', 'UserPromptSubmit'))));
  const copy = new SessionStore({ machine: 'renamed-mac' });
  copy.load(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(copy.sessions.get('codex@WIN:r').machine, 'WIN');
  assert.equal(copy.sessions.get('codex:old-2').machine, 'renamed-mac');
});

// ---------------------------------------------------------------- sub-agents

const sub = (id, ev, agent, extra = {}) => base(id, ev, { agent_id: agent, agent_type: 'general-purpose', ...extra });

test('Stop with an active sub-agent keeps running; done when the last one stops', () => {
  const { store, hook, advance, now } = mk();
  const t0 = now();
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'go' }));
  hook('claude', sub('s1', 'SubagentStart', 'a1'));
  hook('claude', sub('s1', 'SubagentStart', 'a2'));
  assert.equal(store.cards()[0].activeSubagents, 2);
  advance(5000);
  hook('claude', base('s1', 'Stop', { last_assistant_message: 'launched 2 agents' }));
  let [c] = store.cards();
  assert.equal(c.status, 'running', 'main turn stopped but sub-agents still active');
  assert.equal(c.finishedAt, null);
  assert.equal(c.lastMessage, 'launched 2 agents');
  advance(5000);
  hook('claude', sub('s1', 'PostToolUse', 'a2', { tool_name: 'Bash' }));
  hook('claude', sub('s1', 'SubagentStop', 'a1'));
  assert.equal(store.cards()[0].status, 'running', 'one sub-agent left');
  assert.equal(store.cards()[0].activeSubagents, 1);
  advance(80_000);
  hook('claude', sub('s1', 'SubagentStop', 'a2', { last_assistant_message: 'sub result' }));
  [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.finishedAt, now());
  assert.equal(c.runDurationMs, now() - t0);
  assert.equal(c.dismissPolicy, 'confirm');
  assert.equal(c.lastMessage, 'launched 2 agents', 'sub-agent text does not replace the main reply');
});

test('foreground sub-agents that finish before Stop do not delay done', () => {
  const { store, hook } = mk();
  hook('codex', base('c1', 'UserPromptSubmit'));
  hook('codex', sub('c1', 'SubagentStart', 'x'));
  hook('codex', sub('c1', 'SubagentStop', 'x'));
  hook('codex', base('c1', 'Stop'));
  assert.equal(store.cards()[0].status, 'done');
});

test('sub-agent tool activity never resurrects a done or dismissed run', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', base('s1', 'Stop'));
  hook('claude', sub('s1', 'PostToolUse', 'untracked', { tool_name: 'Read' }));
  assert.equal(store.cards()[0].status, 'done');
  store.dismiss('claude:s1');
  hook('claude', sub('s1', 'PostToolUse', 'untracked'));
  assert.equal(store.cards().length, 0);
});

test('a waiting sub-agent: last SubagentStop after Stop still finishes the run', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', sub('s1', 'SubagentStart', 'a'));
  hook('claude', base('s1', 'Stop'));
  hook('claude', sub('s1', 'PermissionRequest', 'a', { tool_name: 'Bash' }));
  assert.equal(store.cards()[0].status, 'waiting');
  hook('claude', sub('s1', 'SubagentStop', 'a'));
  const [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.waitingSince, null);
});

test('lost SubagentStop: a new prompt resets the sub-agent list', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', sub('s1', 'SubagentStart', 'lost'));
  hook('claude', base('s1', 'Stop'));
  assert.equal(store.cards()[0].status, 'running');
  hook('claude', base('s1', 'UserPromptSubmit', { prompt: 'next' }));
  assert.equal(store.cards()[0].activeSubagents, 0);
  hook('claude', base('s1', 'Stop'));
  assert.equal(store.cards()[0].status, 'done');
  hook('claude', sub('s1', 'SubagentStop', 'lost')); // late stop for the forgotten one: no effect
  assert.equal(store.cards()[0].status, 'done');
});

test('lost SubagentStop: timeout without events finishes the run as of the last event', () => {
  let t = 1_000_000;
  const store = new SessionStore({ now: () => t, subagentTimeoutMs: 30 * 60_000 });
  const hook = (tool, p) => store.apply(normalizeHook(tool, p));
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', sub('s1', 'SubagentStart', 'a'));
  t += 10_000;
  hook('claude', base('s1', 'Stop'));
  t += 60_000;
  hook('claude', sub('s1', 'PostToolUse', 'a')); // liveness from the sub-agent
  const lastEvent = t;
  t += 29 * 60_000;
  assert.equal(store.expireSubagents(), false, 'not yet');
  assert.equal(store.cards()[0].status, 'running');
  t += 2 * 60_000;
  assert.equal(store.expireSubagents(), true);
  const [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.finishedAt, lastEvent);
  assert.equal(c.runDurationMs, lastEvent - 1_000_000);
  assert.equal(c.activeSubagents, 0);
});

test('Interrupt and SessionEnd clear active sub-agents', () => {
  const { store, hook } = mk();
  hook('codex', base('c1', 'UserPromptSubmit'));
  hook('codex', sub('c1', 'SubagentStart', 'a'));
  hook('codex', base('c1', 'Interrupt'));
  let [c] = store.cards();
  assert.equal(c.status, 'done');
  assert.equal(c.interrupted, true);
  assert.equal(c.activeSubagents, 0);

  hook('claude', base('s2', 'UserPromptSubmit'));
  hook('claude', sub('s2', 'SubagentStart', 'b'));
  hook('claude', base('s2', 'Stop'));
  hook('claude', base('s2', 'SessionEnd', { reason: 'prompt_input_exit' }));
  c = store.cards().find((x) => x.id === 'claude:s2');
  assert.equal(c.status, 'done');
  assert.equal(c.ended, true);
});

test('sub-agent liveness events do not emit change (no SSE spam)', () => {
  const { store, hook } = mk();
  hook('claude', base('s1', 'UserPromptSubmit'));
  hook('claude', sub('s1', 'SubagentStart', 'a'));
  let n = 0;
  store.on('change', () => n++);
  assert.equal(hook('claude', sub('s1', 'PostToolUse', 'a')), false);
  assert.equal(n, 0);
});

test('normalizeHook: Subagent events need an agent_id', () => {
  assert.equal(normalizeHook('claude', base('s', 'SubagentStart')), null);
  assert.equal(normalizeHook('claude', sub('s', 'SubagentStart', 'a')).type, 'subStart');
  assert.equal(normalizeHook('codex', sub('s', 'SubagentStop', 'a')).type, 'subStop');
  assert.equal(normalizeHook('claude', sub('s', 'PostToolUse', 'a')).agentId, 'a');
});
