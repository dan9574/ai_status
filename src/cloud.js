// Cloud mode on this Mac: hooks post to the cloud hub (the Supabase Edge
// Function, see supabase/ and src/hub/) instead of the local daemon, and
// `aistatus` reads from it.
//
// Files (both mode 600, in ~/.aistatus):
//   cloud.json  { url, hookToken, readToken, machine, enabled }   (for the CLI)
//   cloud.curl  curl config read by the hook script: the Authorization header,
//               plus "# base = <url>" and "# query = machine=<name>" lines.
//               Its presence is what switches the hook script to cloud mode;
//               `aistatus cloud off` removes it (cloud.json stays, so
//               `aistatus cloud on` can switch back without the tokens).
import fs from 'node:fs';
import path from 'node:path';
import { paths as getPaths, loadConfig, localMachineName, sanitizeMachine } from './config.js';
import { installHookScript, ourEntries, HOOK_SOURCE } from './installer.js';

export const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export function cloudPaths(p = getPaths()) {
  return { json: path.join(p.dataDir, 'cloud.json'), curl: path.join(p.dataDir, 'cloud.curl') };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validate the hub's base URL, e.g. https://<ref>.supabase.co/functions/v1/aistatus.
 * https only (plain http is accepted for loopback addresses, for tests); no
 * credentials, query or fragment; a path is allowed. Returns it without a
 * trailing slash, or throws.
 */
export function normalizeCloudUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error('the cloud URL must start with https:// (e.g. https://<project-ref>.supabase.co/functions/v1/aistatus)');
  }
  if (u.username || u.password) throw new Error('the cloud URL must not contain credentials');
  if (u.search || u.hash) throw new Error('the cloud URL must not contain a query or fragment');
  if (/["\s\\]/.test(u.pathname)) throw new Error('the cloud URL contains unexpected characters');
  const p = u.pathname.replace(/\/+$/, '');
  return u.origin + p;
}

export function checkToken(name, t) {
  if (!TOKEN_RE.test(String(t ?? ''))) {
    throw new Error(`${name}: 16-512 characters of A-Z a-z 0-9 . _ ~ + / = - (generate one with: openssl rand -base64 24 | tr '+/' '-_' | tr -d =)`);
  }
  return t;
}

export function readCloudConfig(p = getPaths()) {
  try {
    const c = JSON.parse(fs.readFileSync(cloudPaths(p).json, 'utf8'));
    return c && typeof c === 'object' && typeof c.url === 'string' ? c : null;
  } catch {
    return null;
  }
}

/** Cloud mode is on when the hook script would use it (cloud.curl exists) and cloud.json has a URL. */
export function cloudActive(p = getPaths()) {
  const cfg = readCloudConfig(p);
  return cfg && fs.existsSync(cloudPaths(p).curl) ? cfg : null;
}

export function curlConfigText({ url, hookToken, machine }) {
  return [
    '# aistatus cloud mode: read by ~/.aistatus/bin/aistatus-hook (curl -K). Mode 600.',
    '# Written by `aistatus cloud setup`; `aistatus cloud off` removes this file.',
    `# base = ${url}`,
    `# query = machine=${encodeURIComponent(machine)}`,
    `header = "Authorization: Bearer ${hookToken}"`,
    '',
  ].join('\n');
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Write cloud.json + cloud.curl and refresh the hook script. Returns the saved config. */
export function setupCloud({ url, hookToken, readToken, machine }, p = getPaths()) {
  const cfg = {
    url: normalizeCloudUrl(url),
    hookToken: checkToken('--hook-token', hookToken),
    readToken: readToken ? checkToken('--read-token', readToken) : null,
    machine: sanitizeMachine(machine) || localMachineName(loadConfig(p)),
    enabled: true,
  };
  installHookScript(p);
  writePrivate(cloudPaths(p).json, JSON.stringify(cfg, null, 2) + '\n');
  writePrivate(cloudPaths(p).curl, curlConfigText(cfg));
  return cfg;
}

/** Back to the local daemon: remove cloud.curl, keep cloud.json (enabled: false). */
export function cloudOff(p = getPaths()) {
  const cp = cloudPaths(p);
  const had = fs.existsSync(cp.curl);
  fs.rmSync(cp.curl, { force: true });
  const cfg = readCloudConfig(p);
  if (cfg && cfg.enabled !== false) writePrivate(cp.json, JSON.stringify({ ...cfg, enabled: false }, null, 2) + '\n');
  return had;
}

/** Re-enable cloud mode from cloud.json. */
export function cloudOn(p = getPaths()) {
  const cfg = readCloudConfig(p);
  if (!cfg || !cfg.hookToken) throw new Error('no saved cloud configuration; run: aistatus cloud setup --url … --hook-token …');
  const next = { ...cfg, enabled: true };
  installHookScript(p);
  writePrivate(cloudPaths(p).json, JSON.stringify(next, null, 2) + '\n');
  writePrivate(cloudPaths(p).curl, curlConfigText(next));
  return next;
}

export async function cloudFetch(cfg, method, route, { token, body, timeoutMs = 8000 } = {}) {
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(cfg.url + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.cause?.message || e.message };
  }
}

function hooksInstalled(p) {
  const out = {};
  for (const [name, file] of [['claude', p.claudeSettings], ['codex', p.codexHooks]]) {
    try {
      out[name] = ourEntries(JSON.parse(fs.readFileSync(file, 'utf8'))).length > 0;
    } catch {
      out[name] = false;
    }
  }
  return out;
}

function hookScriptCurrent(p) {
  try {
    return fs.readFileSync(p.hookScript).equals(fs.readFileSync(HOOK_SOURCE));
  } catch {
    return false;
  }
}

/** Probe the hub: anonymous /health, hook token (an event the hub ignores), read token. Returns lines + ok. */
export async function probeCloud(cfg) {
  const lines = [];
  let ok = true;
  const anon = await cloudFetch(cfg, 'GET', '/health');
  if (anon.error) {
    ok = false;
    lines.push(`  health:       ${cfg.url}/health -> failed (${anon.error})`);
  } else if (anon.status === 200 && anon.json?.ok === true) {
    lines.push(`  health:       OK (HTTP 200 ${anon.text.slice(0, 40)})`);
  } else {
    ok = false;
    const hint = anon.status === 401 ? ' -> turn OFF "Verify JWT" for the function in the Supabase dashboard' : anon.status === 404 ? ' -> wrong URL, or the function is not deployed under the name "aistatus"' : '';
    lines.push(`  health:       HTTP ${anon.status} ${anon.text.slice(0, 60)}${hint}`);
  }
  if (!anon.error) {
    const hook = await cloudFetch(cfg, 'POST', `/hook/claude?machine=${encodeURIComponent(cfg.machine)}`, {
      token: cfg.hookToken,
      body: { session_id: 'aistatus-check', hook_event_name: 'AIStatusCheck' },
    });
    if (hook.status === 200 && hook.json?.ok) lines.push('  hook token:   OK (accepted; the check event is ignored, nothing stored)');
    else {
      ok = false;
      const why = hook.error || `HTTP ${hook.status} ${hook.json?.error || hook.text?.slice(0, 60) || ''}`;
      lines.push(`  hook token:   NOT accepted: ${why}${hook.status === 401 ? ' -> compare with the AISTATUS_HOOK_TOKEN secret' : ''}`);
    }
    if (cfg.readToken) {
      const read = await cloudFetch(cfg, 'GET', '/sessions', { token: cfg.readToken });
      if (read.status === 200 && Array.isArray(read.json?.sessions)) lines.push(`  read token:   OK (${read.json.sessions.length} card${read.json.sessions.length === 1 ? '' : 's'})`);
      else {
        ok = false;
        const why = read.error || `HTTP ${read.status} ${read.json?.error || read.text?.slice(0, 80) || ''}`;
        lines.push(`  read token:   NOT accepted: ${why}${read.status === 401 ? ' -> compare with the AISTATUS_READ_TOKEN secret' : read.status === 500 ? ' -> database problem: was supabase/schema.sql run? (see the function logs)' : ''}`);
      }
    } else lines.push('  read token:   not saved (only needed for `aistatus list` and the watch)');
  }
  return { ok, lines };
}

export async function cloudStatus({ flags = {}, p = getPaths() } = {}) {
  const cfg = readCloudConfig(p);
  const cp = cloudPaths(p);
  const lines = ['aistatus cloud mode (hooks -> cloud hub, e.g. a Supabase Edge Function)', ''];
  if (!cfg) {
    lines.push('  not set up. Run: aistatus cloud setup --url https://<ref>.supabase.co/functions/v1/aistatus --hook-token … [--read-token …]');
    console.log(lines.join('\n'));
    process.exitCode = 1;
    return;
  }
  const show = !!flags.show;
  const tok = (t) => (t ? `set (${t.length} characters)${show ? `  ${t}` : ''}` : 'not set');
  const active = fs.existsSync(cp.curl);
  lines.push(`  mode:         ${active ? 'CLOUD (hooks post to the URL below)' : 'local daemon (cloud configuration saved; `aistatus cloud on` to switch)'}`);
  lines.push(`  url:          ${cfg.url}`);
  lines.push(`  machine:      ${cfg.machine}   (cards: <tool>@${cfg.machine}:<session>)`);
  lines.push(`  hook token:   ${tok(cfg.hookToken)}`);
  lines.push(`  read token:   ${tok(cfg.readToken)}`);
  const inst = hooksInstalled(p);
  lines.push(`  hooks:        claude ${inst.claude ? 'installed' : 'NOT installed'}, codex ${inst.codex ? 'installed' : 'not installed'}${inst.claude || inst.codex ? '' : ' -> aistatus install-hooks'}`);
  lines.push(`  hook script:  ${hookScriptCurrent(p) ? 'up to date' : 'OUTDATED or missing -> aistatus cloud setup again (or aistatus install-hooks)'}`);
  let ok = active && hookScriptCurrent(p);
  if (!flags['no-probe']) {
    const r = await probeCloud(cfg);
    lines.push(...r.lines);
    ok = ok && r.ok;
  }
  if (!show && (cfg.hookToken || cfg.readToken)) lines.push('Tokens are hidden; add --show to print them.');
  console.log(lines.join('\n'));
  if (!ok) process.exitCode = 1;
}

export async function cloudCommand(_, flags, p = getPaths()) {
  const sub = _[1] || 'status';
  switch (sub) {
    case 'setup': {
      let cfg;
      try {
        if (!flags.url) throw new Error('missing --url https://<project-ref>.supabase.co/functions/v1/aistatus');
        if (!flags['hook-token']) throw new Error('missing --hook-token (the AISTATUS_HOOK_TOKEN secret of the function)');
        cfg = setupCloud({ url: flags.url, hookToken: flags['hook-token'], readToken: flags['read-token'], machine: flags.machine }, p);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 2;
        return;
      }
      console.log(`cloud mode ON: hooks now post to ${cfg.url} as "${cfg.machine}"`);
      console.log(`  saved ${cloudPaths(p).json} and ${cloudPaths(p).curl} (mode 600), refreshed ${p.hookScript}`);
      console.log('  the hook entries in ~/.claude/settings.json and ~/.codex/hooks.json are unchanged (no new Codex trust prompt)');
      const inst = hooksInstalled(p);
      if (!inst.claude && !inst.codex) console.log('  note: no aistatus hooks are installed yet -> aistatus install-hooks');
      if (!flags['no-probe']) {
        const r = await probeCloud(cfg);
        console.log(r.lines.join('\n'));
        if (!r.ok) {
          console.log('  (cloud mode stays on; fix the hub and check again with: aistatus cloud status)');
          process.exitCode = 1;
        }
      }
      console.log('Back to the local daemon any time: aistatus cloud off');
      return;
    }
    case 'status':
      return cloudStatus({ flags, p });
    case 'off': {
      const had = cloudOff(p);
      console.log(had ? 'cloud mode OFF: hooks post to the local daemon again (cloud.json kept; `aistatus cloud on` switches back)' : 'cloud mode was not on; hooks post to the local daemon');
      return;
    }
    case 'on': {
      try {
        const cfg = cloudOn(p);
        console.log(`cloud mode ON: hooks post to ${cfg.url} as "${cfg.machine}"`);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error(`unknown: aistatus cloud ${sub} (setup | status | on | off)`);
      process.exitCode = 2;
  }
}
