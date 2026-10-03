#!/usr/bin/env node
// End-to-end check of remote (multi-computer) hook ingestion, from this Mac.
//   node scripts/e2e-remote.mjs [port]        (default port 17790)
// Scratch HOME, Bonjour off, separate daemon process. Never touches the real
// ~/.aistatus, ~/.claude or ~/.codex or a running daemon on another port.
//
// The requests are sent with curl to the Mac's own LAN IP (so the daemon sees a
// non-loopback peer) and are byte-for-byte what hooks/aistatus-hook.ps1 sends:
//   POST http://<mac>:<port>/hook/codex?machine=<EscapeDataString(name)>
//   Content-Type: application/json; charset=utf-8
//   Authorization: Bearer <token>
//   body: the raw UTF-8 hook JSON from Codex's stdin
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 17790);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-e2e-remote-'));
const env = { ...process.env, HOME, AISTATUS_PORT: String(PORT), AISTATUS_BONJOUR: '0', AISTATUS_PUBLIC_PORT: 'off', AISTATUS_CODEX_SOURCE: 'hooks' };
delete env.AISTATUS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const LAN = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;
if (!LAN) {
  console.log('SKIP  no LAN IPv4 address on this Mac');
  process.exit(0);
}
console.log(`scratch HOME: ${HOME}  LAN IP: ${LAN}  port: ${PORT}`);

const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args], { env, encoding: 'utf8' });

// Same request as aistatus-hook.ps1. Returns the HTTP status (000 = no connection).
function curlHook(payload, { token, machine = 'WIN-PC', host = LAN } = {}) {
  const url = `http://${host}:${PORT}/hook/codex?machine=${encodeURIComponent(machine)}`;
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '*', '--connect-timeout', '1', '--max-time', '2', '-X', 'POST', '-H', 'Content-Type: application/json; charset=utf-8'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push('--data-binary', '@-', url);
  const r = spawnSync('/usr/bin/curl', args, { input: Buffer.from(JSON.stringify(payload), 'utf8'), encoding: 'utf8' });
  return Number(r.stdout);
}

function get(p, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port: PORT, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, text: d, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
      })
      .on('error', reject);
  });
}

let daemon;
async function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatusd.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.logs = '';
  daemon.stdout.on('data', (c) => (daemon.logs += c));
  daemon.stderr.on('data', (c) => (daemon.logs += c));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await get('/health')).status === 200) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error('daemon did not come up:\n' + daemon.logs);
}
function stopDaemon() {
  return new Promise((resolve) => {
    daemon.on('exit', (code) => resolve(code));
    daemon.kill('SIGTERM');
  });
}

try {
  // 1. no token configured: remote hooks refused
  await startDaemon();
  const sid = '019a0000-0000-7000-8000-00000000win1';
  const winCwd = 'C:\\Users\\dan\\projects\\发票-service';
  const P = (ev, extra = {}) => ({ session_id: sid, transcript_path: `C:\\Users\\dan\\.codex\\sessions\\2026\\10\\03\\rollout-${sid}.jsonl`, cwd: winCwd, hook_event_name: ev, model: 'gpt-5', ...extra });
  check(curlHook(P('UserPromptSubmit'), { token: 'x' }) === 403, 'no token on the Mac: remote hook => 403');
  check((await get('/health')).body.remoteHooks === false, '/health remoteHooks=false');
  let rs = cli('remote-setup');
  check(rs.status === 1 && /Token: +\(none\)/.test(rs.stdout), 'remote-setup without token says how to create one (exit 1)');
  await stopDaemon();

  // 2. aistatus token --new --hooks-only, restart
  const tok = cli('token', '--new', '--hooks-only').stdout.trim();
  check(/^[A-Za-z0-9_-]{32}$/.test(tok), 'aistatus token --new --hooks-only');
  await startDaemon();
  check(/remote hooks: enabled/.test(daemon.logs), 'daemon log: remote hooks enabled');
  rs = cli('remote-setup');
  check(rs.status === 0 && rs.stdout.includes(LAN) && rs.stdout.includes(`-Token '${tok}'`) && rs.stdout.includes('remote hooks enabled'), 'remote-setup shows LAN IP, token, install command, daemon state');
  console.log(rs.stdout.replace(/^/gm, '    | '));

  // 3. one-line install fetches these files from the daemon
  for (const f of ['install-windows.ps1', 'aistatus-hook.ps1']) {
    const r = await get(`/setup/${f}`, LAN);
    const local = fs.readFileSync(path.join(ROOT, f.startsWith('install') ? 'scripts' : 'hooks', f), 'utf8');
    check(r.status === 200 && r.text === local, `GET /setup/${f} from LAN => identical file`);
  }

  // 4. auth failures
  check(curlHook(P('UserPromptSubmit')) === 401, 'missing token => 401');
  check(curlHook(P('UserPromptSubmit'), { token: tok.slice(0, -1) }) === 401, 'wrong token => 401');

  // 5. a full Codex turn from "Windows", with sub-agents
  const t0 = Date.now();
  const steps = [
    ['SessionStart', { source: 'startup' }],
    ['UserPromptSubmit', { turn_id: 't1', prompt: '给发票服务加分页' }],
    ['PermissionRequest', { turn_id: 't1', tool_name: 'shell' }],
  ];
  for (const [ev, extra] of steps) check(curlHook(P(ev, extra), { token: tok }) === 200, `remote ${ev} => 200`);
  let s = (await get('/sessions', LAN)).body;
  let c = s.sessions.find((x) => x.sessionId === sid);
  check(c && c.id === `codex@WIN-PC:${sid}` && c.machine === 'WIN-PC', `card id ${c?.id}, machine ${c?.machine}`);
  check(c?.project === '发票-service', `project from Windows cwd: ${c?.project}`);
  check(c?.status === 'waiting' && c?.lastMessage === 'Permission: shell', 'remote PermissionRequest => waiting');

  curlHook(P('PostToolUse', { turn_id: 't1', tool_name: 'shell' }), { token: tok });
  curlHook(P('SubagentStart', { turn_id: 't1', agent_id: 'sub-1', agent_type: 'worker' }), { token: tok });
  curlHook(P('Stop', { turn_id: 't1', last_assistant_message: '分页已完成，子任务仍在跑' }), { token: tok });
  c = (await get('/sessions')).body.sessions.find((x) => x.sessionId === sid);
  check(c?.status === 'running' && c?.activeSubagents === 1, 'Stop with an active sub-agent keeps the remote card running');
  await sleep(300);
  curlHook(P('SubagentStop', { turn_id: 't1', agent_id: 'sub-1', agent_type: 'worker', last_assistant_message: 'ok' }), { token: tok });
  c = (await get('/sessions')).body.sessions.find((x) => x.sessionId === sid);
  check(c?.status === 'done' && c?.runDurationMs >= 300 && c?.runDurationMs < Date.now() - t0 + 1000, `last SubagentStop => done (ran ${c?.runDurationMs}ms)`);
  check(c?.lastMessage === '分页已完成，子任务仍在跑', 'UTF-8 text survives the trip');

  // 6. same session id from this Mac (loopback, like the Mac hook) => separate card
  const local = spawnSync('/bin/sh', [path.join(ROOT, 'hooks', 'aistatus-hook.sh'), 'codex', String(PORT)], {
    input: JSON.stringify({ session_id: sid, cwd: '/Users/dan/projects/mac-proj', hook_event_name: 'UserPromptSubmit' }),
  });
  check(local.status === 0, 'local hook with the same session id');
  s = (await get('/sessions')).body;
  const same = s.sessions.filter((x) => x.sessionId === sid);
  check(same.length === 2 && same.some((x) => x.id === `codex:${sid}` && x.status === 'running') && same.some((x) => x.id === `codex@WIN-PC:${sid}` && x.status === 'done'), 'no collision: local running + remote done');

  // 7. machine name fallback and sanitising
  curlHook({ session_id: 'ipfallback', cwd: 'D:\\x\\y', hook_event_name: 'UserPromptSubmit' }, { token: tok, machine: '' });
  curlHook({ session_id: 'weird', cwd: 'D:\\x\\z', hook_event_name: 'UserPromptSubmit' }, { token: tok, machine: '办公室 PC/../x' });
  s = (await get('/sessions')).body;
  check(s.sessions.find((x) => x.sessionId === 'ipfallback')?.machine === LAN, `no machine name => sender IP (${LAN})`);
  const weird = s.sessions.find((x) => x.sessionId === 'weird')?.machine;
  check(typeof weird === 'string' && weird.startsWith('办公室-PC') && !/[/:@\s]/.test(weird), `sanitised machine name: ${weird}`);

  // 8. dismiss the remote card the way the watch does
  const dis = await new Promise((resolve, reject) => {
    const r = http.request({ host: LAN, port: PORT, method: 'POST', path: `/sessions/${encodeURIComponent(`codex@WIN-PC:${sid}`)}/dismiss` }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
  check(dis === 200, 'watch-style dismiss of the remote card => 200');

  // 9. CLI list shows everything (no machine labels by design)
  const list = cli('list');
  check(list.status === 0 && list.stdout.includes('mac-proj'), 'aistatus list works with remote cards present');

  // 10. persistence across restart keeps the remote namespace
  const before = (await get('/sessions')).body.sessions.map((x) => `${x.id}:${x.status}:${x.machine}`).sort();
  await stopDaemon();
  await startDaemon();
  const after = (await get('/sessions')).body.sessions.map((x) => `${x.id}:${x.status}:${x.machine}`).sort();
  check(JSON.stringify(before) === JSON.stringify(after), `cards survive restart (${after.length})`);

  // 11. hook gives up fast when the Mac is unreachable (PowerShell uses ~1s timeouts)
  const t = Date.now();
  const code = curlHook(P('Stop'), { token: tok, host: '10.255.255.1' });
  check(code === 0 && Date.now() - t < 2500, `unreachable Mac: no response after ${Date.now() - t}ms (sender must not block)`);
} finally {
  if (daemon && daemon.exitCode === null) await stopDaemon();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL REMOTE E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
