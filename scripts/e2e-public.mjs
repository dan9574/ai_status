#!/usr/bin/env node
// End-to-end check of the public listener (what Tailscale Funnel would expose).
//   node scripts/e2e-public.mjs [lanPort] [publicPort] [proxyPort]   (default 17800 17801 17802)
// Scratch HOME, Bonjour off, separate daemon process, EVERYTHING bound to
// 127.0.0.1 (nothing is reachable from the network). Never touches the real
// ~/.aistatus, ~/.claude, ~/.codex, a running daemon, or Tailscale.
//
// A tiny local reverse proxy on proxyPort stands in for the tunnel: like
// Funnel it connects to the public listener from loopback and appends the
// client address to X-Forwarded-For. Requests are sent the way the watch
// (Bearer on every request incl. SSE) and hooks/aistatus-hook.ps1 send them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAN_PORT = Number(process.argv[2] || 17800);
const PUB_PORT = Number(process.argv[3] || 17801);
const PROXY_PORT = Number(process.argv[4] || 17802);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-e2e-public-'));
const env = {
  ...process.env,
  HOME,
  AISTATUS_PORT: String(LAN_PORT),
  AISTATUS_HOST: '127.0.0.1',
  AISTATUS_PUBLIC_PORT: String(PUB_PORT),
  AISTATUS_BONJOUR: '0',
  AISTATUS_CODEX_SOURCE: 'hooks',
};
delete env.AISTATUS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args, '--port', String(LAN_PORT)], { env, encoding: 'utf8' });
// For commands that call the stand-in tunnel (it runs in this process: no sync spawn).
const cliAsync = (...args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args, '--port', String(LAN_PORT)], { env });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('exit', (status) => resolve({ status, stdout }));
  });

function request(port, method, p, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json; charset=utf-8';
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(d);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, text: d, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const viaProxy = (...a) => request(PROXY_PORT, ...a);

// Same request as aistatus-hook.ps1 with "url" set (machine in the query, raw UTF-8 JSON, Bearer).
function curlHook(payload, { token, machine = 'WIN-PC' } = {}) {
  const url = `http://127.0.0.1:${PROXY_PORT}/hook/codex?machine=${encodeURIComponent(machine)}`;
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '*', '--connect-timeout', '1', '--max-time', '3', '-X', 'POST', '-H', 'Content-Type: application/json; charset=utf-8'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push('--data-binary', '@-', url);
  // Async: the stand-in tunnel runs in this process, a sync spawn would block it.
  return new Promise((resolve) => {
    const c = spawn('/usr/bin/curl', args);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', () => resolve(Number(out)));
    c.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
  });
}

// The stand-in tunnel: forwards everything (streaming, so SSE works) and appends X-Forwarded-For.
const proxy = http.createServer((req, res) => {
  const client = req.headers['x-test-client'] || '203.0.113.50';
  const xff = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${client}` : client;
  const headers = { ...req.headers, 'x-forwarded-for': xff };
  delete headers['x-test-client'];
  const up = http.request({ host: '127.0.0.1', port: PUB_PORT, path: req.url, method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
  res.on('close', () => up.destroy());
});

let daemon;
async function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatusd.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.logs = '';
  daemon.stdout.on('data', (c) => (daemon.logs += c));
  daemon.stderr.on('data', (c) => (daemon.logs += c));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await request(LAN_PORT, 'GET', '/health')).status === 200) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error('daemon did not come up:\n' + daemon.logs);
}
const stopDaemon = () =>
  new Promise((resolve) => {
    daemon.once('exit', resolve);
    daemon.kill('SIGTERM');
  });

function openSse(token) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const headers = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/events', headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = f.split('\n').find((l) => l.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ status: res.statusCode, frames, close: () => (res.destroy(), r.destroy()) });
    });
    r.on('error', reject);
  });
}

console.log(`scratch HOME: ${HOME}  LAN port: ${LAN_PORT}  public port: ${PUB_PORT}  proxy: ${PROXY_PORT} (all 127.0.0.1)`);
try {
  // 1. no token: the public listener does not start
  await startDaemon();
  check(/public listener not started: no token configured/.test(daemon.logs), 'no token => public listener not started (logged)');
  check((await request(LAN_PORT, 'GET', '/health')).body.public?.listening === false, 'LAN /health: public.listening=false');
  await request(PUB_PORT, 'GET', '/health').then(
    () => check(false, 'nothing listens on the public port'),
    (e) => check(e.code === 'ECONNREFUSED', `nothing listens on the public port (${e.code})`),
  );
  await stopDaemon();

  // 2. separate read + hook tokens and the public URL via the CLI, restart
  const READ = cli('token', '--new').stdout.trim();
  const HOOK = cli('token', '--new', '--hooks-only').stdout.trim();
  check(/^[A-Za-z0-9_-]{32}$/.test(READ) && /^[A-Za-z0-9_-]{32}$/.test(HOOK) && READ !== HOOK, 'aistatus token --new / --new --hooks-only');
  check(cli('token', '--read').stdout.trim() === READ && cli('token').stdout.trim() === HOOK, 'token --read prints the read token, token the hook token');
  check(cli('public-url', `http://127.0.0.1:${PROXY_PORT}`).status === 0, 'aistatus public-url');
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  await startDaemon();
  check(new RegExp(`public listener on http://127\\.0\\.0\\.1:${PUB_PORT}`).test(daemon.logs), 'daemon log: public listener up');
  check(!daemon.logs.includes(READ) && !daemon.logs.includes(HOOK), 'daemon log has no tokens');

  // 3. through the tunnel: nothing without a token
  const anon = await viaProxy('GET', '/health');
  check(anon.status === 200 && anon.text === '{"ok":true}', `GET /health without token => ${anon.text}`);
  check((await viaProxy('GET', '/sessions')).status === 401, 'GET /sessions without token => 401');
  check((await viaProxy('GET', `/sessions?token=${READ}`)).status === 401, '?token= is not accepted');
  check((await viaProxy('GET', '/setup/install-windows.ps1')).status === 401, '/setup without token => 401');
  check((await viaProxy('GET', '/setup/install-windows.ps1', { token: READ })).status === 404, '/setup with token => 404 (never served publicly)');
  check(await curlHook({ session_id: 'x', hook_event_name: 'SessionStart' }) === 401, 'hook without token => 401');
  check(await curlHook({ session_id: 'x', hook_event_name: 'SessionStart' }, { token: READ }) === 401, 'hook with the read token => 401 (hookToken is set)');
  check((await viaProxy('GET', '/sessions', { token: HOOK })).status === 401, 'read with the hook token => 401');

  // 4. the watch: full health, snapshot, SSE with Bearer
  const h = await viaProxy('GET', '/health', { token: READ });
  check(h.body?.name === 'aistatusd' && h.body?.pid === undefined, 'GET /health with read token => full (no pid)');
  check((await viaProxy('GET', '/sessions', { token: READ })).status === 200, 'GET /sessions with read token => 200');
  const sse = await openSse(READ);
  check(sse.status === 200, 'SSE /events with Bearer => 200');
  await sleep(200);
  check(sse.frames.length >= 1, 'SSE first snapshot');

  // 5. Windows hook via the tunnel => remote card, pushed over SSE
  const sid = 'pub-e2e-0001';
  const P = (ev, extra = {}) => ({ session_id: sid, cwd: 'C:\\Users\\dan\\projects\\发票-service', hook_event_name: ev, ...extra });
  check(await curlHook(P('UserPromptSubmit', { prompt: '给发票服务加分页' }), { token: HOOK }) === 200, 'remote UserPromptSubmit via tunnel => 200');
  await sleep(300);
  const pushed = sse.frames.at(-1)?.sessions.find((s) => s.sessionId === sid);
  check(pushed?.id === `codex@WIN-PC:${sid}` && pushed?.status === 'running' && pushed?.project === '发票-service', `SSE pushed the remote card (${pushed?.id})`);
  check(await curlHook(P('Stop', { last_assistant_message: '完成' }), { token: HOOK }) === 200, 'remote Stop => 200');
  await sleep(300);
  check(sse.frames.at(-1)?.sessions.find((s) => s.sessionId === sid)?.status === 'done', 'SSE pushed done');
  // no machine name: the client address appended by the proxy
  await viaProxy('POST', '/hook/codex', { token: HOOK, body: { session_id: 'pub-e2e-ip', hook_event_name: 'UserPromptSubmit' }, headers: { 'X-Forwarded-For': '6.6.6.6' } });
  const ipCard = (await viaProxy('GET', '/sessions', { token: READ })).body.sessions.find((s) => s.sessionId === 'pub-e2e-ip');
  check(ipCard?.machine === '203.0.113.50', `machine falls back to the proxy-appended client IP, not the spoofed one (${ipCard?.machine})`);

  // 6. dismiss from the watch via the tunnel
  const dis = await viaProxy('POST', `/sessions/${encodeURIComponent(`codex@WIN-PC:${sid}`)}/dismiss`, { token: READ, body: {} });
  check(dis.status === 200, 'dismiss via tunnel with read token => 200');
  await sleep(200);
  check(!sse.frames.at(-1)?.sessions.some((s) => s.sessionId === sid), 'SSE pushed the dismissal');
  sse.close();

  // 7. hardening
  const big = JSON.stringify(P('PostToolUse', { tool_response: 'x'.repeat(1_200_000) }));
  const r413 = await viaProxy('POST', '/hook/codex?machine=WIN-PC', { token: HOOK, body: big });
  check(r413.status === 413, `hook body over 1 MiB => ${r413.status}`);
  const streams = [];
  for (let i = 0; i < 9; i++) streams.push(await openSse(READ));
  check(streams.slice(0, 8).every((s) => s.status === 200) && streams[8].status === 503, `9th public SSE stream => ${streams[8].status}`);
  for (const s of streams) s.close();
  for (let i = 0; i < 10; i++) await viaProxy('GET', '/sessions', { token: `guess-${i}-xxxxxxxxxxxxxxxxxxxxxxxx`, headers: { 'X-Test-Client': '198.51.100.66' } });
  const limited = await viaProxy('GET', '/sessions', { token: READ, headers: { 'X-Test-Client': '198.51.100.66' } });
  check(limited.status === 429 && Number(limited.headers['retry-after']) > 0, `10 wrong tokens => 429 for that client (${limited.status})`);
  check((await viaProxy('GET', '/sessions', { token: READ })).status === 200, 'other clients are not affected');

  // 8. LAN port unchanged: local hooks without token, setup files, loopback reads
  const local = spawnSync('/bin/sh', [path.join(ROOT, 'hooks', 'aistatus-hook.sh'), 'claude', String(LAN_PORT)], { input: JSON.stringify({ session_id: 'pub-e2e-local', cwd: '/tmp/x', hook_event_name: 'UserPromptSubmit' }) });
  check(local.status === 0, 'local hook script exits 0');
  const lanSessions = (await request(LAN_PORT, 'GET', '/sessions')).body.sessions;
  check(lanSessions.find((s) => s.sessionId === 'pub-e2e-local')?.id === 'claude:pub-e2e-local', 'local hook on the LAN port => local card, no token needed');
  check((await request(LAN_PORT, 'GET', '/setup/aistatus-hook.ps1')).status === 200, 'setup files still served on the LAN port');

  // 9. CLI reports
  const ps = await cliAsync('public-status');
  check(ps.status === 0 && new RegExp(`public listener up on 127\\.0\\.0\\.1:${PUB_PORT}`).test(ps.stdout), 'public-status: listener up (exit 0)');
  check(/public probe: .*HTTP 200 \{"ok":true\}/.test(ps.stdout), 'public-status: probes the public URL');
  check(!ps.stdout.includes(READ) && !ps.stdout.includes(HOOK), 'public-status hides tokens');
  check((await cliAsync('public-status', '--show')).stdout.includes(READ), 'public-status --show prints them');
  const rs = cli('remote-setup');
  check(rs.stdout.includes(`-BaseUrl 'http://127.0.0.1:${PROXY_PORT}' -Token '${HOOK}'`), 'remote-setup prints the -BaseUrl install command');
  console.log(ps.stdout.replace(READ, '<read>').replace(HOOK, '<hook>').replace(/^/gm, '    | '));

  check(!daemon.logs.includes(READ) && !daemon.logs.includes(HOOK), 'daemon log still has no tokens');
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.stack}`);
  if (daemon) console.log(daemon.logs);
} finally {
  if (daemon && daemon.exitCode === null) await stopDaemon();
  proxy.closeAllConnections?.();
  proxy.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
