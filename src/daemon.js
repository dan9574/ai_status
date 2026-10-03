// aistatusd: wires together store, persistence, HTTP API, Bonjour and the Codex watcher.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths as getPaths } from './config.js';
import { SessionStore } from './store.js';
import { createServer } from './server.js';
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
 * Start the daemon. Resolves to { server, store, port, stop() }.
 * opts may override config fields (port, host, bonjour, codex...).
 */
export async function startDaemon(opts = {}) {
  const p = getPaths();
  const config = { ...loadConfig(p), ...opts };
  const log = opts.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));

  const store = new SessionStore({ swipeThresholdSec: config.swipeThresholdSec });
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

  const server = createServer({ store, config, log });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  log(`aistatusd listening on http://${config.host}:${port} (state: ${p.stateFile})`);

  const bonjour = config.bonjour ? advertise({ port, log }) : null;

  let watcher = null;
  const source = config.codex?.source || 'auto';
  if (source === 'auto' || source === 'watcher') {
    watcher = new CodexWatcher({ store, dir: config.codex.sessionsDir, pollMs: config.codex.pollMs, log }).start();
  }

  const pruneTimer = setInterval(() => store.prune(config.idlePruneHours * 3600_000), 10 * 60_000);
  pruneTimer.unref();
  store.prune(config.idlePruneHours * 3600_000);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pruneTimer);
    watcher?.stop();
    bonjour?.stop();
    await server.closeAll();
    saveNow();
    log('aistatusd stopped');
  };

  return { server, store, port, config, stop };
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
