// Paths and configuration. Everything is derived from $HOME at call time so
// tests (and the installers) can be pointed at a scratch HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const DEFAULT_CONFIG = Object.freeze({
  port: 7778,
  host: '0.0.0.0',
  // Run duration below this => done card may be swiped away; otherwise needs confirm.
  swipeThresholdSec: 60,
  bonjour: true,
  // Optional shared secret. When set, non-loopback clients (the watch) must send
  // `Authorization: Bearer <token>` or `?token=<token>`. Loopback is always allowed.
  token: null,
  codex: {
    // "auto": hooks preferred, rollout watcher as fallback; "hooks": hooks only;
    // "watcher": rollout watcher only.
    source: 'auto',
    sessionsDir: null, // default: $HOME/.codex/sessions
    pollMs: 1500,
  },
  // Idle (hidden) sessions with no events for this long are forgotten.
  idlePruneHours: 24,
});

export function homeDir() {
  return process.env.HOME || os.homedir();
}

export function paths(home = homeDir()) {
  const dataDir = process.env.AISTATUS_DIR || path.join(home, '.aistatus');
  return {
    home,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    stateFile: path.join(dataDir, 'state.json'),
    backupDir: path.join(dataDir, 'backups'),
    binDir: path.join(dataDir, 'bin'),
    hookScript: path.join(dataDir, 'bin', 'aistatus-hook'),
    logFile: path.join(dataDir, 'daemon.log'),
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    codexDir: path.join(home, '.codex'),
    codexHooks: path.join(home, '.codex', 'hooks.json'),
    codexSessions: path.join(home, '.codex', 'sessions'),
    launchAgent: path.join(home, 'Library', 'LaunchAgents', 'com.aistatus.daemon.plist'),
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** Load ~/.aistatus/config.json merged over defaults, then env overrides. */
export function loadConfig(p = paths()) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[aistatus] ignoring bad config ${p.configFile}: ${e.message}`);
  }
  const cfg = merge(DEFAULT_CONFIG, user);
  if (process.env.AISTATUS_PORT) cfg.port = Number(process.env.AISTATUS_PORT);
  if (process.env.AISTATUS_HOST) cfg.host = process.env.AISTATUS_HOST;
  if (process.env.AISTATUS_BONJOUR === '0') cfg.bonjour = false;
  if (process.env.AISTATUS_CODEX_SOURCE) cfg.codex = { ...cfg.codex, source: process.env.AISTATUS_CODEX_SOURCE };
  cfg.codex.sessionsDir = cfg.codex.sessionsDir || p.codexSessions;
  return cfg;
}
