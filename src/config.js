// Paths and configuration. Everything is derived from $HOME at call time so
// tests (and the installers) can be pointed at a scratch HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeMachine } from './core.js';

export { sanitizeMachine };

export const VERSION = '0.1.0';

export const DEFAULT_CONFIG = Object.freeze({
  port: 7778,
  host: '0.0.0.0',
  // Run duration below this => done card may be swiped away; otherwise needs confirm.
  swipeThresholdSec: 60,
  bonjour: true,
  // Optional shared secret. When set, non-loopback clients (the watch) must send
  // `Authorization: Bearer <token>` or `?token=<token>`. Loopback is always allowed.
  // It also enables hook ingestion from other computers (see hookToken).
  token: null,
  // Optional secret for remote hook senders only (e.g. a Windows PC running Codex).
  // Remote `POST /hook/:tool` needs `Authorization: Bearer <hookToken || token>`;
  // with neither configured, remote hook POSTs are refused (403).
  hookToken: null,
  // Public listener for a reverse proxy / tunnel (e.g. Tailscale Funnel):
  // always bound to 127.0.0.1, started only when a token is configured, and
  // every request there needs a Bearer token (reads: `token`; hooks:
  // `hookToken`, else `token`). Set to false to disable it.
  publicPort: 7779,
  // Public base URL that reaches publicPort, e.g. https://mac.tailnet.ts.net
  // (used by `aistatus remote-setup` / `public-status`; the daemon ignores it).
  publicUrl: null,
  // Display name of this computer on cards (default: hostname without ".local").
  machine: null,
  codex: {
    // "auto": hooks preferred, rollout watcher as fallback; "hooks": hooks only;
    // "watcher": rollout watcher only.
    source: 'auto',
    sessionsDir: null, // default: $HOME/.codex/sessions
    pollMs: 1500,
  },
  // Idle (hidden) sessions with no events for this long are forgotten.
  idlePruneHours: 24,
  // A run whose main turn stopped while sub-agents were still active stays
  // running until they finish; after this many minutes without any event it is
  // marked done anyway (guards against a lost SubagentStop).
  subagentTimeoutMin: 30,
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
  if (process.env.AISTATUS_PUBLIC_PORT) cfg.publicPort = process.env.AISTATUS_PUBLIC_PORT === 'off' ? false : Number(process.env.AISTATUS_PUBLIC_PORT);
  if (process.env.AISTATUS_BONJOUR === '0') cfg.bonjour = false;
  if (process.env.AISTATUS_CODEX_SOURCE) cfg.codex = { ...cfg.codex, source: process.env.AISTATUS_CODEX_SOURCE };
  cfg.codex.sessionsDir = cfg.codex.sessionsDir || p.codexSessions;
  return cfg;
}

/** Name of this computer as shown on cards: config.machine, else the hostname without ".local". */
export function localMachineName(cfg = {}) {
  return sanitizeMachine(cfg.machine) || sanitizeMachine(os.hostname().replace(/\.local\.?$/i, '').split('.')[0]) || 'mac';
}

/** Token that remote hook senders must present, or null when remote hooks are disabled. */
export function hookTokenOf(cfg = {}) {
  return cfg.hookToken || cfg.token || null;
}

export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Constant-time string comparison (hashing first so lengths never leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Merge `patch` into the user's raw config.json (not the defaults) and write it
 * atomically with mode 0600 (it may hold a token). Refuses to touch invalid JSON.
 */
export function updateUserConfig(patch, p = paths()) {
  let user = {};
  try {
    const raw = fs.readFileSync(p.configFile, 'utf8');
    if (raw.trim()) user = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${p.configFile} is not valid JSON (${e.message}); refusing to modify it`);
  }
  if (!isObj(user)) throw new Error(`${p.configFile} is not a JSON object; refusing to modify it`);
  const next = { ...user, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  fs.mkdirSync(p.dataDir, { recursive: true });
  const tmp = `${p.configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p.configFile);
  fs.chmodSync(p.configFile, 0o600);
  return next;
}
