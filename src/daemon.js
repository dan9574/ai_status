// aistatusd: wires together store, persistence, HTTP API, Bonjour and the Codex watcher.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths as getPaths, localMachineName } from './config.js';
import { SessionStore } from './store.js';
import { createServer, createPublicServer, publicListenerPlan } from './server.js';
import { advertise } from './bonjour.js';
import { CodexWatcher } from './codex-watcher.js';

export function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[aistatusd] cannot read ${file}: ${e.message}`);
    return null;
  }
}

export function saveStateSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Start the daemon. Resolves to { server, store, port, publicServer, publicPort, stop() }.
 * opts may override config fields (port, host, bonjour, codex...).
 */
export async function startDaemon(opts = {}) {
  const p = getPaths();
  const config = { ...loadConfig(p), ...opts };
  const log = opts.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));

  const machine = localMachineName(config);
  const store = new SessionStore({
    swipeThresholdSec: config.swipeThresholdSec,
    machine,
    subagentTimeoutMs: Math.max(1, Number(config.subagentTimeoutMin) || 30) * 60_000,
  });
  store.load(loadState(p.stateFile));

  let saveTimer = null;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      saveStateSync(p.stateFile, store.toJSON());
    } catch (e) {
      log(`persist failed: ${e.message}`);
    }
  };
  store.on('change', () => {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 200);
  });

  // Public listener (for a tunnel such as Tailscale Funnel): 127.0.0.1 only,
  // token required on every route. Not started without a token.
  const plan = publicListenerPlan(config);
  let publicServer = null;
  let publicPort = null;
  const publicStatus = () => ({ public: { listening: !!publicServer, port: publicPort, read: plan.read, hook: plan.hook } });

  const server = createServer({ store, config, log, status: publicStatus });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  log(`aistatusd listening on http://${config.host}:${port} as "${machine}" (state: ${p.stateFile})`);
  const remoteHooks = config.hookToken || config.token;
  log(remoteHooks ? 'remote hooks: enabled (Bearer token required)' : 'remote hooks: disabled (no token configured)');

  if (plan.enabled) {
    const srv = createPublicServer({ store, config, log, limits: opts.publicLimits });
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(plan.port, '127.0.0.1', resolve);
      });
      publicServer = srv;
      publicPort = srv.address().port;
      log(`public listener on http://127.0.0.1:${publicPort} (token required on every route; reads: ${plan.read ? 'on' : 'off, no "token"'}, hooks: ${plan.hook ? 'on' : 'off'})`);
    } catch (e) {
      await srv.closeAll();
      log(`public listener NOT started: cannot listen on 127.0.0.1:${plan.port} (${e.code || e.message})`);
    }
  } else {
    log(`public listener not started: ${plan.reason}`);
  }

  const bonjour = config.bonjour ? advertise({ port, log }) : null;

  let watcher = null;
  const source = config.codex?.source || 'auto';
  if (source === 'auto' || source === 'watcher') {
    watcher = new CodexWatcher({ store, dir: config.codex.sessionsDir, pollMs: config.codex.pollMs, log }).start();
  }

  const pruneTimer = setInterval(() => store.prune(config.idlePruneHours * 3600_000), 10 * 60_000);
  pruneTimer.unref();
  store.prune(config.idlePruneHours * 3600_000);
  const subagentTimer = setInterval(() => store.expireSubagents(), 60_000);
  subagentTimer.unref();
  store.expireSubagents();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pruneTimer);
    clearInterval(subagentTimer);
    watcher?.stop();
    bonjour?.stop();
    await server.closeAll();
    await publicServer?.closeAll();
    saveNow();
    log('aistatusd stopped');
  };

  return { server, store, port, config, machine, stop, publicServer, publicPort };
}

/** Run in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(opts = {}) {
  const d = await startDaemon(opts);
  const shutdown = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return d;
}
