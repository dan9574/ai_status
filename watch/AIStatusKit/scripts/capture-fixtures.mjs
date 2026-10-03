#!/usr/bin/env node
// Capture real JSON / SSE fixtures from a real aistatusd process for the Swift tests.
//   node watch/AIStatusKit/scripts/capture-fixtures.mjs [port]
// Runs the daemon from this repo with a scratch HOME (never touches ~/.claude,
// ~/.codex or ~/.aistatus), Bonjour off, feeds it simulated hook payloads over
// POST /hook/:tool exactly like the hook forwarder does, and writes the raw
// responses into watch/AIStatusKit/Fixtures/. Then stops the daemon.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(HERE, '..', 'Fixtures');
const PORT = Number(process.argv[2] || 17779);
const TOKEN = 'fixture-token';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-fixtures-'));
const env = { ...process.env, HOME, AISTATUS_PORT: String(PORT), AISTATUS_BONJOUR: '0', AISTATUS_CODEX_SOURCE: 'hooks' };
delete env.AISTATUS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(HOME, '.aistatus'), { recursive: true });
// 2s swipe threshold so both dismiss policies appear without long waits.
fs.writeFileSync(path.join(HOME, '.aistatus', 'config.json'), JSON.stringify({ swipeThresholdSec: 2, token: TOKEN }));
fs.mkdirSync(OUT, { recursive: true });

function request(method, p, { host = '127.0.0.1', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const hook = (tool, payload) => request('POST', `/hook/${tool}`, { body: payload });
const save = (name, text) => {
  fs.writeFileSync(path.join(OUT, name), text.endsWith('\n') ? text : text + '\n');
  console.log(`wrote Fixtures/${name} (${text.length} bytes)`);
};
const pretty = (text) => JSON.stringify(JSON.parse(text), null, 2);

const daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatusd.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
daemon.stdout.on('data', (c) => (logs += c));
daemon.stderr.on('data', (c) => (logs += c));
for (let i = 0; ; i++) {
  try {
    if ((await request('GET', '/health')).status === 200) break;
  } catch {}
  if (i > 50) throw new Error('daemon did not start\n' + logs);
  await sleep(100);
}

// Raw SSE capture for the whole scenario (bytes exactly as sent).
let sseRaw = '';
const sse = http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, (res) => res.on('data', (c) => (sseRaw += c)));
sse.on('error', () => {});
await sleep(200);

save('sessions-empty.json', pretty((await request('GET', '/sessions')).text));

const cw = (n) => `/Users/demo/projects/${n}`;
const S = {
  run: 'a1b2c3d4-0000-4000-8000-00000000run1',
  wait: 'b2c3d4e5-0000-4000-8000-0000000wait1',
  quick: 'c3d4e5f6-0000-4000-8000-000000quick1',
  long: 'd4e5f6a7-0000-4000-8000-0000000long1',
  cxq: 'e5f6a7b8-0000-4000-8000-00000codexq1',
  cxi: 'f6a7b8c9-0000-4000-8000-00000codexi1',
  fail: '0a1b2c3d-0000-4000-8000-000000fail01',
  approx: '1b2c3d4e-0000-4000-8000-00000approx1',
};
for (const [k, id] of Object.entries(S)) {
  const tool = k.startsWith('cx') ? 'codex' : 'claude';
  await hook(tool, { session_id: id, cwd: cw(k === 'long' ? 'beta-service' : `proj-${k}`), hook_event_name: 'SessionStart', source: 'startup' });
}
await hook('claude', { session_id: S.long, cwd: cw('beta-service'), hook_event_name: 'UserPromptSubmit', prompt: 'refactor the parser and run the full test suite' });
await hook('claude', { session_id: S.fail, cwd: cw('proj-fail'), hook_event_name: 'UserPromptSubmit', prompt: 'summarise the logs' });
await hook('codex', { session_id: S.cxi, cwd: cw('proj-cxi'), hook_event_name: 'UserPromptSubmit', prompt: 'migrate the db', turn_id: 't1' });
await sleep(2500); // > swipe threshold => confirm
await hook('claude', { session_id: S.long, cwd: cw('beta-service'), hook_event_name: 'Stop', last_assistant_message: 'Parser refactored; 120 tests pass.' });
await hook('codex', { session_id: S.cxi, cwd: cw('proj-cxi'), hook_event_name: 'Interrupt', turn_id: 't1' });
await hook('claude', { session_id: S.fail, cwd: cw('proj-fail'), hook_event_name: 'StopFailure', error: 'rate_limit', error_message: 'API rate limit reached' });

await hook('claude', { session_id: S.quick, cwd: cw('proj-quick'), hook_event_name: 'UserPromptSubmit', prompt: 'what does this regex do?' });
await sleep(300);
await hook('claude', { session_id: S.quick, cwd: cw('proj-quick'), hook_event_name: 'Stop', last_assistant_message: 'It matches ISO-8601 dates.' });

await hook('claude', { session_id: S.run, cwd: cw('proj-run'), hook_event_name: 'UserPromptSubmit', prompt: 'add pagination to the list endpoint' });
await hook('claude', { session_id: S.wait, cwd: cw('proj-wait'), hook_event_name: 'UserPromptSubmit', prompt: 'deploy to staging' });
await hook('claude', { session_id: S.wait, cwd: cw('proj-wait'), hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
await hook('codex', { session_id: S.cxq, cwd: cw('proj-cxq'), hook_event_name: 'UserPromptSubmit', prompt: 'pick a library', turn_id: 't9' });
await hook('claude', { session_id: S.cxq, cwd: cw('proj-cxq'), hook_event_name: 'SessionStart' }); // different tool, ignored as idle
await hook('codex', { session_id: S.cxq, cwd: cw('proj-cxq'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', turn_id: 't9' });
await hook('claude', { session_id: S.approx, cwd: cw('proj-approx'), hook_event_name: 'PostToolUse', tool_name: 'Edit' }); // missed prompt

const mixed = await request('GET', '/sessions');
save('sessions-mixed.json', pretty(mixed.text));

// Dismiss: success (by full id, URL-encoded), unknown id (404), wrong method (405).
const dis = await request('POST', `/sessions/${encodeURIComponent(`claude:${S.quick}`)}/dismiss`, { body: {} });
save('dismiss-ok.json', pretty(dis.text));
const dis404 = await request('POST', '/sessions/claude%3Anope/dismiss', { body: {} });
save('dismiss-404.json', pretty(dis404.text));
console.log(`dismiss statuses: ${dis.status} ${dis404.status}`);

save('sessions-after-dismiss.json', pretty((await request('GET', '/sessions')).text));
save('health.json', pretty((await request('GET', '/health')).text));

// Token: loopback is always allowed; from the LAN address it must be enforced.
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
if (lan) {
  const no = await request('GET', '/sessions', { host: lan });
  const yes = await request('GET', '/sessions', { host: lan, headers: { Authorization: `Bearer ${TOKEN}` } });
  save('unauthorized.json', pretty(no.text));
  console.log(`token check from ${lan}: without=${no.status} with=${yes.status}`);
} else console.log('no LAN address; skipped unauthorized.json');

console.log('waiting 16s for an SSE keep-alive ping…');
await sleep(16_000);
sse.destroy();
fs.writeFileSync(path.join(OUT, 'events-stream.txt'), sseRaw);
console.log(`wrote Fixtures/events-stream.txt (${sseRaw.length} bytes, ${(sseRaw.match(/^event: snapshot$/gm) || []).length} snapshots, ${(sseRaw.match(/^: ping/gm) || []).length} pings)`);

daemon.kill('SIGTERM');
await new Promise((r) => daemon.on('exit', r));
fs.rmSync(HOME, { recursive: true, force: true });
console.log('daemon stopped; scratch HOME removed');
