// Public listener (for a tunnel such as Tailscale Funnel): nothing is trusted by
// source address, every route needs a Bearer token. Scratch HOME, ephemeral ports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-pub-'));
process.env.HOME = HOME;
delete process.env.AISTATUS_DIR;
delete process.env.AISTATUS_PUBLIC_PORT;
const { startDaemon } = await import('../src/daemon.js');
const { publicListenerPlan, publicTokens, publicClientKey, AuthFailLimiter, MIN_PUBLIC_TOKEN_LENGTH } = await import('../src/server.js');
const { DEFAULT_CONFIG } = await import('../src/config.js');

const READ = 'read-token-0123456789abcdef';
const HOOK = 'hook-token-0123456789abcdef';
const logs = [];
const log = (m) => logs.push(m);
let d;

const base = { port: 0, host: '127.0.0.1', publicPort: 0, bonjour: false, codex: { source: 'hooks' } };

function req(method, p, { body, port = d.publicPort, headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: data });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    r.end();
  });
}

const payload = (sid, ev, extra = {}) => ({ session_id: sid, cwd: 'C:\\Users\\dan\\proj\\winproj', hook_event_name: ev, ...extra });

/** Open an SSE stream; resolves to { status, first, close } once the first frame (or a non-200) arrives. */
function sse(port, token) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.get({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
      const close = () => {
        res.destroy();
        r.destroy();
      };
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode, close });
      }
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const line = buf.split('\n').find((l) => l.startsWith('data: '));
        if (line) resolve({ status: 200, first: JSON.parse(line.slice(6)), close });
      });
    });
    r.on('error', reject);
  });
}

before(async () => {
  d = await startDaemon({ ...base, token: READ, hookToken: HOOK, log });
});
after(async () => {
  await d?.stop();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('defaults: publicPort 7779, publicUrl unset', () => {
  assert.equal(DEFAULT_CONFIG.publicPort, 7779);
  assert.equal(DEFAULT_CONFIG.publicUrl, null);
});

test('plan: no token -> not started (with reason); short tokens ignored; publicPort false disables', async () => {
  assert.equal(publicListenerPlan({ publicPort: 7779 }).enabled, false);
  assert.match(publicListenerPlan({ publicPort: 7779 }).reason, /no token/);
  const weak = publicListenerPlan({ publicPort: 7779, token: 'short' });
  assert.equal(weak.enabled, false);
  assert.match(weak.reason, new RegExp(`at least ${MIN_PUBLIC_TOKEN_LENGTH}`));
  assert.equal(publicListenerPlan({ publicPort: false, token: READ }).enabled, false);
  assert.deepEqual(publicTokens({ token: READ }), { read: READ, hook: READ }, 'one shared token');
  assert.deepEqual(publicTokens({ token: READ, hookToken: HOOK }), { read: READ, hook: HOOK });
  assert.deepEqual(publicTokens({ hookToken: HOOK }), { read: null, hook: HOOK });
  assert.deepEqual(publicTokens({ token: READ, hookToken: 'short' }), { read: READ, hook: null }, 'weak hookToken does not fall back to token');

  const local = [];
  const nd = await startDaemon({ ...base, log: (m) => local.push(m) });
  try {
    assert.equal(nd.publicServer, null);
    assert.equal(nd.publicPort, null);
    assert.ok(local.some((l) => /public listener not started: no token configured/.test(l)), local.join('\n'));
    const h = await req('GET', '/health', { port: nd.port });
    assert.deepEqual(h.body.public, { listening: false, port: null, read: false, hook: false });
  } finally {
    await nd.stop();
  }
});

test('listener is bound to 127.0.0.1 only and reported in LAN /health', async () => {
  assert.equal(d.publicServer.address().address, '127.0.0.1');
  const h = await req('GET', '/health', { port: d.port });
  assert.deepEqual(h.body.public, { listening: true, port: d.publicPort, read: true, hook: true });
});

test('unauthenticated requests are refused on every route (even from loopback)', async () => {
  for (const [m, p, body] of [
    ['GET', '/sessions'],
    ['GET', '/events'],
    ['POST', '/sessions/x/dismiss', {}],
    ['POST', '/hook/claude', payload('u1', 'UserPromptSubmit')],
    ['POST', '/hook/codex', payload('u1', 'UserPromptSubmit')],
    ['GET', '/setup/install-windows.ps1'],
    ['GET', '/setup/aistatus-hook.ps1'],
    ['GET', '/'],
    ['GET', '/nope'],
  ]) {
    const r = await req(m, p, { body });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  }
  const s = await req('GET', '/sessions', { port: d.port });
  assert.ok(!s.body.sessions.some((c) => c.sessionId === 'u1'), 'no card from unauthenticated hooks');
});

test('wrong token, wrong scheme and ?token= are rejected', async () => {
  d.publicServer.limiter.map.clear();
  assert.equal((await req('GET', '/sessions', { token: READ.slice(0, -1) })).status, 401, 'prefix');
  assert.equal((await req('GET', '/sessions', { token: READ + 'x' })).status, 401, 'longer');
  assert.equal((await req('GET', '/sessions', { headers: { Authorization: `Basic ${READ}` } })).status, 401, 'Basic');
  assert.equal((await req('GET', `/sessions?token=${READ}`)).status, 401, 'query token is not accepted');
  assert.equal((await req('GET', `/events?token=${READ}`)).status, 401, 'query token is not accepted for SSE');
  assert.equal((await req('GET', '/sessions', { token: HOOK })).status, 401, 'hook token cannot read');
  d.publicServer.limiter.map.clear();
});

test('valid read token: /sessions, SSE, dismiss; setup files still not served', async () => {
  const r = await req('GET', '/sessions', { token: READ });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.sessions));
  const s = await sse(d.publicPort, READ);
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.first.sessions));
  s.close();
  assert.equal((await req('GET', '/setup/install-windows.ps1', { token: READ })).status, 404);
  assert.equal((await req('GET', '/setup/aistatus-hook.ps1', { token: READ })).status, 404);
  assert.equal((await req('POST', '/sessions/nope/dismiss', { token: READ, body: {} })).status, 404);
  assert.equal((await req('GET', '/sessions/nope/dismiss', { token: READ })).status, 405);
});

test('hooks need hookToken (read token refused); they are remote hooks', async () => {
  const p = payload('pub-1', 'UserPromptSubmit', { prompt: 'via funnel' });
  assert.equal((await req('POST', '/hook/codex?machine=WIN', { token: READ, body: p })).status, 401, 'read token cannot post hooks');
  const ok = await req('POST', '/hook/codex?machine=WIN', { token: HOOK, body: p });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.event, 'prompt');
  assert.equal((await req('GET', '/hook/codex', { token: HOOK })).status, 405);
  assert.equal((await req('POST', '/hook/gemini', { token: HOOK, body: p })).status, 404);
  assert.equal((await req('POST', '/hook/codex', { token: HOOK, body: '{nope' })).status, 400);
  // spoofing this Mac's name still yields a remote card, never a local one
  await req('POST', `/hook/claude?machine=${encodeURIComponent(d.machine)}`, { token: HOOK, body: payload('pub-2', 'UserPromptSubmit') });
  // no machine name: the forwarded client IP (right-most X-Forwarded-For), else "remote"
  await req('POST', '/hook/codex', { token: HOOK, body: payload('pub-3', 'UserPromptSubmit'), headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' } });
  await req('POST', '/hook/codex', { token: HOOK, body: payload('pub-4', 'UserPromptSubmit') });
  await req('POST', '/hook/codex', { token: HOOK, body: payload('pub-5', 'UserPromptSubmit'), headers: { 'X-AIStatus-Machine': 'Office Box' } });

  const all = (await req('GET', '/sessions', { token: READ })).body.sessions;
  const c = (sid) => all.find((s) => s.sessionId === sid);
  assert.equal(c('pub-1').id, 'codex@WIN:pub-1');
  assert.equal(c('pub-1').machine, 'WIN');
  assert.equal(c('pub-1').status, 'running');
  assert.equal(c('pub-2').id, `claude@${d.machine}:pub-2`);
  assert.ok(!all.some((s) => s.id === 'claude:pub-2'), 'not a local card');
  assert.equal(c('pub-3').machine, '203.0.113.9');
  assert.equal(c('pub-4').machine, 'remote', 'loopback socket address is never used as a machine name');
  assert.equal(c('pub-5').machine, 'Office-Box');

  const dis = await req('POST', `/sessions/${encodeURIComponent('codex@WIN:pub-1')}/dismiss`, { token: READ, body: {} });
  assert.equal(dis.status, 200);
  assert.equal(dis.body.dismissed.id, 'codex@WIN:pub-1');
  assert.equal((await req('POST', `/sessions/${encodeURIComponent('codex@WIN:pub-3')}/dismiss`, { token: HOOK, body: {} })).status, 401, 'hook token cannot dismiss');
  d.publicServer.limiter.map.clear();
});

test('one shared token: accepted for reads and hooks when hookToken is unset', async () => {
  const prev = d.config.hookToken;
  d.config.hookToken = null;
  try {
    assert.equal((await req('POST', '/hook/codex?machine=WIN', { token: READ, body: payload('sh-1', 'SessionStart') })).status, 200);
    assert.equal((await req('POST', '/hook/codex?machine=WIN', { token: HOOK, body: payload('sh-1', 'SessionStart') })).status, 401);
  } finally {
    d.config.hookToken = prev;
    d.publicServer.limiter.map.clear();
  }
});

test('/health: minimal without a valid token, full with the read token', async () => {
  const anon = await req('GET', '/health');
  assert.equal(anon.status, 200);
  assert.equal(anon.text, '{"ok":true}');
  assert.equal((await req('GET', '/health', { token: 'wrong-wrong-wrong-wrong' })).text, '{"ok":true}');
  assert.equal((await req('GET', '/health', { token: HOOK })).text, '{"ok":true}');
  assert.equal((await req('GET', `/health?token=${READ}`)).text, '{"ok":true}');
  const full = await req('GET', '/health', { token: READ });
  assert.equal(full.body.name, 'aistatusd');
  assert.equal(full.body.machine, d.machine);
  assert.equal(typeof full.body.serverTime, 'number');
  assert.equal(full.body.pid, undefined, 'no pid on the public listener');
  d.publicServer.limiter.map.clear();
});

test('body size limit: 413 by Content-Length and for chunked bodies; token checked first', async () => {
  const lim = await startDaemon({ ...base, token: READ, log: () => {}, publicLimits: { maxBodyBytes: 2048, maxSmallBodyBytes: 64 } });
  try {
    const big = JSON.stringify(payload('big', 'PostToolUse', { tool_response: 'x'.repeat(4096) }));
    const r = await req('POST', '/hook/codex', { port: lim.publicPort, token: READ, body: big });
    assert.equal(r.status, 413);
    // chunked (no Content-Length)
    const chunked = await new Promise((resolve, reject) => {
      const rq = http.request(
        { host: '127.0.0.1', port: lim.publicPort, path: '/hook/codex', method: 'POST', headers: { Authorization: `Bearer ${READ}`, 'Transfer-Encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      rq.on('error', (e) => resolve(e.code)); // the server may close while we still write
      rq.write(big.slice(0, 1500));
      setTimeout(() => {
        rq.write(big.slice(1500));
        rq.end();
      }, 20);
    });
    assert.equal(chunked, 413);
    assert.equal((await req('POST', '/sessions/x/dismiss', { port: lim.publicPort, token: READ, body: 'y'.repeat(200) })).status, 413);
    assert.equal((await req('POST', '/hook/codex', { port: lim.publicPort, body: big })).status, 401, 'unauthenticated: 401, body never read');
    const small = await req('POST', '/hook/codex?machine=W', { port: lim.publicPort, token: READ, body: payload('small', 'SessionStart') });
    assert.equal(small.status, 200);
  } finally {
    await lim.stop();
  }
});

test('SSE client cap', async () => {
  const cap = await startDaemon({ ...base, token: READ, log: () => {}, publicLimits: { maxSseClients: 2 } });
  const open = [];
  try {
    open.push(await sse(cap.publicPort, READ), await sse(cap.publicPort, READ));
    assert.deepEqual(open.map((s) => s.status), [200, 200]);
    const third = await sse(cap.publicPort, READ);
    assert.equal(third.status, 503);
    // the LAN listener is not capped
    const lan = await sse(cap.port);
    assert.equal(lan.status, 200);
    open.push(lan);
    open.shift().close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await sse(cap.publicPort, READ);
    assert.equal(again.status, 200);
    open.push(again);
  } finally {
    for (const s of open) s.close();
    await cap.stop();
  }
});

test('failed-auth rate limiting: per client, wrong tokens only, then 429', async () => {
  const rl = await startDaemon({ ...base, token: READ, log: () => {}, publicLimits: { authFailLimit: 3, authFailWindowMs: 60_000 } });
  try {
    const p = rl.publicPort;
    // requests without any Authorization header are refused but not counted
    for (let i = 0; i < 6; i++) assert.equal((await req('GET', '/sessions', { port: p })).status, 401);
    assert.equal((await req('GET', '/sessions', { port: p, token: READ })).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await req('GET', '/sessions', { port: p, token: `guess-${i}-xxxxxxxxxxxxxxxx` })).status, 401);
    const blocked = await req('GET', '/sessions', { port: p, token: READ });
    assert.equal(blocked.status, 429, 'blocked even with the right token');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal((await req('GET', '/health', { port: p })).status, 429);
    // another client behind the proxy (X-Forwarded-For) is not affected
    const other = await req('GET', '/sessions', { port: p, token: READ, headers: { 'X-Forwarded-For': '198.51.100.7' } });
    assert.equal(other.status, 200);
    // the LAN listener is not affected
    assert.equal((await req('GET', '/sessions', { port: rl.port })).status, 200);
  } finally {
    await rl.stop();
  }
  const fake = { t: 0 };
  const l = new AuthFailLimiter({ limit: 2, windowMs: 1000, now: () => fake.t });
  l.fail('a');
  l.fail('a');
  assert.equal(l.blockedFor('a'), 1);
  assert.equal(l.blockedFor('b'), 0);
  fake.t = 1000;
  assert.equal(l.blockedFor('a'), 0, 'window over');
  assert.equal(publicClientKey({ headers: { 'x-forwarded-for': 'spoofed, 192.0.2.1' }, socket: { remoteAddress: '127.0.0.1' } }), '192.0.2.1');
  assert.equal(publicClientKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
});

test('port 7778 behaviour is unchanged while the public listener runs', async () => {
  // loopback hooks need no token, loopback reads need no token
  const h = await req('POST', '/hook/claude', { port: d.port, body: { session_id: 'lan-1', cwd: '/tmp/l', hook_event_name: 'UserPromptSubmit' } });
  assert.equal(h.status, 200);
  const s = await req('GET', '/sessions', { port: d.port });
  assert.equal(s.body.sessions.find((c) => c.sessionId === 'lan-1').id, 'claude:lan-1');
  assert.equal((await req('GET', '/health', { port: d.port })).body.name, 'aistatusd');
  // setup files are still served on the LAN listener
  const f = await req('GET', '/setup/aistatus-hook.ps1', { port: d.port });
  assert.equal(f.status, 200);
  assert.equal(f.text, fs.readFileSync(path.join(ROOT, 'hooks', 'aistatus-hook.ps1'), 'utf8'));
  // and dismiss without token from loopback
  assert.equal((await req('POST', `/sessions/${encodeURIComponent('claude:lan-1')}/dismiss`, { port: d.port })).status, 200);
});

test('tokens never appear in the logs', async () => {
  await req('GET', `/sessions?token=${READ}`);
  await req('POST', `/hook/codex?token=${HOOK}`, { body: '{bad' , token: HOOK });
  await req('GET', `/nope?token=${READ}`, { token: READ });
  const all = logs.join('\n');
  assert.ok(all.length > 0);
  assert.ok(!all.includes(READ) && !all.includes(HOOK), 'token leaked into the log');
});
