// `aistatus` command line.
import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig, paths as getPaths, generateToken, updateUserConfig, hookTokenOf, localMachineName } from './config.js';
import { renderCards } from './render.js';
import { installHooks, uninstallHooks, installDaemonPlist } from './installer.js';
import { cloudActive, cloudCommand, cloudFetch } from './cloud.js';

const USAGE = `aistatus — Claude Code / Codex session status

Usage:
  aistatus                      live card view (q to quit)
  aistatus list [--json]        print current cards once
  aistatus dismiss <id>         dismiss a card (full id, session id or unique prefix)
  aistatus health               daemon health
  aistatus daemon               run the daemon (aistatusd) in the foreground
  aistatus install-hooks [--claude] [--codex] [--port N]
  aistatus uninstall-hooks [--claude] [--codex]
  aistatus install-daemon [--print]   write the launchd plist (does not load it)
  aistatus token [--read] [--new [--hooks-only | --shared]]
                                print the token remote hook senders must use
                                (--read: the token the watch must use);
                                --new generates and saves "token" (watch/reads,
                                and hooks unless a hookToken is set);
                                --new --hooks-only saves "hookToken" (hooks only);
                                --new --shared saves "token" and removes
                                "hookToken" (one token for everything)
  aistatus remote-setup [--public-url URL]
                                values + install command for another computer
                                (e.g. a Windows PC running Codex)
  aistatus public-url [URL | --clear]
                                show / save the public base URL of the tunnel
                                (e.g. https://mac.tailnet.ts.net)
  aistatus public-status [--show] [--no-probe]
                                is the public listener (publicPort) up, which
                                tokens are set (--show prints them), and does
                                the public URL answer
  aistatus cloud setup --url URL --hook-token T [--read-token T] [--machine NAME] [--no-probe]
                                cloud mode: hooks post to the cloud hub (Supabase
                                Edge Function) instead of the local daemon; the
                                hook entries in the agents' settings do not change
  aistatus cloud status [--show] [--no-probe]
                                cloud configuration + probes (--show prints tokens)
  aistatus cloud off | on       back to the local daemon / to the saved cloud hub

Options:
  --port N    daemon port (default from ~/.aistatus/config.json, else 7778)
  --host H    daemon host for viewer commands (default 127.0.0.1)
  --local     viewer commands use the local daemon even in cloud mode
  --interval S  live view poll interval in cloud mode (default 5 s)
In cloud mode (aistatus cloud setup), the viewer commands (live view, list,
dismiss, health) talk to the cloud hub with the saved read token.
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args.flags[k] = v;
      else if (['port', 'host', 'public-url', 'url', 'hook-token', 'read-token', 'machine', 'interval'].includes(k)) args.flags[k] = argv[++i];
      else args.flags[k] = true;
    } else args._.push(a);
  }
  return args;
}

function request(method, { host, port, path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, timeout: 3000, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function notRunning(host, port, e) {
  console.error(`aistatusd is not reachable at ${host}:${port} (${e.code || e.message}). Start it with: aistatus daemon`);
  process.exitCode = 1;
}

function targetsFrom(flags) {
  const t = [];
  if (flags.claude) t.push('claude');
  if (flags.codex) t.push('codex');
  return t.length ? t : ['claude', 'codex'];
}

async function live({ host, port }) {
  const out = process.stdout;
  const tty = out.isTTY;
  let snapshot = null;
  let skew = 0; // serverTime - local time at receipt
  let status = 'connecting…';
  let req = null;

  const draw = () => {
    const now = Date.now() + skew;
    const width = out.columns || 80;
    const n = snapshot?.sessions?.length ?? 0;
    const head = `aistatus · ${n} card${n === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()} · ${status}`;
    const body = snapshot ? renderCards(snapshot, { now, color: !!tty, width }) : '';
    const frame = `${head}\n\n${body}\n\n\x1b[2m q quit · aistatus dismiss <id>\x1b[0m`;
    if (tty) out.write('\x1b[H\x1b[2J' + frame);
    else out.write(frame + '\n');
  };

  const connect = () => {
    status = 'connecting…';
    req = http.get({ host, port, path: '/events', headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        status = `HTTP ${res.statusCode}`;
        res.resume();
        return setTimeout(connect, 2000);
      }
      status = `live ${host}:${port}`;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            snapshot = JSON.parse(data);
            skew = snapshot.serverTime - Date.now();
            draw();
          } catch {
            /* ignore */
          }
        }
      });
      res.on('end', () => {
        status = 'disconnected, retrying…';
        draw();
        setTimeout(connect, 2000);
      });
    });
    req.on('error', (e) => {
      status = `daemon not reachable (${e.code || e.message}) — run: aistatus daemon`;
      draw();
      setTimeout(connect, 2000);
    });
  };

  const cleanup = () => {
    if (tty) out.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  if (tty) {
    out.write('\x1b[?1049h\x1b[?25l');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (d) => {
        const k = d.toString();
        if (k === 'q' || k === '\x03' || k === '\x1b') cleanup();
      });
    }
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  connect();
  setInterval(draw, 1000); // timers tick locally
  draw();
}

/** Non-internal, non-link-local IPv4 addresses of this Mac. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

function bonjourHostName() {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim() + '.local';
  } catch {
    return null;
  }
}

function tokenCommand(flags) {
  const p = getPaths();
  if (flags.new) {
    const key = flags['hooks-only'] ? 'hookToken' : 'token';
    const token = generateToken();
    const patch = { [key]: token };
    const dropHook = !!flags.shared && key === 'token';
    if (dropHook) patch.hookToken = undefined;
    updateUserConfig(patch, p);
    console.log(token);
    console.error(`saved as "${key}" in ${p.configFile} (mode 600)${dropHook ? ' and removed "hookToken"' : ''}. Restart the daemon to apply it.`);
    if (key === 'token') {
      const cfg = loadConfig(p);
      console.error('note: "token" is what the watch must send (Settings > Token, or build it in: watch/scripts/generate.sh --token ...).');
      console.error(cfg.hookToken ? '      Remote hooks keep using "hookToken".' : '      It is also the token for remote hooks (no "hookToken" is set).');
      console.error('      `aistatus token --new --hooks-only` creates a separate token for remote hooks only.');
    }
    return;
  }
  const cfg = loadConfig(p);
  if (flags.read) {
    if (!cfg.token) {
      console.error('no "token" configured: reads are open on the LAN port and the public listener refuses all reads. Create one with: aistatus token --new');
      process.exitCode = 1;
      return;
    }
    console.log(cfg.token);
    return;
  }
  const t = hookTokenOf(cfg);
  if (!t) {
    console.error('no token configured; remote hooks are disabled. Create one with: aistatus token --new [--hooks-only]');
    process.exitCode = 1;
    return;
  }
  console.log(t);
}

/** Validate a public base URL: http(s), no credentials, query, fragment or path. Returns its origin or throws. */
export function normalizePublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the public URL must start with https:// (or http://)');
  if (u.username || u.password) throw new Error('the public URL must not contain credentials');
  if (u.search || u.hash) throw new Error('the public URL must not contain a query or fragment');
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('the public URL must not contain a path (the daemon is served at the root)');
  return u.origin;
}

function publicUrlCommand(_, flags) {
  const p = getPaths();
  if (flags.clear) {
    updateUserConfig({ publicUrl: undefined }, p);
    console.log(`removed "publicUrl" from ${p.configFile}`);
    return;
  }
  if (_[1]) {
    let url;
    try {
      url = normalizePublicUrl(_[1]);
    } catch (e) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    updateUserConfig({ publicUrl: url }, p);
    console.log(url);
    console.error(`saved as "publicUrl" in ${p.configFile} (only the CLI uses it; no daemon restart needed).`);
    if (url.startsWith('http:')) console.error('warning: plain http would send tokens unencrypted over the internet; use the https URL of the tunnel.');
    return;
  }
  const cfg = loadConfig(p);
  if (!cfg.publicUrl) {
    console.error('no "publicUrl" configured. Set it with: aistatus public-url https://<your-mac>.<tailnet>.ts.net');
    process.exitCode = 1;
    return;
  }
  console.log(cfg.publicUrl);
}

async function probe(url, { token, timeoutMs = 5000 } = {}) {
  try {
    const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body, text };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.cause?.message || e.message };
  }
}

async function publicStatus({ cfg, port, flags }) {
  const { publicListenerPlan, MIN_PUBLIC_TOKEN_LENGTH } = await import('./server.js');
  const plan = publicListenerPlan(cfg);
  const show = !!flags.show;
  const lines = [];
  let up = false;
  const weak = (t) => (t && t.length < MIN_PUBLIC_TOKEN_LENGTH ? ` (too short for the public listener: < ${MIN_PUBLIC_TOKEN_LENGTH})` : '');
  const desc = (t) => (t ? `set (${t.length} characters)${weak(t)}${show ? `  ${t}` : ''}` : 'not set');
  lines.push('aistatus public listener (for Tailscale Funnel or another tunnel)');
  lines.push('');
  lines.push(`  publicPort:   ${plan.port ?? 'disabled'}${plan.port ? ' (bound to 127.0.0.1 only)' : ''}`);
  lines.push(`  publicUrl:    ${cfg.publicUrl || '(not set) -> aistatus public-url https://<your-mac>.<tailnet>.ts.net'}`);
  lines.push(`  read token:   ${desc(cfg.token)}   ("token": watch reads + dismiss)`);
  if (cfg.hookToken) lines.push(`  hook token:   ${desc(cfg.hookToken)}   ("hookToken": remote hooks)`);
  else lines.push(`  hook token:   ${cfg.token ? 'uses "token" (no separate "hookToken")' : 'not set'}`);
  if (!plan.enabled) lines.push(`  config:       the public listener will NOT start: ${plan.reason}`);

  let daemon;
  try {
    const r = await request('GET', { host: '127.0.0.1', port, path: '/health' });
    const pub = r.body?.public;
    if (!pub) daemon = 'running an older version without the public listener -> restart the daemon';
    else if (pub.listening) {
      up = true;
      daemon = `running; public listener up on 127.0.0.1:${pub.port}`;
      if (plan.port && pub.port !== plan.port) daemon += ` (config says ${plan.port} -> restart the daemon)`;
    } else daemon = plan.enabled ? 'running WITHOUT the public listener -> restart the daemon (check its log if that does not help)' : 'running; public listener off';
  } catch (e) {
    daemon = `not reachable on 127.0.0.1:${port} (${e.code || e.message}) -> start it: aistatus daemon`;
  }
  lines.push(`  daemon:       ${daemon}`);

  if (plan.port) {
    const r = await probe(`http://127.0.0.1:${plan.port}/health`, { timeoutMs: 2000 });
    lines.push(`  local probe:  http://127.0.0.1:${plan.port}/health -> ${r.error ? `not answering (${r.error})` : `HTTP ${r.status} ${r.text.slice(0, 40)}`}`);
  }
  if (cfg.publicUrl && !flags['no-probe']) {
    const base = cfg.publicUrl.replace(/\/+$/, '');
    const anon = await probe(`${base}/health`);
    if (anon.error) lines.push(`  public probe: ${base}/health -> failed (${anon.error}); is \`tailscale funnel --bg ${plan.port ?? 7779}\` running?`);
    else {
      lines.push(`  public probe: ${base}/health -> HTTP ${anon.status} ${anon.text.slice(0, 40)}`);
      // The token is only ever sent over https (never in clear text over the internet).
      if (cfg.token && base.startsWith('https:')) {
        const auth = await probe(`${base}/health`, { token: cfg.token });
        lines.push(`  with token:   ${auth.error ? `failed (${auth.error})` : auth.body?.name === 'aistatusd' ? 'OK, the read token is accepted' : `HTTP ${auth.status}, token not accepted (daemon restarted since the token changed?)`}`);
      }
    }
  }
  lines.push('');
  lines.push('To go live:');
  lines.push('  1. tokens:   aistatus token --new   (optional: aistatus token --new --hooks-only), then restart the daemon');
  lines.push(`  2. tunnel:   tailscale funnel --bg ${plan.port ?? 7779}   (you run this; aistatus never touches Tailscale)`);
  lines.push('  3. URL:      aistatus public-url https://<your-mac>.<tailnet>.ts.net');
  lines.push(`  4. watch:    watch/scripts/generate.sh --host ${cfg.publicUrl || 'https://<your-mac>.<tailnet>.ts.net'} --token "$(aistatus token --read)", then rebuild`);
  lines.push('  5. Windows:  aistatus remote-setup   (prints the install command with -BaseUrl)');
  if (!show && (cfg.token || cfg.hookToken)) lines.push('Tokens are hidden; add --show to print them.');
  console.log(lines.join('\n'));
  if (!up) process.exitCode = 1;
}

export function windowsInstallCommands({ host, port, token, machine, baseUrl }) {
  const tok = token || '<TOKEN>';
  const m = machine ? ` -Machine '${machine}'` : '';
  const b = baseUrl ? ` -BaseUrl '${baseUrl}'` : '';
  const url = `http://${host}:${port}/setup/install-windows.ps1`;
  return {
    // Fetches the scripts from the Mac's LAN port: only works on the same network.
    oneLine: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('${url}'))) -MacHost ${host} -Port ${port}${b} -Token '${tok}'${m}"`,
    fromFiles: baseUrl
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-windows.ps1${b} -Token '${tok}'${m}`
      : `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-windows.ps1 -MacHost ${host} -Port ${port} -Token '${tok}'${m}`,
  };
}

async function remoteSetup({ cfg, port, flags = {} }) {
  const token = hookTokenOf(cfg);
  let publicUrl = cfg.publicUrl || null;
  try {
    if (flags['public-url']) publicUrl = normalizePublicUrl(flags['public-url']);
    else if (publicUrl) publicUrl = normalizePublicUrl(publicUrl);
  } catch (e) {
    console.error(`public URL: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const ips = lanAddresses();
  const host = ips[0]?.address || '<MAC-IP>';
  const lines = [];
  lines.push('aistatus remote setup: let another computer (e.g. a Windows PC running Codex) report to this Mac');
  lines.push('');
  lines.push(`  This Mac:      ${localMachineName(cfg)}`);
  lines.push(`  Mac LAN IPs:   ${ips.length ? ips.map((a) => `${a.address} (${a.iface})`).join(', ') : '(none found; connect to the network first)'}`);
  const bj = bonjourHostName();
  if (bj) lines.push(`  Bonjour name:  ${bj}  (Windows may not resolve .local names; prefer the IP)`);
  lines.push(`  Port:          ${port}`);
  if (publicUrl) lines.push(`  Public URL:    ${publicUrl}  (tunnel -> public listener on 127.0.0.1:${cfg.publicPort || '(disabled)'}; check: aistatus public-status)`);
  lines.push(`  Token:         ${token || '(none) -> run: aistatus token --new --hooks-only   then restart the daemon'}`);
  let daemonState;
  try {
    const r = await request('GET', { host: '127.0.0.1', port, path: '/health' });
    if (r.body?.remoteHooks === true) daemonState = 'running, remote hooks enabled';
    else if (r.body?.remoteHooks === false) daemonState = token ? 'running WITHOUT remote hooks -> restart the daemon to load the token' : 'running, remote hooks disabled (no token)';
    else daemonState = 'running an older version without remote hooks -> restart the daemon';
    if (publicUrl && !r.body?.public?.listening) daemonState += '; public listener NOT running -> see aistatus public-status';
  } catch {
    daemonState = 'not reachable on this port -> start it: aistatus daemon';
  }
  lines.push(`  Daemon:        ${daemonState}`);
  const cmds = windowsInstallCommands({ host, port, token, baseUrl: publicUrl });
  lines.push('');
  if (publicUrl) {
    lines.push(`On the Windows PC, in PowerShell or cmd (hooks go to ${publicUrl}, which works from any network):`);
    lines.push('  with a copy of hooks\\aistatus-hook.ps1 and scripts\\install-windows.ps1 from this repo (keep the folder layout):');
    lines.push(`    ${cmds.fromFiles}`);
    lines.push('  or, while the PC is on the same network as this Mac, the one-line install (it fetches the scripts');
    lines.push('  from the LAN port; the public URL never serves them):');
    lines.push(`    ${cmds.oneLine}`);
    lines.push('  back to the LAN address later: re-run with -MacHost <ip> and without -BaseUrl.');
  } else {
    lines.push('On the Windows PC (same network), in PowerShell or cmd:');
    lines.push('  one-line install (fetches the scripts from this Mac\'s daemon):');
    lines.push(`    ${cmds.oneLine}`);
    lines.push('  or copy hooks\\aistatus-hook.ps1 and scripts\\install-windows.ps1 from this repo (keep the folder layout) and run:');
    lines.push(`    ${cmds.fromFiles}`);
  }
  lines.push('  optional: -Machine <name> (default: the PC\'s computer name); uninstall: -Uninstall');
  lines.push('  then trust the new hooks once in Codex (/hooks, or the hooks review prompt in the desktop app).');
  lines.push('  Re-running the installer where the hooks are already installed keeps the same hook entries: no new trust prompt.');
  lines.push('');
  if (publicUrl) lines.push(`On this Mac: the tunnel must point at the public listener (you run it): tailscale funnel --bg ${cfg.publicPort || 7779}`);
  else lines.push('On this Mac: if the macOS firewall is on, allow incoming connections for node.');
  console.log(lines.join('\n'));
  if (!token) process.exitCode = 1;
}

// ------------------------------------------------------- viewer in cloud mode

function needReadToken(cloud) {
  if (cloud.readToken) return true;
  console.error('cloud mode: no read token saved. Run: aistatus cloud setup --url … --hook-token … --read-token …  (or add --local)');
  process.exitCode = 1;
  return false;
}

function cloudFailed(cloud, r) {
  console.error(`cloud hub ${cloud.url}: ${r.error || `HTTP ${r.status} ${r.json?.error || ''}`.trim()}  (check: aistatus cloud status; local daemon: --local)`);
  process.exitCode = 1;
}

/** Live view against the cloud hub: polls GET /sessions (no event stream there). */
async function liveCloud(cloud, intervalSec) {
  const out = process.stdout;
  const tty = out.isTTY;
  let snapshot = null;
  let skew = 0;
  let status = 'connecting…';
  const draw = () => {
    const now = Date.now() + skew;
    const n = snapshot?.sessions?.length ?? 0;
    const head = `aistatus · ${n} card${n === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()} · ${status}`;
    const body = snapshot ? renderCards(snapshot, { now, color: !!tty, width: out.columns || 80 }) : '';
    const frame = `${head}\n\n${body}\n\n\x1b[2m q quit · aistatus dismiss <id>\x1b[0m`;
    if (tty) out.write('\x1b[H\x1b[2J' + frame);
    else out.write(frame + '\n');
  };
  const poll = async () => {
    const r = await cloudFetch(cloud, 'GET', '/sessions', { token: cloud.readToken });
    if (r.status === 200 && r.json?.sessions) {
      snapshot = r.json;
      skew = snapshot.serverTime - Date.now();
      status = `cloud, every ${intervalSec}s`;
    } else status = `cloud: ${r.error || `HTTP ${r.status}`}`;
    draw();
  };
  const cleanup = () => {
    if (tty) out.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  if (tty) {
    out.write('\x1b[?1049h\x1b[?25l');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (d) => {
        const k = d.toString();
        if (k === 'q' || k === '\x03' || k === '\x1b') cleanup();
      });
    }
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await poll();
  setInterval(poll, intervalSec * 1000);
  setInterval(draw, 1000);
}

async function cloudViewer(cmd, cloud, _, flags) {
  if (!needReadToken(cloud)) return;
  const token = cloud.readToken;
  switch (cmd) {
    case 'watch': {
      const sec = Math.max(2, Number(flags.interval) || 5);
      return liveCloud(cloud, sec);
    }
    case 'list': {
      const r = await cloudFetch(cloud, 'GET', '/sessions', { token });
      if (r.status !== 200 || !r.json?.sessions) return cloudFailed(cloud, r);
      if (flags.json) console.log(JSON.stringify(r.json, null, 2));
      else {
        const skew = r.json.serverTime - Date.now();
        console.log(renderCards(r.json, { now: Date.now() + skew, color: !!process.stdout.isTTY, width: process.stdout.columns || 100 }));
      }
      return;
    }
    case 'dismiss': {
      const id = _[1];
      if (!id) {
        console.error('usage: aistatus dismiss <id>');
        process.exitCode = 2;
        return;
      }
      const r = await cloudFetch(cloud, 'POST', `/sessions/${encodeURIComponent(id)}/dismiss`, { token, body: {} });
      if (r.status === 200) console.log(`dismissed ${r.json.dismissed.id}${r.json.dismissed.project ? ` (${r.json.dismissed.project})` : ''}`);
      else if (r.status === 404) {
        console.error(`dismiss failed: ${r.json?.error || 'not found'}`);
        process.exitCode = 1;
      } else cloudFailed(cloud, r);
      return;
    }
    case 'health': {
      const r = await cloudFetch(cloud, 'GET', '/health', { token });
      if (r.status !== 200) return cloudFailed(cloud, r);
      console.log(JSON.stringify(r.json, null, 2));
      return;
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(argv);
  const cfg = loadConfig(getPaths());
  const port = Number(flags.port || cfg.port);
  const host = flags.host || '127.0.0.1';
  const cmd = _[0] || 'watch';
  if (flags.help || flags.h) return process.stdout.write(USAGE);
  if (['watch', 'list', 'dismiss', 'health'].includes(cmd) && !flags.local && !flags.host) {
    const cloud = cloudActive();
    if (cloud) return cloudViewer(cmd, cloud, _, flags);
  }

  switch (cmd) {
    case 'watch':
      return live({ host, port });

    case 'list': {
      try {
        const r = await request('GET', { host, port, path: '/sessions' });
        if (flags.json) console.log(JSON.stringify(r.body, null, 2));
        else {
          const skew = r.body.serverTime - Date.now();
          console.log(renderCards(r.body, { now: Date.now() + skew, color: !!process.stdout.isTTY, width: process.stdout.columns || 100 }));
        }
      } catch (e) {
        notRunning(host, port, e);
      }
      return;
    }

    case 'dismiss': {
      const id = _[1];
      if (!id) {
        console.error('usage: aistatus dismiss <id>');
        process.exitCode = 2;
        return;
      }
      try {
        const r = await request('POST', { host, port, path: `/sessions/${encodeURIComponent(id)}/dismiss` });
        if (r.status === 200) console.log(`dismissed ${r.body.dismissed.id} (${r.body.dismissed.project})`);
        else {
          console.error(`dismiss failed: ${r.body?.error || r.status}`);
          process.exitCode = 1;
        }
      } catch (e) {
        notRunning(host, port, e);
      }
      return;
    }

    case 'health': {
      try {
        const r = await request('GET', { host, port, path: '/health' });
        console.log(JSON.stringify(r.body, null, 2));
      } catch (e) {
        notRunning(host, port, e);
      }
      return;
    }

    case 'daemon': {
      const { runDaemon } = await import('./daemon.js');
      const opts = {};
      if (flags.port) opts.port = port;
      if (flags['no-bonjour']) opts.bonjour = false;
      await runDaemon(opts);
      return;
    }

    case 'install-hooks': {
      const { script, results } = installHooks({ targets: targetsFrom(flags), port: flags.port ? port : undefined, force: !!flags.force });
      console.log(`hook script: ${script}`);
      for (const r of results) {
        if (r.skipped) console.log(`${r.target}: skipped (${r.skipped})`);
        else if (!r.changed) console.log(`${r.target}: already installed in ${r.file}`);
        else console.log(`${r.target}: installed into ${r.file}${r.backup ? `\n  backup: ${r.backup}` : ''}`);
      }
      if (results.some((r) => r.target === 'codex' && r.changed)) {
        console.log('codex: new hooks must be trusted once before Codex runs them (Codex CLI: /hooks; desktop app: hooks review prompt).');
      }
      return;
    }

    case 'uninstall-hooks': {
      const { results } = uninstallHooks({ targets: targetsFrom(flags) });
      for (const r of results) {
        if (!r.changed) console.log(`${r.target}: nothing to remove in ${r.file}`);
        else console.log(`${r.target}: removed aistatus hooks from ${r.file}\n  backup: ${r.backup}`);
      }
      return;
    }

    case 'install-daemon': {
      const { file, xml } = installDaemonPlist({ dryRun: !!flags.print });
      if (flags.print) {
        process.stdout.write(xml);
        return;
      }
      console.log(`wrote ${file} (not loaded). To start it now:\n  launchctl bootstrap gui/$(id -u) ${file}\nTo stop/remove:\n  launchctl bootout gui/$(id -u)/com.aistatus.daemon && rm ${file}`);
      return;
    }

    case 'token':
      return tokenCommand(flags);

    case 'remote-setup':
      return remoteSetup({ cfg, port, flags });

    case 'public-url':
      return publicUrlCommand(_, flags);

    case 'public-status':
      return publicStatus({ cfg, port, flags });

    case 'cloud':
      return cloudCommand(_, flags);

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;

    default:
      console.error(`unknown command: ${cmd}\n`);
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
}
