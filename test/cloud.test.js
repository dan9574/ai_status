// End to end in a scratch HOME: real hook script (hooks/aistatus-hook.sh, as
// installed by the CLI) -> local Node server mounting the same hub handler as
// the Supabase function (in-memory storage) -> GET /sessions in the shape the
// watch decodes. Plus `aistatus cloud setup|status|off|on`, viewer commands in
// cloud mode, and the sender-side event reduction (invocation counts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHubHandler } from '../src/hub/handler.js';
import { MemoryStorage } from '../src/hub/memory-storage.js';
import { startLocalHub } from '../src/hub/node-server.js';
import { normalizeCloudUrl, checkToken, curlConfigText } from '../src/cloud.js';
import { SessionStore } from '../src/store.js';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ = 'cloud-read-0123456789abcdefXYZ';
const HOOK = 'cloud-hook-0123456789abcdefXYZ';
const FIXTURE = path.join(ROOT, 'watch', 'AIStatusKit', 'Fixtures', 'sessions-cloud.json');

let hub;
let storage;
let t = 1_791_100_000_000;

before(async () => {
  storage = new MemoryStorage();
  hub = await startLocalHub({ handler: createHubHandler({ storage, readToken: READ, hookToken: HOOK, now: () => t }) });
});
after(async () => {
  await hub?.close();
});

function env(home) {
  const e = { ...process.env, HOME: home };
  delete e.AISTATUS_DIR;
  delete e.AISTATUS_PORT;
  // the hub is on 127.0.0.1: make sure no proxy from the environment is used
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete e[k];
  e.NO_PROXY = '127.0.0.1';
  return e;
}
// Async: the hub runs in this process, so a blocking spawnSync would deadlock.
function cli(home, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args], { env: env(home) });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Run the installed hook script once, like Claude Code / Codex would. */
function runHook(home, tool, payload, port = '7778') {
  const script = path.join(home, '.aistatus', 'bin', 'aistatus-hook');
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(script, [tool, port], { env: env(home) });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
    p.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const hookCount = (tool) => hub.stats.byPath[`/functions/v1/aistatus/hook/${tool}`] || 0;
async function cards() {
  const r = await fetch(`${hub.url}/sessions`, { headers: { Authorization: `Bearer ${READ}` } });
  return (await r.json()).sessions;
}

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-cloud-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

test('cloud URL / token validation', () => {
  assert.equal(normalizeCloudUrl('https://abc.supabase.co/functions/v1/aistatus/'), 'https://abc.supabase.co/functions/v1/aistatus');
  assert.equal(normalizeCloudUrl(' https://ABC.supabase.co '), 'https://abc.supabase.co');
  assert.equal(normalizeCloudUrl('http://127.0.0.1:9/functions/v1/aistatus'), 'http://127.0.0.1:9/functions/v1/aistatus');
  assert.throws(() => normalizeCloudUrl('http://abc.supabase.co/functions/v1/aistatus'), /https/);
  assert.throws(() => normalizeCloudUrl('https://u:p@abc.supabase.co'), /credentials/);
  assert.throws(() => normalizeCloudUrl('https://abc.supabase.co/x?token=1'), /query/);
  assert.throws(() => normalizeCloudUrl('nope'), /not a URL/);
  assert.equal(checkToken('t', HOOK), HOOK);
  assert.throws(() => checkToken('--hook-token', 'short'), /16-512/);
  assert.throws(() => checkToken('--hook-token', 'has space 0123456789'), /16-512/);
  const txt = curlConfigText({ url: 'https://x.supabase.co/functions/v1/aistatus', hookToken: HOOK, machine: '办公室 Mac' });
  assert.match(txt, /^# base = https:\/\/x\.supabase\.co\/functions\/v1\/aistatus$/m);
  assert.match(txt, /^# query = machine=%E5%8A%9E%E5%85%AC%E5%AE%A4%20Mac$/m);
  assert.match(txt, new RegExp(`^header = "Authorization: Bearer ${HOOK}"$`, 'm'));
});

test('cloud setup -> hooks go to the hub, settings files untouched, reduced forwarding, watch-shaped snapshot', async () => {
  const home = mkHome();
  let r = await cli(home, 'install-hooks');
  assert.equal(r.status, 0, r.stderr);
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  const codexHooks = path.join(home, '.codex', 'hooks.json');
  const before = [fs.readFileSync(claudeSettings), fs.readFileSync(codexHooks)];

  r = await cli(home, 'cloud', 'setup', '--url', `${hub.url}/`, '--hook-token', HOOK, '--read-token', READ, '--machine', 'Test Mac');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /cloud mode ON/);
  assert.match(r.stdout, /health: +OK/);
  assert.match(r.stdout, /hook token: +OK/);
  assert.match(r.stdout, /read token: +OK \(0 cards\)/);
  assert.ok(!r.stdout.includes(HOOK) && !r.stdout.includes(READ), 'tokens are not printed');
  for (const f of ['cloud.json', 'cloud.curl']) assert.equal(fs.statSync(path.join(home, '.aistatus', f)).mode & 0o777, 0o600, f);
  assert.deepEqual([fs.readFileSync(claudeSettings), fs.readFileSync(codexHooks)], before, 'hook entries byte-identical (no Codex re-trust)');
  assert.deepEqual(
    fs.readFileSync(path.join(home, '.aistatus', 'bin', 'aistatus-hook')),
    fs.readFileSync(path.join(ROOT, 'hooks', 'aistatus-hook.sh')),
    'hook script refreshed',
  );
  // the probe sent an ignored check event: nothing stored
  assert.equal(storage.rows.size, 0);

  const sid = '11111111-2222-4333-8444-555555555555';
  const base = { session_id: sid, cwd: '/Users/me/projects/secret', transcript_path: '/Users/me/.claude/p/x.jsonl' };
  const before0 = hookCount('claude');
  const steps = [
    // [event, extra, forwarded?, expected status after (null = no card)]
    ['SessionStart', { source: 'startup' }, false, null],
    ['UserPromptSubmit', { prompt: 'secret prompt' }, true, 'running'],
    ['PostToolUse', { tool_name: 'Read', tool_response: 'x'.repeat(5000) }, false, 'running'],
    ['PostToolUse', { tool_name: 'Edit' }, false, 'running'],
    ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }, true, 'waiting'],
    ['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, true, 'waiting'],
    ['PostToolUse', { tool_name: 'Bash', tool_response: { stdout: 'y'.repeat(400_000) } }, true, 'running'],
    ['PostToolUse', { tool_name: 'Bash' }, false, 'running'],
    ['SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }, true, 'running'],
    ['PostToolUse', { agent_id: 'ag1', tool_name: 'Grep' }, false, 'running'],
    ['Stop', { last_assistant_message: 'done!' }, true, 'running'], // sub-agent still active
    ['SubagentStop', { agent_id: 'ag1' }, true, 'done'],
    ['Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, false, 'done'],
    ['SessionEnd', { reason: 'prompt_input_exit' }, true, 'done'],
  ];
  let expected = before0;
  for (const [name, extra, forwarded, status] of steps) {
    t += 1000;
    const res = await runHook(home, 'claude', { ...base, hook_event_name: name, ...extra });
    assert.equal(res.code, 0);
    assert.equal(res.out, '', 'hook prints nothing');
    if (forwarded) expected++;
    assert.equal(hookCount('claude'), expected, `${name}: ${forwarded ? 'forwarded' : 'not forwarded'}`);
    const c = (await cards()).find((x) => x.sessionId === sid);
    assert.equal(c?.status ?? null, status, `status after ${name}`);
  }
  const c = (await cards()).find((x) => x.sessionId === sid);
  assert.equal(c.id, `claude@Test-Mac:${sid}`);
  assert.equal(c.machine, 'Test-Mac');
  assert.equal(c.ended, true);
  assert.equal(c.project, null, 'minimal data: no project');
  assert.equal(c.lastMessage, null);
  assert.ok(!JSON.stringify([...storage.rows.values()]).includes('secret'), 'nothing secret stored');
  assert.equal(fs.existsSync(path.join(home, '.aistatus', 'marks', `claude-${sid}`)), false, 'marker cleared at SessionEnd');

  // Codex on the same Mac: a turn with a permission wait
  const csid = 'cx-0001';
  const cbase = { session_id: csid, cwd: '/x' };
  const c0 = hookCount('codex');
  for (const [name, extra] of [['SessionStart', {}], ['UserPromptSubmit', {}], ['PostToolUse', {}], ['PermissionRequest', { tool_name: 'shell' }]]) {
    t += 1000;
    await runHook(home, 'codex', { ...cbase, hook_event_name: name, ...extra });
  }
  assert.equal(hookCount('codex') - c0, 2);
  assert.equal((await cards()).find((x) => x.sessionId === csid).status, 'waiting');
  for (const [name, extra] of [['PostToolUse', {}], ['PostToolUse', {}], ['Stop', {}], ['PostToolUse', {}], ['Stop', {}]]) {
    t += 1000;
    await runHook(home, 'codex', { ...cbase, hook_event_name: name, ...extra });
  }
  // PostToolUse after the wait (1), Stop (1), activity right after a Stop (continuation, 1), Stop (1)
  assert.equal(hookCount('codex') - c0, 6);
  const cx = (await cards()).find((x) => x.sessionId === csid);
  assert.equal(cx.status, 'done');
  assert.equal(cx.id, 'codex@Test-Mac:cx-0001');

  // watch shape: every field of the daemon fixture the watch decodes is present with the same JSON type
  const daemonCard = JSON.parse(fs.readFileSync(path.join(ROOT, 'watch', 'AIStatusKit', 'Fixtures', 'sessions-mixed.json'), 'utf8')).sessions[0];
  const typeOf = (v) => (v === null ? 'null' : typeof v);
  for (const [k, v] of Object.entries(daemonCard)) {
    assert.ok(k in cx, `field ${k}`);
    if (v !== null && cx[k] !== null) assert.equal(typeOf(cx[k]), typeOf(v), `type of ${k}`);
  }

  // viewer commands in cloud mode
  r = await cli(home, 'list', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).sessions.map((s) => s.id).sort(), (await cards()).map((s) => s.id).sort());
  r = await cli(home, 'health');
  assert.equal(JSON.parse(r.stdout).name, 'aistatus-hub');
  r = await cli(home, 'dismiss', `codex@Test-Mac:${csid}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dismissed codex@Test-Mac:cx-0001/);
  assert.equal((await cards()).some((x) => x.sessionId === csid), false);

  r = await cli(home, 'cloud', 'status');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /mode: +CLOUD/);
  assert.match(r.stdout, /hook script: +up to date/);
  assert.ok(!r.stdout.includes(HOOK) && !r.stdout.includes(READ));
  assert.match((await cli(home, 'cloud', 'status', '--show', '--no-probe')).stdout, new RegExp(HOOK));

  // back to the local daemon: the same hook command now posts to 127.0.0.1:<port>
  r = await cli(home, 'cloud', 'off');
  assert.match(r.stdout, /cloud mode OFF/);
  assert.equal(fs.existsSync(path.join(home, '.aistatus', 'cloud.curl')), false);
  const store = new SessionStore({ machine: 'local-mac' });
  const daemon = createServer({ store });
  await new Promise((res) => daemon.listen(0, '127.0.0.1', res));
  const port = String(daemon.address().port);
  const h0 = hub.stats.requests;
  await runHook(home, 'claude', { session_id: 'loc-1', hook_event_name: 'UserPromptSubmit' }, port);
  await runHook(home, 'claude', { session_id: 'loc-1', hook_event_name: 'PostToolUse' }, port);
  assert.deepEqual(store.cards().map((x) => [x.id, x.status]), [['claude:loc-1', 'running']], 'local daemon gets the hook, local id');
  assert.equal(hub.stats.requests, h0, 'nothing went to the cloud');
  await daemon.closeAll();
  r = await cli(home, 'cloud', 'status', '--no-probe');
  assert.match(r.stdout, /mode: +local daemon/);
  assert.equal(r.status, 1);
  r = await cli(home, 'cloud', 'on');
  assert.match(r.stdout, /cloud mode ON/);
  assert.equal(fs.existsSync(path.join(home, '.aistatus', 'cloud.curl')), true);
  assert.deepEqual([fs.readFileSync(claudeSettings), fs.readFileSync(codexHooks)], before, 'still byte-identical');
  fs.rmSync(home, { recursive: true, force: true });
});

test('cloud hook: silent, exit 0 and bounded when the hub is down or the config is broken', async () => {
  const home = mkHome();
  // a port nothing listens on
  const r = await cli(home, 'cloud', 'setup', '--url', 'http://127.0.0.1:9/functions/v1/aistatus', '--hook-token', HOOK, '--no-probe');
  assert.equal(r.status, 0, r.stderr);
  let res = await runHook(home, 'claude', { session_id: 'x', hook_event_name: 'UserPromptSubmit' });
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  assert.ok(res.ms < 3000, `took ${res.ms} ms`);
  for (const bad of ['', 'not json', '{"hook_event_name":"Stop"}']) {
    res = await runHook(home, 'claude', bad);
    assert.equal(res.code, 0);
    assert.equal(res.out, '');
  }
  fs.writeFileSync(path.join(home, '.aistatus', 'cloud.curl'), 'garbage\n');
  res = await runHook(home, 'claude', { session_id: 'x', hook_event_name: 'Stop' });
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  // bad arguments are refused without touching anything
  const bad = await cli(home, 'cloud', 'setup', '--url', 'http://example.com/x', '--hook-token', HOOK);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /https/);
  assert.equal((await cli(home, 'cloud', 'setup', '--url', 'https://x.supabase.co/functions/v1/aistatus')).status, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('cloud mode without a read token: viewer commands explain; --local uses the daemon', async () => {
  const home = mkHome();
  await cli(home, 'cloud', 'setup', '--url', hub.url, '--hook-token', HOOK, '--no-probe');
  let r = await cli(home, 'list');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no read token saved/);
  r = await cli(home, 'list', '--local', '--port', '9');
  assert.match(r.stderr, /aistatusd is not reachable/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('watch fixture Fixtures/sessions-cloud.json is what the hub serves (AIStatusChecks decodes it)', async () => {
  // Deterministic hub output: minimal data mode, two machines, all three statuses.
  const st = new MemoryStorage();
  let now = 1_791_200_000_000;
  const h = createHubHandler({ storage: st, readToken: READ, hookToken: HOOK, now: () => now });
  const post = (tool, machine, payload) =>
    h(new Request(`https://r.supabase.co/functions/v1/aistatus/hook/${tool}?machine=${machine}`, { method: 'POST', headers: { Authorization: `Bearer ${HOOK}` }, body: JSON.stringify(payload) }));
  const seq = [
    ['claude', 'Daniels-MacBook-Air', { session_id: 'aaaaaaaa-0000-4000-8000-000000000001', hook_event_name: 'UserPromptSubmit' }],
    ['codex', 'WIN-PC', { session_id: 'bbbbbbbb-0000-4000-8000-000000000002', hook_event_name: 'UserPromptSubmit' }],
    ['codex', 'WIN-PC', { session_id: 'bbbbbbbb-0000-4000-8000-000000000002', hook_event_name: 'PermissionRequest', tool_name: 'shell' }],
    ['claude', 'Daniels-MacBook-Air', { session_id: 'cccccccc-0000-4000-8000-000000000003', hook_event_name: 'UserPromptSubmit' }],
    ['claude', 'Daniels-MacBook-Air', { session_id: 'cccccccc-0000-4000-8000-000000000003', hook_event_name: 'Stop' }],
  ];
  for (const [tool, m, p] of seq) {
    now += 7000;
    assert.equal((await post(tool, m, p)).status, 200);
  }
  now += 5000;
  const snap = await (await h(new Request('https://r.supabase.co/functions/v1/aistatus/sessions', { headers: { Authorization: `Bearer ${READ}` } }))).json();
  const text = JSON.stringify(snap, null, 2) + '\n';
  if (process.env.AISTATUS_WRITE_FIXTURES === '1') fs.writeFileSync(FIXTURE, text);
  assert.equal(fs.readFileSync(FIXTURE, 'utf8'), text, 'regenerate with AISTATUS_WRITE_FIXTURES=1 npm test');
});
