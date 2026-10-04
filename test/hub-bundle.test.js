// The Supabase Edge Function bundle (supabase/functions/aistatus/index.ts):
//  - it is exactly what scripts/build-supabase.mjs builds from src/ (in sync);
//  - the bundled file itself runs: loaded under Node with a fake `Deno` global
//    and a fake supabase-js client (test/helpers/fake-supabase.js), so the Deno
//    adapter (env names, key choice, createClient options, Deno.serve) and the
//    storage on top of the PostgREST calls are exercised, including the race.
// What this cannot prove: Deno itself, the real supabase-js/PostgREST, the SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle, OUTPUT, SUPABASE_JS_IMPORT } from '../scripts/build-supabase.mjs';
import { supabaseStorage } from '../src/hub/supabase-storage.js';
import { FakeSupabase } from './helpers/fake-supabase.js';

const READ = 'read-token-0123456789abcdef';
const HOOK = 'hook-token-0123456789abcdef';
const BASE = 'https://ref.supabase.co/functions/v1/aistatus';

test('supabase/functions/aistatus/index.ts is in sync with src/ (run: node scripts/build-supabase.mjs)', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'utf8'), bundle());
});

test('bundle: one npm import (supabase-js v2), no other imports or exports, Deno.serve', () => {
  const text = fs.readFileSync(OUTPUT, 'utf8');
  const imports = text.split('\n').filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(imports, [SUPABASE_JS_IMPORT]);
  assert.equal(text.split('\n').filter((l) => /^\s*export\b/.test(l)).length, 0);
  assert.match(text, /^\/\/ @ts-nocheck\n/);
  assert.equal((text.match(/Deno\.serve\(/g) || []).length, 1);
  assert.ok(!/node:|require\(|process\.|Buffer\b/.test(text), 'no Node APIs in the function');
  assert.ok(Buffer.byteLength(text) < 1_000_000, 'far below the 5 MB dashboard limit');
});

let seq = 0;
/** Import a private copy of the bundle with a fake Deno and createClient. */
async function loadBundle(env, db = new FakeSupabase()) {
  const text = fs.readFileSync(OUTPUT, 'utf8').replace(SUPABASE_JS_IMPORT, 'const createClient = globalThis.__aistatusTest.createClient;');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-bundle-'));
  const file = path.join(dir, `index-${++seq}.mjs`);
  fs.writeFileSync(file, text);
  const ctx = { served: [], clients: [], logs: [] };
  ctx.createClient = (url, key, options) => {
    ctx.clients.push({ url, key, options });
    return db;
  };
  globalThis.__aistatusTest = ctx;
  const origLog = console.log;
  globalThis.Deno = { env: { get: (k) => (Object.hasOwn(env, k) ? env[k] : undefined) }, serve: (h) => ctx.served.push(h) };
  console.log = (...a) => ctx.logs.push(a.join(' '));
  try {
    await import(pathToFileURL(file).href);
  } finally {
    console.log = origLog;
    delete globalThis.Deno;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(ctx.served.length, 1, 'Deno.serve called once with the handler');
  const handler = ctx.served[0];
  const call = async (method, p, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const prev = console.log;
    console.log = (...a) => ctx.logs.push(a.join(' '));
    try {
      const res = await handler(new Request(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: res.status, json: await res.json() };
    } finally {
      console.log = prev;
    }
  };
  return { ctx, db, call };
}

const ENV = {
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_default', other: 'sb_secret_other' }),
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-jwt',
  AISTATUS_READ_TOKEN: READ,
  AISTATUS_HOOK_TOKEN: HOOK,
};

test('bundle: Deno adapter uses SUPABASE_URL + the "default" secret key, no session persistence', async () => {
  const { ctx } = await loadBundle(ENV);
  assert.equal(ctx.clients.length, 1);
  assert.equal(ctx.clients[0].url, 'https://ref.supabase.co');
  assert.equal(ctx.clients[0].key, 'sb_secret_default');
  assert.deepEqual(ctx.clients[0].options.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  const legacy = await loadBundle({ ...ENV, SUPABASE_SECRET_KEYS: undefined });
  assert.equal(legacy.ctx.clients[0].key, 'legacy-service-role-jwt', 'falls back to SUPABASE_SERVICE_ROLE_KEY');
  const named = await loadBundle({ ...ENV, SUPABASE_SECRET_KEYS: JSON.stringify({ automations: 'sb_secret_x' }) });
  assert.equal(named.ctx.clients[0].key, 'sb_secret_x', 'any secret key when there is no "default"');
});

test('bundle: end to end over the fake PostgREST client (hooks, read, dismiss, auth, minimal data)', async () => {
  const { db, call, ctx } = await loadBundle(ENV);
  assert.deepEqual((await call('GET', '/health')).json, { ok: true });
  assert.equal((await call('GET', '/sessions', { token: HOOK })).status, 401);
  assert.equal((await call('POST', '/hook/claude', { token: READ, body: {} })).status, 401);
  let r = await call('POST', '/hook/claude?machine=Mac', { token: HOOK, body: { session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/Users/me/private', prompt: 'hello' } });
  assert.deepEqual(r.json, { ok: true, event: 'prompt', changed: true });
  r = await call('POST', '/hook/codex?machine=WIN-PC', { token: HOOK, body: { session_id: 's2', hook_event_name: 'PermissionRequest', tool_name: 'shell' } });
  assert.equal(r.json.event, 'wait');
  const snap = (await call('GET', '/sessions', { token: READ })).json;
  assert.deepEqual(snap.sessions.map((s) => [s.id, s.status]), [['codex@WIN-PC:s2', 'waiting'], ['claude@Mac:s1', 'running']]);
  const row = db.table('aistatus_sessions').get('claude@Mac:s1');
  assert.deepEqual(Object.keys(row).sort(), ['id', 'machine', 'session_id', 'state', 'status', 'tool', 'updated_at', 'version']);
  assert.equal(row.version, 1);
  assert.equal(row.machine, 'Mac');
  assert.equal(row.status, 'running');
  assert.ok(!JSON.stringify(row).includes('private') && !JSON.stringify(row).includes('hello'), 'minimal data');
  r = await call('POST', `/sessions/${encodeURIComponent('codex@WIN-PC:s2')}/dismiss`, { token: READ });
  assert.equal(r.status, 200);
  assert.equal(db.table('aistatus_sessions').get('codex@WIN-PC:s2').version, 2);
  assert.equal((await call('GET', '/events', { token: READ })).status, 501);
  const health = (await call('GET', '/health', { token: READ })).json;
  assert.equal(health.sessions, 1);
  assert.ok(ctx.logs.length > 0 && !ctx.logs.join('\n').includes(READ) && !ctx.logs.join('\n').includes(HOOK) && !ctx.logs.join('\n').includes('sb_secret'));
});

test('bundle: AISTATUS_STORE_DETAILS=1 keeps the project name', async () => {
  const { call } = await loadBundle({ ...ENV, AISTATUS_STORE_DETAILS: '1' });
  await call('POST', '/hook/claude?machine=Mac', { token: HOOK, body: { session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/Users/me/proj' } });
  assert.equal((await call('GET', '/sessions', { token: READ })).json.sessions[0].project, 'proj');
});

test('bundle: no database credentials -> hooks fail with 500, /health still answers', async () => {
  const { call, ctx } = await loadBundle({ AISTATUS_READ_TOKEN: READ, AISTATUS_HOOK_TOKEN: HOOK });
  assert.equal(ctx.clients.length, 0);
  assert.deepEqual((await call('GET', '/health')).json, { ok: true });
  assert.equal((await call('POST', '/hook/claude', { token: HOOK, body: { session_id: 's', hook_event_name: 'Stop' } })).status, 500);
  assert.ok(ctx.logs.some((l) => /secret API key is not available/.test(l)));
});

test('bundle: concurrent hooks on one session over PostgREST semantics: no lost update', async () => {
  const { call, db } = await loadBundle(ENV, new FakeSupabase({ latencyMs: () => Math.random() * 4 }));
  await call('POST', '/hook/claude?machine=M', { token: HOOK, body: { session_id: 'r', hook_event_name: 'UserPromptSubmit' } });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => call('POST', '/hook/claude?machine=M', { token: HOOK, body: { session_id: 'r', hook_event_name: 'SubagentStart', agent_id: `a${i}` } })),
  );
  const c = (await call('GET', '/sessions', { token: READ })).json.sessions[0];
  assert.equal(c.activeSubagents, 10);
  assert.equal(db.table('aistatus_sessions').get('claude@M:r').version, 11);
});

test('supabaseStorage: conditional writes map to one PostgREST statement each', async () => {
  const db = new FakeSupabase({ latencyMs: () => 0 });
  const s = supabaseStorage(db, { now: () => 0 });
  const st = { id: 'claude@M:x', tool: 'claude', machine: 'M', sessionId: 'x', status: 'running' };
  assert.equal(await s.put('claude@M:x', null, st), true);
  assert.equal(await s.put('claude@M:x', null, st), false, 'insert of an existing id -> conflict');
  assert.deepEqual(await s.get('claude@M:x'), { id: 'claude@M:x', state: st, version: 1 });
  assert.equal(await s.put('claude@M:x', 1, { ...st, status: 'done' }), true);
  assert.equal(await s.put('claude@M:x', 1, st), false, 'stale version');
  assert.equal(db.table('aistatus_sessions').get('claude@M:x').status, 'done');
  assert.equal(await s.remove('claude@M:x', 1), false);
  assert.equal(await s.remove('claude@M:x', 2), true);
  assert.equal(await s.get('claude@M:x'), null);
  assert.deepEqual(await s.list(), []);
  const failing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'permission denied for table', code: '42501' } }) }) }) }) };
  await assert.rejects(supabaseStorage(failing).get('x'), /database read failed: permission denied/);
  const ops = db.calls.map((c) => `${c.op}:${c.filters.join('+')}`);
  assert.ok(ops.includes('update:id+version') && ops.includes('delete:id+version'), ops.join(' '));
});
