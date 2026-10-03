import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'aistatus-hook.sh');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-srv-'));
process.env.HOME = HOME;
delete process.env.AISTATUS_DIR;
const { startDaemon } = await import('../src/daemon.js');

let d;
const quiet = () => {};

function req(method, p, { body, host = '127.0.0.1', port = d.port, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, path: p, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// Async on purpose: the daemon runs in this process, so a sync spawn would block it.
function runHook(tool, payload, port = d.port) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', [HOOK, tool, String(port)]);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('exit', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

before(async () => {
  d = await startDaemon({ port: 0, bonjour: false, codex: { source: 'hooks' }, log: quiet });
});
after(async () => {
  await d.stop();
});

test('GET /health', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.serverTime, 'number');
});

test('hook script forwards payloads; /sessions reflects them with absolute timestamps', async () => {
  const h = await runHook('claude', { session_id: 'srv-1', cwd: '/tmp/proj-a', hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal(h.status, 0);
  assert.equal(h.stdout, '');
  assert.equal(h.stderr, '');
  const r = await req('GET', '/sessions');
  const c = r.body.sessions.find((s) => s.id === 'claude:srv-1');
  assert.equal(c.status, 'running');
  assert.equal(c.project, 'proj-a');
  assert.ok(Math.abs(c.startedAt - Date.now()) < 5000, 'startedAt is epoch ms');
  assert.equal(r.body.swipeThresholdSec, 60);
});

test('hook script exits 0 fast and silently when the daemon is down', async () => {
  const srv = http.createServer();
  // find a free port then close it so nothing listens there
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(async () => {
        try {
          const h = await runHook('claude', { session_id: 'x', hook_event_name: 'Stop' }, port);
          assert.equal(h.status, 0);
          assert.equal(h.stdout, '');
          assert.equal(h.stderr, '');
          assert.ok(h.ms < 1500, `took ${h.ms}ms`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

test('hook script gives up within ~2s when the daemon hangs', async () => {
  const hang = http.createServer(() => {}); // never responds
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const port = hang.address().port;
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn('/bin/sh', [HOOK, 'claude', String(port)]);
    p.stdin.end('{"session_id":"x","hook_event_name":"Stop"}');
    p.on('exit', resolve);
  });
  const ms = Date.now() - t0;
  hang.closeAllConnections();
  hang.close();
  assert.equal(code, 0);
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test('bad hook requests', async () => {
  assert.equal((await req('POST', '/hook/claude', { body: '{nope' })).status, 400);
  assert.equal((await req('POST', '/hook/gemini', { body: {} })).status, 404);
  assert.equal((await req('GET', '/hook/claude')).status, 405);
  const ignored = await req('POST', '/hook/claude', { body: { session_id: 'q', hook_event_name: 'SubagentStop' } });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.event, null);
});

test('hook ingestion is refused from non-loopback addresses; reads are allowed', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('no non-loopback IPv4 interface');
  const r = await req('POST', '/hook/claude', { host: ip, body: { session_id: 'lan', hook_event_name: 'UserPromptSubmit' } });
  assert.equal(r.status, 403);
  const g = await req('GET', '/sessions', { host: ip });
  assert.equal(g.status, 200);
  assert.ok(!g.body.sessions.some((s) => s.sessionId === 'lan'));
});

test('SSE pushes a full snapshot on connect and on every change', async () => {
  const frames = [];
  let res;
  const got = (n) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${n} frames, got ${frames.length}`)), 3000);
      const check = () => (frames.length >= n ? (clearTimeout(t), resolve()) : setTimeout(check, 10));
      check();
    });
  const r = http.get({ host: '127.0.0.1', port: d.port, path: '/events' }, (r2) => {
    res = r2;
    assert.equal(r2.headers['content-type'], 'text/event-stream; charset=utf-8');
    let buf = '';
    r2.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const f = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = f.split('\n').find((l) => l.startsWith('data: '));
        if (data) frames.push(JSON.parse(data.slice(6)));
      }
    });
  });
  await got(1);
  assert.ok(Array.isArray(frames[0].sessions));
  await runHook('codex', { session_id: 'sse-1', cwd: '/tmp/cx', hook_event_name: 'UserPromptSubmit' });
  await got(2);
  assert.equal(frames[1].sessions.find((s) => s.id === 'codex:sse-1').status, 'running');
  await runHook('codex', { session_id: 'sse-1', cwd: '/tmp/cx', hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await got(3);
  assert.equal(frames[2].sessions.find((s) => s.id === 'codex:sse-1').status, 'done');
  r.destroy();
  res?.destroy();
});

test('POST /sessions/:id/dismiss', async () => {
  await runHook('claude', { session_id: 'dis-1', cwd: '/tmp/a', hook_event_name: 'UserPromptSubmit' });
  await runHook('claude', { session_id: 'dis-1', cwd: '/tmp/a', hook_event_name: 'Stop' });
  const r = await req('POST', `/sessions/${encodeURIComponent('claude:dis-1')}/dismiss`);
  assert.equal(r.status, 200);
  assert.equal(r.body.dismissed.dismissPolicy, 'swipe');
  const s = await req('GET', '/sessions');
  assert.ok(!s.body.sessions.some((x) => x.id === 'claude:dis-1'));
  assert.equal((await req('POST', '/sessions/nope/dismiss')).status, 404);
  assert.equal((await req('GET', '/sessions/claude:dis-1/dismiss')).status, 405);
});

test('optional token protects non-loopback reads', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('no non-loopback IPv4 interface');
  d.config.token = 'sekrit';
  try {
    assert.equal((await req('GET', '/sessions', { host: ip })).status, 401);
    assert.equal((await req('GET', '/sessions', { host: ip, headers: { Authorization: 'Bearer sekrit' } })).status, 200);
    assert.equal((await req('GET', '/sessions?token=sekrit', { host: ip })).status, 200);
    assert.equal((await req('GET', '/sessions')).status, 200, 'loopback always allowed');
  } finally {
    d.config.token = null;
  }
});

test('state persists across restart', async () => {
  await runHook('claude', { session_id: 'persist-1', cwd: '/tmp/p', hook_event_name: 'UserPromptSubmit' });
  await d.stop();
  const stateFile = path.join(HOME, '.aistatus', 'state.json');
  assert.ok(fs.existsSync(stateFile));
  d = await startDaemon({ port: 0, bonjour: false, codex: { source: 'hooks' }, log: quiet });
  const s = await req('GET', '/sessions');
  assert.equal(s.body.sessions.find((x) => x.id === 'claude:persist-1').status, 'running');
});
