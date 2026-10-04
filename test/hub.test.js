// Cloud hub request handling (src/hub/handler.js) over the in-memory storage
// that mirrors the Postgres semantics: routes, auth matrix, minimal-data mode,
// compare-and-swap under concurrent hooks, housekeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHubHandler, hubTokens, tokenEquals, redactEvent, MIN_TOKEN_LENGTH } from '../src/hub/handler.js';
import { MemoryStorage, UnsafeMemoryStorage } from '../src/hub/memory-storage.js';
import { SessionStore } from '../src/store.js';
import { normalizeHook } from '../src/core.js';

const READ = 'read-token-0123456789abcdef';
const HOOK = 'hook-token-0123456789abcdef';
const BASE = 'https://ref.supabase.co/functions/v1/aistatus';

function mk(opts = {}) {
  let t = opts.t0 ?? 1_000_000;
  const logs = [];
  const storage = opts.storage ?? new MemoryStorage();
  const handler = createHubHandler({
    storage,
    readToken: READ,
    hookToken: HOOK,
    now: () => t,
    log: (m) => logs.push(m),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    ...opts,
  });
  const call = async (method, path, { token, body, headers = {}, base = BASE } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await handler(new Request(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const hook = (tool, payload, machine = 'WIN-PC', token = HOOK) => call('POST', `/hook/${tool}?machine=${encodeURIComponent(machine)}`, { token, body: payload });
  const sessions = async () => (await call('GET', '/sessions', { token: READ })).json;
  return { storage, handler, call, hook, sessions, logs, advance: (ms) => (t += ms), now: () => t };
}

const ev = (sid, name, extra = {}) => ({ session_id: sid, hook_event_name: name, cwd: '/Users/me/secret-project', transcript_path: '/Users/me/.claude/x.jsonl', ...extra });

test('tokens: read/hook split like the public listener; short tokens are refused', async () => {
  assert.deepEqual(hubTokens({ readToken: READ, hookToken: HOOK }), { read: READ, hook: HOOK });
  assert.deepEqual(hubTokens({ readToken: READ }), { read: READ, hook: READ }, 'hook falls back to the read token');
  assert.deepEqual(hubTokens({ readToken: 'short', hookToken: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }), { read: null, hook: null });
  assert.equal(await tokenEquals('abc', 'abc'), true);
  assert.equal(await tokenEquals('abc', 'abd'), false);
  assert.equal(await tokenEquals('', ''), false);
  assert.equal(await tokenEquals(null, 'x'), false);
});

test('auth matrix: every route needs its own token; unauthenticated /health says only ok', async () => {
  const h = mk();
  const cases = [
    ['GET', '/sessions', READ, 200],
    ['GET', '/sessions', HOOK, 401],
    ['GET', '/sessions', undefined, 401],
    ['GET', '/sessions', 'wrong-token-0123456789', 401],
    ['POST', '/hook/claude', HOOK, 200],
    ['POST', '/hook/claude', READ, 401],
    ['POST', '/hook/claude', undefined, 401],
    ['POST', '/sessions/claude%40X%3Anope/dismiss', READ, 404],
    ['POST', '/sessions/claude%40X%3Anope/dismiss', HOOK, 401],
    ['GET', '/events', READ, 501],
    ['GET', '/events', undefined, 401],
    ['GET', '/nope', READ, 404],
    ['GET', '/nope', undefined, 401],
  ];
  for (const [method, path, token, want] of cases) {
    const body = method === 'POST' ? ev('s1', 'SessionStart') : undefined;
    const r = await h.call(method, path, { token, body });
    assert.equal(r.status, want, `${method} ${path} with ${token ? token.slice(0, 4) : 'no'} token`);
    if (want === 401) assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  }
  const anon = await h.call('GET', '/health');
  assert.deepEqual(anon.json, { ok: true });
  const wrong = await h.call('GET', '/health', { token: HOOK });
  assert.deepEqual(wrong.json, { ok: true }, 'hook token does not unlock health details');
  const full = await h.call('GET', '/health', { token: READ });
  assert.equal(full.json.name, 'aistatus-hub');
  assert.equal(full.json.stream, false);
  assert.equal(typeof full.json.serverTime, 'number');
  // ?token= is ignored
  assert.equal((await h.call('GET', `/sessions?token=${READ}`)).status, 401);
  // Bearer is case-insensitive, like the daemon
  assert.equal((await h.call('GET', '/sessions', { headers: { Authorization: `bearer ${READ}` } })).status, 200);
});

test('no tokens configured: 503 with a hint (but /health still answers ok)', async () => {
  const h = mk({ readToken: '', hookToken: '' });
  assert.equal((await h.call('GET', '/sessions', { token: READ })).status, 503);
  assert.match((await h.call('POST', '/hook/claude', { token: HOOK, body: ev('s', 'Stop') })).json.error, /AISTATUS_READ_TOKEN/);
  assert.deepEqual((await h.call('GET', '/health')).json, { ok: true });
});

test('only a read token: it also accepts hooks (one token for everything)', async () => {
  const h = mk({ hookToken: '' });
  assert.equal((await h.hook('claude', ev('s1', 'UserPromptSubmit'), 'M', READ)).status, 200);
  assert.equal((await h.sessions()).sessions.length, 1);
});

test('base paths: /functions/v1/aistatus/…, /aistatus/… (inside Supabase) and bare paths', async () => {
  const h = mk();
  for (const base of ['https://x.supabase.co/functions/v1/aistatus', 'http://edge/aistatus', 'http://127.0.0.1:1']) {
    const r = await h.call('GET', '/sessions', { token: READ, base });
    assert.equal(r.status, 200, base);
  }
});

test('hooks: every session is remote, id tool@machine:sid, watch JSON shape', async () => {
  const h = mk();
  await h.hook('claude', ev('abc', 'UserPromptSubmit', { prompt: 'do things' }), 'Daniels-MacBook-Air');
  h.advance(5000);
  await h.hook('codex', ev('abc', 'UserPromptSubmit'), 'WIN PC/1');
  const snap = await h.sessions();
  assert.equal(snap.version, 1);
  assert.equal(snap.serverTime, h.now());
  assert.deepEqual(snap.sessions.map((s) => s.id), ['claude@Daniels-MacBook-Air:abc', 'codex@WIN-PC-1:abc']);
  const c = snap.sessions[0];
  for (const k of ['id', 'tool', 'sessionId', 'machine', 'status', 'startedAt', 'finishedAt', 'waitingSince', 'dismissPolicy', 'updatedAt', 'activeSubagents']) assert.ok(k in c, k);
  assert.equal(c.machine, 'Daniels-MacBook-Air');
  assert.equal(c.status, 'running');
  // machine from the header too; missing => "remote"
  await h.call('POST', '/hook/claude', { token: HOOK, body: ev('h1', 'UserPromptSubmit'), headers: { 'X-AIStatus-Machine': 'Hdr' } });
  await h.call('POST', '/hook/claude', { token: HOOK, body: ev('h2', 'UserPromptSubmit') });
  const ids = (await h.sessions()).sessions.map((s) => s.id);
  assert.ok(ids.includes('claude@Hdr:h1') && ids.includes('claude@remote:h2'), ids.join());
});

test('ignored events never touch storage; bad input is refused', async () => {
  const h = mk();
  const before = { ...h.storage.ops };
  let r = await h.hook('claude', { session_id: 's', hook_event_name: 'AIStatusCheck' });
  assert.deepEqual(r.json, { ok: true, event: null, changed: false });
  r = await h.hook('claude', ev('s', 'Notification', { notification_type: 'idle_prompt', message: 'waiting' }));
  assert.equal(r.json.event, null);
  assert.deepEqual(h.storage.ops, before, 'no database access for ignored events');
  assert.equal((await h.hook('gemini', ev('s', 'Stop'))).status, 404);
  assert.equal((await h.call('POST', '/hook/claude', { token: HOOK, body: '{nope' })).status, 400);
  assert.equal((await h.call('GET', '/hook/claude', { token: HOOK })).status, 405);
  assert.equal((await h.hook('claude', ev('x'.repeat(300), 'Stop'))).status, 400);
  assert.equal((await h.call('POST', '/sessions', { token: READ, body: {} })).status, 405);
});

test('body limit: >1 MiB hook payloads get 413 (declared or streamed)', async () => {
  const h = mk({ maxBodyBytes: 1000 });
  const big = JSON.stringify(ev('s', 'PostToolUse', { tool_response: 'x'.repeat(5000) }));
  assert.equal((await h.call('POST', '/hook/claude', { token: HOOK, body: big })).status, 413);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(big));
      c.close();
    },
  });
  const res = await h.handler(new Request(`${BASE}/hook/claude`, { method: 'POST', headers: { Authorization: `Bearer ${HOOK}` }, body: stream, duplex: 'half' }));
  assert.equal(res.status, 413);
});

test('minimal data by default: no paths, prompts, messages or error texts are stored', async () => {
  const h = mk();
  await h.hook('claude', ev('s1', 'UserPromptSubmit', { prompt: 'my secret prompt' }));
  await h.hook('claude', ev('s1', 'PermissionRequest', { tool_name: 'Bash' }));
  await h.hook('claude', ev('s1', 'StopFailure', { error: 'rate_limit', error_message: 'Your account xyz…' }));
  const row = [...h.storage.rows.values()][0];
  const stored = JSON.stringify(row);
  for (const secret of ['secret-project', 'my secret prompt', '/Users/me', 'Your account', 'Bash', 'rate_limit']) {
    assert.ok(!stored.includes(secret), `stored row must not contain ${secret}: ${stored}`);
  }
  const c = (await h.sessions()).sessions[0];
  assert.equal(c.project, null);
  assert.equal(c.cwd, null);
  assert.equal(c.lastMessage, null);
  assert.equal(c.status, 'done');
  assert.equal(c.error, 'error');
  assert.equal(c.machine, 'WIN-PC');
});

test('AISTATUS_STORE_DETAILS=1: project name (not the path) and message snippets', async () => {
  const h = mk({ storeDetails: true });
  await h.hook('claude', ev('s1', 'UserPromptSubmit', { prompt: 'fix   the\nbug' }));
  const c = (await h.sessions()).sessions[0];
  assert.equal(c.project, 'secret-project');
  assert.equal(c.cwd, 'secret-project', 'only the last path component is kept');
  assert.equal(c.lastMessage, 'fix the bug');
  assert.ok(!JSON.stringify([...h.storage.rows.values()]).includes('/Users/me'));
  assert.equal(redactEvent({ transcriptPath: 'x', error: 'e'.repeat(200) }, true).error.length, 80);
});

test('same state machine as the daemon: a full turn with sub-agents and a permission wait', async () => {
  const h = mk();
  const daemon = new SessionStore({ now: h.now });
  const steps = [
    ['UserPromptSubmit', {}],
    ['SubagentStart', { agent_id: 'a1' }],
    ['PermissionRequest', { tool_name: 'Bash' }],
    ['PostToolUse', {}],
    ['Stop', {}],
    ['SubagentStop', { agent_id: 'a1' }],
  ];
  for (const [name, extra] of steps) {
    h.advance(1000);
    const payload = ev('t1', name, extra);
    await h.hook('claude', payload, 'M');
    daemon.apply(Object.assign(normalize(payload), { remote: true, machine: 'M' }));
    const hub = (await h.sessions()).sessions[0];
    const d = daemon.cards()[0];
    assert.equal(hub.status, d.status, `after ${name}`);
    assert.equal(hub.startedAt, d.startedAt, `startedAt after ${name}`);
    assert.equal(hub.finishedAt, d.finishedAt, `finishedAt after ${name}`);
    assert.equal(hub.activeSubagents, d.activeSubagents, `subagents after ${name}`);
  }
  assert.equal((await h.sessions()).sessions[0].status, 'done');
});

function normalize(p) {
  const e = normalizeHook('claude', p);
  delete e.cwd;
  delete e.transcriptPath;
  delete e.message;
  return e;
}

test('SessionEnd removes an unfinished session row; a done one stays (ended)', async () => {
  const h = mk();
  await h.hook('claude', ev('a', 'UserPromptSubmit'));
  await h.hook('claude', ev('a', 'SessionEnd'));
  assert.equal(h.storage.rows.size, 0);
  await h.hook('claude', ev('b', 'UserPromptSubmit'));
  await h.hook('claude', ev('b', 'Stop'));
  await h.hook('claude', ev('b', 'SessionEnd'));
  const c = (await h.sessions()).sessions[0];
  assert.equal(c.ended, true);
  assert.equal(c.status, 'done');
});

test('dismiss: exact id, session id prefix, ended rows are deleted, unknown is 404', async () => {
  const h = mk();
  await h.hook('claude', ev('s-one', 'UserPromptSubmit'));
  await h.hook('claude', ev('s-one', 'Stop'));
  let r = await h.call('POST', `/sessions/${encodeURIComponent('claude@WIN-PC:s-one')}/dismiss`, { token: READ, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.dismissed.id, 'claude@WIN-PC:s-one');
  assert.equal((await h.sessions()).sessions.length, 0);
  assert.equal(h.storage.rows.size, 1, 'kept as idle (dismissedAt), like the daemon');
  // a late Stop of the dismissed run does not bring it back
  await h.hook('claude', ev('s-one', 'Stop'));
  assert.equal((await h.sessions()).sessions.length, 0);

  await h.hook('codex', ev('s-two', 'UserPromptSubmit'));
  await h.hook('codex', ev('s-two', 'Stop'));
  await h.hook('codex', ev('s-two', 'SessionEnd'));
  r = await h.call('POST', '/sessions/s-tw/dismiss', { token: READ });
  assert.equal(r.status, 200, 'unique prefix');
  assert.equal(h.storage.rows.has('codex@WIN-PC:s-two'), false, 'ended session row deleted');
  assert.equal((await h.call('POST', '/sessions/zzz/dismiss', { token: READ })).status, 404);
  await h.hook('claude', ev('p-1', 'UserPromptSubmit'));
  await h.hook('claude', ev('p-2', 'UserPromptSubmit'));
  assert.equal((await h.call('POST', '/sessions/p-/dismiss', { token: READ })).status, 404, 'ambiguous prefix');
});

test('housekeeping on read: idle rows pruned after 24 h, lost SubagentStop expires after 30 min', async () => {
  const h = mk();
  await h.hook('claude', ev('idle', 'SessionStart'));
  await h.hook('claude', ev('sub', 'UserPromptSubmit'));
  await h.hook('claude', ev('sub', 'SubagentStart', { agent_id: 'x' }));
  await h.hook('claude', ev('sub', 'Stop'));
  assert.equal((await h.sessions()).sessions[0].status, 'running', 'pending stop while the sub-agent runs');
  h.advance(31 * 60_000);
  const c = (await h.sessions()).sessions[0];
  assert.equal(c.status, 'done');
  assert.equal(c.activeSubagents, 0);
  assert.equal(h.storage.rows.get('claude@WIN-PC:sub').state.status, 'done', 'written back');
  h.advance(24 * 3600_000);
  await h.sessions();
  assert.equal(h.storage.rows.has('claude@WIN-PC:idle'), false, 'idle row pruned');
  assert.equal(h.storage.rows.has('claude@WIN-PC:sub'), true, 'done card stays until dismissed');
});

// ---------------------------------------------------------------- concurrency

async function burst(storage, n) {
  const h = mk({ storage, maxAttempts: 200 });
  await h.hook('claude', ev('race', 'UserPromptSubmit'));
  // n sub-agents start at the same moment: n concurrent read-modify-writes of one row.
  const res = await Promise.all(Array.from({ length: n }, (_, i) => h.hook('claude', ev('race', 'SubagentStart', { agent_id: `a${i}` }))));
  assert.ok(res.every((r) => r.status === 200));
  return { h, card: (await h.sessions()).sessions[0] };
}

test('race is real: without the version check concurrent hooks lose updates', async () => {
  const { card } = await burst(new UnsafeMemoryStorage({ latencyMs: () => Math.random() * 3 }), 12);
  assert.ok(card.activeSubagents < 12, `expected lost updates, got ${card.activeSubagents}`);
});

test('compare-and-swap: 12 concurrent hooks on one session all land', async () => {
  const storage = new MemoryStorage({ latencyMs: () => Math.random() * 3 });
  const { h, card } = await burst(storage, 12);
  assert.equal(card.activeSubagents, 12);
  assert.ok(storage.ops.conflicts > 0, 'there were conflicts, and they were retried');
  assert.ok(h.logs.some((l) => /attempts\]/.test(l)), 'retries are logged');
  // then all stop concurrently, after the main turn stopped: exactly one finishes the run
  await h.hook('claude', ev('race', 'Stop'));
  await Promise.all(Array.from({ length: 12 }, (_, i) => h.hook('claude', ev('race', 'SubagentStop', { agent_id: `a${i}` }))));
  const done = (await h.sessions()).sessions[0];
  assert.equal(done.status, 'done');
  assert.equal(done.activeSubagents, 0);
});

test('compare-and-swap: concurrent first events of a new session (insert race) and dismiss vs hook', async () => {
  const storage = new MemoryStorage({ latencyMs: () => Math.random() * 3 });
  const h = mk({ storage });
  await Promise.all([
    h.hook('claude', ev('new', 'UserPromptSubmit')),
    h.hook('claude', ev('new', 'SubagentStart', { agent_id: 'x' })),
    h.hook('claude', ev('new', 'SubagentStart', { agent_id: 'y' })),
  ]);
  const c = (await h.sessions()).sessions[0];
  assert.equal(c.status, 'running');
  // UserPromptSubmit clears sub-agents of the previous turn, so 0..2 remain depending on order;
  // but none of the three writes may be lost: the version counts them.
  assert.equal(storage.rows.get('claude@WIN-PC:new').version, 3);
  // a dismiss racing with hook activity never errors and leaves a consistent row
  const [d] = await Promise.all([
    h.call('POST', `/sessions/${encodeURIComponent('claude@WIN-PC:new')}/dismiss`, { token: READ }),
    h.hook('claude', ev('new', 'SubagentStart', { agent_id: 'z' })),
  ]);
  assert.equal(d.status, 200);
  assert.equal(storage.rows.get('claude@WIN-PC:new').version, 5);
});

test('storage errors: 500 without details; exhausted retries: 503', async () => {
  const broken = new MemoryStorage();
  broken.get = async () => {
    throw new Error('database read failed: boom');
  };
  const h = mk({ storage: broken });
  const r = await h.hook('claude', ev('s', 'Stop'));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'internal error' });
  assert.ok(h.logs.some((l) => l.includes('boom')));
  assert.ok(!h.logs.join('\n').includes(HOOK) && !h.logs.join('\n').includes(READ), 'tokens never logged');

  const busy = new MemoryStorage();
  busy.put = async () => false;
  const h2 = mk({ storage: busy, maxAttempts: 3 });
  assert.equal((await h2.hook('claude', ev('s', 'UserPromptSubmit'))).status, 503);
});
