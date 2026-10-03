// `aistatus` command line.
import http from 'node:http';
import { loadConfig, paths as getPaths } from './config.js';
import { renderCards } from './render.js';
import { installHooks, uninstallHooks, installDaemonPlist } from './installer.js';

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

Options:
  --port N    daemon port (default from ~/.aistatus/config.json, else 7778)
  --host H    daemon host for viewer commands (default 127.0.0.1)
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args.flags[k] = v;
      else if (['port', 'host'].includes(k)) args.flags[k] = argv[++i];
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

export async function main(argv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(argv);
  const cfg = loadConfig(getPaths());
  const port = Number(flags.port || cfg.port);
  const host = flags.host || '127.0.0.1';
  const cmd = _[0] || 'watch';
  if (flags.help || flags.h) return process.stdout.write(USAGE);

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
