#!/usr/bin/env node
// End-to-end check against a scratch HOME (never touches the real ~/.claude or ~/.codex).
//   node scripts/e2e.mjs [port]
// 1. install-hooks into the scratch HOME, 2. start aistatusd as a separate process,
// 3. replay hook payloads for 2 Claude + 1 Codex session through the *installed*
//    hook commands (exactly as the agents would run them), plus 1 Codex rollout file,
// 4. verify /sessions, SSE, dismiss policy, loopback-only hooks, Bonjour,
//    persistence across restart, 5. stop the daemon.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 17778);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-e2e-'));
const env = { ...process.env, HOME, AISTATUS_PORT: String(PORT), AISTATUS_PUBLIC_PORT: 'off' };
delete env.AISTATUS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function get(p, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port: PORT, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      })
      .on('error', reject);
  });
}
function post(p, body, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    r.end(JSON.stringify(body || {}));
  });
}

// --- scratch HOME setup -----------------------------------------------------
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(HOME, '.claude', 'settings.json'),
  JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true # user hook' }] }] } }, null, 2),
);
const codexDay = path.join(HOME, '.codex', 'sessions', '2026', '10', '02');
fs.mkdirSync(codexDay, { recursive: true });
fs.mkdirSync(path.join(HOME, '.aistatus'), { recursive: true });
// 3s threshold so the "long run => confirm" case does not need a 60s wait.
fs.writeFileSync(path.join(HOME, '.aistatus', 'config.json'), JSON.stringify({ swipeThresholdSec: 3 }));
console.log(`scratch HOME: ${HOME}  port: ${PORT}`);

const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args], { env, encoding: 'utf8' });
const inst = cli('install-hooks', '--port', String(PORT));
console.log(inst.stdout.trim());
check(inst.status === 0, 'install-hooks into scratch HOME');
check(cli('install-hooks', '--port', String(PORT)).stdout.includes('already installed'), 'install-hooks is idempotent');

const claudeSettings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
const codexHooks = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8'));
const cmdFor = (settings, event) => settings.hooks[event].flatMap((g) => g.hooks).find((h) => h.command.includes('aistatus-hook')).command;

// Run a hook exactly as Claude Code / Codex would: `sh -c <command>` with JSON on stdin.
function fire(tool, payload) {
  const settings = tool === 'claude' ? claudeSettings : codexHooks;
  const cmd = cmdFor(settings, payload.hook_event_name);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', ['-c', cmd], { env });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

// --- daemon ------------------------------------------------------------------
let daemon;
function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatusd.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.logs = '';
  daemon.stdout.on('data', (c) => (daemon.logs += c));
  daemon.stderr.on('data', (c) => (daemon.logs += c));
  return waitHealthy();
}
async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await get('/health')).status === 200) return true;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error('daemon did not come up:\n' + daemon.logs);
}
function stopDaemon() {
  return new Promise((resolve) => {
    daemon.on('exit', (code, sig) => resolve({ code, sig }));
    daemon.kill('SIGTERM');
  });
}

// Hook while daemon is down must be silent and fast.
{
  const r = await fire('claude', { session_id: 'down', hook_event_name: 'Stop', cwd: '/x' });
  check(r.code === 0 && r.out === '' && r.ms < 1000, `hook with daemon down: exit ${r.code}, ${r.ms}ms, silent`);
}

await startDaemon();
check(true, 'daemon started');

// SSE listener
const frames = [];
const sse = http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, (res) => {
  let buf = '';
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
});
sse.on('error', () => {});
await sleep(200);

const A = 'aaaa1111-claude-short';
const B = 'bbbb2222-claude-long';
const C = 'cccc3333-codex-hook';
const cw = (n) => `/Users/demo/projects/${n}`;
const times = [];
for (const [tool, p] of [
  ['claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'SessionStart', source: 'startup' }],
  ['claude', { session_id: B, cwd: cw('beta'), hook_event_name: 'SessionStart', source: 'startup' }],
  ['codex', { session_id: C, cwd: cw('gamma'), hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5' }],
  ['claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'UserPromptSubmit', prompt: 'what does this regex do?' }],
  ['claude', { session_id: B, cwd: cw('beta'), hook_event_name: 'UserPromptSubmit', prompt: 'refactor the parser and run tests' }],
  ['codex', { session_id: C, cwd: cw('gamma'), hook_event_name: 'UserPromptSubmit', prompt: 'add pagination', turn_id: 't1' }],
]) {
  times.push((await fire(tool, p)).ms);
}
let s = (await get('/sessions')).body;
check(s.sessions.length === 3 && s.sessions.every((x) => x.status === 'running'), `3 running cards: ${s.sessions.map((x) => x.id + '=' + x.status).join(', ')}`);

await fire('claude', { session_id: B, cwd: cw('beta'), hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
await fire('codex', { session_id: C, cwd: cw('gamma'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', turn_id: 't1' });
s = (await get('/sessions')).body;
check(s.sessions.filter((x) => x.status === 'waiting').length === 2 && s.sessions[0].status === 'waiting', 'B and C waiting, sorted first');

await sleep(1000);
await fire('claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'Stop', last_assistant_message: 'It matches ISO dates.' });
await fire('claude', { session_id: B, cwd: cw('beta'), hook_event_name: 'PostToolUse', tool_name: 'Bash' });
await fire('codex', { session_id: C, cwd: cw('gamma'), hook_event_name: 'PostToolUse', tool_name: 'Bash', turn_id: 't1' });
s = (await get('/sessions')).body;
const byId = (id) => s.sessions.find((x) => x.sessionId === id);
check(byId(A).status === 'done' && byId(A).dismissPolicy === 'swipe', `short Claude run done => swipe (ran ${byId(A).runDurationMs}ms)`);
check(byId(B).status === 'running' && byId(C).status === 'running', 'tool activity takes B and C back to running');

await sleep(3000);
await fire('claude', { session_id: B, cwd: cw('beta'), hook_event_name: 'Stop', last_assistant_message: 'Parser refactored; 120 tests pass.' });
await fire('codex', { session_id: C, cwd: cw('gamma'), hook_event_name: 'Stop', last_assistant_message: 'Pagination added.', turn_id: 't1' });
s = (await get('/sessions')).body;
check(byId(B).status === 'done' && byId(B).dismissPolicy === 'confirm', `long Claude run done => confirm (ran ${byId(B).runDurationMs}ms)`);
check(byId(C).status === 'done' && byId(C).dismissPolicy === 'confirm' && byId(C).lastMessage === 'Pagination added.', `Codex run done => confirm (ran ${byId(C).runDurationMs}ms)`);
check(typeof byId(A).startedAt === 'number' && typeof byId(A).finishedAt === 'number' && typeof s.serverTime === 'number', 'absolute epoch-ms timestamps');

// Codex rollout watcher (fallback path) on a separate session
const D = '0199ffff-dddd-7000-8000-rollout000001';
const rf = path.join(codexDay, `rollout-2026-10-02T10-00-00-${D}.jsonl`);
const L = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
fs.writeFileSync(rf, L('session_meta', { id: D, cwd: cw('delta'), originator: 'codex_work_desktop' }) + L('event_msg', { type: 'task_started', turn_id: 'x' }));
await sleep(2500);
s = (await get('/sessions')).body;
check(byId(D)?.status === 'running', 'Codex rollout watcher: task_started => running');
fs.appendFileSync(rf, L('event_msg', { type: 'task_complete', turn_id: 'x', last_agent_message: 'done via rollout' }));
await sleep(2500);
s = (await get('/sessions')).body;
check(byId(D)?.status === 'done', 'Codex rollout watcher: task_complete => done');

// restart A as running with a new prompt, then stop again
await fire('claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'UserPromptSubmit', prompt: 'and this one?' });
s = (await get('/sessions')).body;
check(byId(A).status === 'running' && byId(A).finishedAt === null, 'new prompt on done session restarts it as running');
await fire('claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'Stop', last_assistant_message: 'Also dates.' });

// idle_prompt notification after done must not flip to waiting
await fire('claude', { session_id: A, cwd: cw('alpha'), hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
s = (await get('/sessions')).body;
check(byId(A).status === 'done', 'idle_prompt notification keeps done');

// CLI list + dismiss
const list = cli('list', '--port', String(PORT));
console.log(list.stdout.replace(/^/gm, '    | '));
check(list.status === 0 && list.stdout.includes('alpha') && list.stdout.includes('gamma'), 'aistatus list prints cards');
const dis = cli('dismiss', 'aaaa1111', '--port', String(PORT));
check(dis.status === 0 && /dismissed claude:aaaa1111/.test(dis.stdout), `aistatus dismiss by prefix: ${dis.stdout.trim()}`);

// loopback-only hooks
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
if (lan) {
  const r = await post('/hook/claude', { session_id: 'evil', hook_event_name: 'UserPromptSubmit' }, lan);
  check(r.status === 403, `POST /hook from LAN address ${lan} => ${r.status}`);
  check((await get('/sessions', lan)).status === 200, 'GET /sessions from LAN address => 200');
} else console.log('SKIP  no LAN address for loopback test');

// Bonjour
const browse = spawn('/usr/bin/dns-sd', ['-B', '_aistatus._tcp', 'local']);
let bout = '';
browse.stdout.on('data', (c) => (bout += c));
await sleep(2500);
browse.kill();
check(/aistatus@/.test(bout), 'Bonjour: _aistatus._tcp instance visible via dns-sd -B');

// SSE
check(frames.length >= 10, `SSE delivered ${frames.length} snapshots`);
const last = frames[frames.length - 1];
check(last && !last.sessions.some((x) => x.sessionId === A), 'last SSE snapshot reflects dismiss');

// persistence across restart
const beforeRestart = (await get('/sessions')).body.sessions.map((x) => `${x.id}:${x.status}:${x.startedAt}`).sort();
sse.destroy();
const ex = await stopDaemon();
check(ex.code === 0, `daemon stopped cleanly on SIGTERM (code ${ex.code})`);
await startDaemon();
const afterRestart = (await get('/sessions')).body.sessions.map((x) => `${x.id}:${x.status}:${x.startedAt}`).sort();
check(JSON.stringify(beforeRestart) === JSON.stringify(afterRestart), `cards survive restart (${afterRestart.length} cards)`);
await stopDaemon();

// no stray dns-sd advertisement left behind
await sleep(300);
const ps = spawnSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout;
check(!ps.includes(`_aistatus._tcp local ${PORT}`), 'dns-sd child exited with the daemon');

console.log(`hook latency (ms): ${times.join(', ')}`);
// uninstall leaves the user's own hook
cli('uninstall-hooks');
const after = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
check(JSON.stringify(after) === JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true # user hook' }] }] } }), 'uninstall-hooks restores original settings');

console.log(failures ? `\n${failures} FAILED` : '\nALL E2E CHECKS PASSED');
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
