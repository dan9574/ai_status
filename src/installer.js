// Hook installers for Claude Code (~/.claude/settings.json) and Codex
// (~/.codex/hooks.json), plus the launchd plist generator.
//
// Guarantees: merge without touching foreign hooks, timestamped backup before
// any write, idempotent install, uninstall removes only our entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as getPaths, loadConfig } from './config.js';

export const HOOK_MARKER = 'aistatus-hook';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SOURCE = path.join(REPO_ROOT, 'hooks', 'aistatus-hook.sh');

// Claude Code events (verified against https://code.claude.com/docs/en/hooks).
// `matcher: undefined` = event does not support matchers.
export const CLAUDE_EVENTS = [
  { event: 'SessionStart', matcher: '*' },
  { event: 'UserPromptSubmit' },
  { event: 'Notification', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'PermissionDenied', matcher: '*' },
  { event: 'Stop' },
  { event: 'StopFailure', matcher: '*' },
  { event: 'SessionEnd', matcher: '*' },
];

// Codex events (verified against the schemas embedded in codex-cli 0.159.0-alpha
// and https://developers.openai.com/codex/hooks). Codex: omitted matcher = all.
export const CODEX_EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PermissionRequest' },
  { event: 'PostToolUse' },
  { event: 'Stop' },
  { event: 'Interrupt' },
  { event: 'SessionEnd' },
];

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(scriptPath, tool, port) {
  return `${shellQuote(scriptPath)} ${tool} ${port}`;
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER);

/** Return a copy of settings with every aistatus hook entry removed. */
export function removeOurHooks(settings) {
  const out = structuredClone(settings || {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  let removed = false;
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hooks = g.hooks.filter((h) => !isOurs(h));
      if (hooks.length !== g.hooks.length) removed = true;
      if (hooks.length === g.hooks.length) kept.push(g);
      else if (hooks.length > 0) kept.push({ ...g, hooks });
    }
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (removed && Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** Return a copy of settings with our hook entries (re)added. */
export function addOurHooks(settings, events, command, timeout) {
  const out = removeOurHooks(settings);
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const { event, matcher } of events) {
    const group = {};
    if (matcher !== undefined) group.matcher = matcher;
    group.hooks = [{ type: 'command', command, timeout }];
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    out.hooks[event].push(group);
  }
  return out;
}

/** Canonical list of our entries, for idempotency comparison. */
export function ourEntries(settings) {
  const list = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g?.hooks || []) {
        if (isOurs(h)) list.push(JSON.stringify([event, g.matcher ?? null, h.type, h.command, h.timeout ?? null]));
      }
    }
  }
  return list.sort();
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, data: {} };
    throw e;
  }
  if (!raw.trim()) return { exists: true, data: {} };
  try {
    return { exists: true, data: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); refusing to modify it`);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup(file, label, p) {
  fs.mkdirSync(p.backupDir, { recursive: true });
  const dest = path.join(p.backupDir, `${label}.${timestamp()}.json`);
  fs.copyFileSync(file, dest);
  return dest;
}

function writeJson(file, data) {
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.aistatus-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function applyChange({ file, label, transform, p }) {
  const { exists, data } = readJson(file);
  const next = transform(data);
  const before = ourEntries(data);
  const after = ourEntries(next);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (unchanged) return { file, changed: false, backup: null };
  const bak = exists ? backup(file, label, p) : null;
  writeJson(file, next);
  return { file, changed: true, backup: bak };
}

/** Copy the hook forwarder script to ~/.aistatus/bin/aistatus-hook. */
export function installHookScript(p = getPaths()) {
  fs.mkdirSync(p.binDir, { recursive: true });
  const src = fs.readFileSync(HOOK_SOURCE);
  let same = false;
  try {
    same = fs.readFileSync(p.hookScript).equals(src);
  } catch {
    /* missing */
  }
  if (!same) fs.writeFileSync(p.hookScript, src);
  fs.chmodSync(p.hookScript, 0o755);
  return p.hookScript;
}

/**
 * Install hooks. targets: subset of ['claude','codex'].
 * Codex is skipped (not an error) when ~/.codex does not exist, unless forced.
 */
export function installHooks({ targets = ['claude', 'codex'], port, force = false } = {}) {
  const p = getPaths();
  const cfg = loadConfig(p);
  port = port || cfg.port;
  const script = installHookScript(p);
  const results = [];
  for (const t of targets) {
    if (t === 'claude') {
      const cmd = hookCommand(script, 'claude', port);
      results.push({
        target: 'claude',
        ...applyChange({ file: p.claudeSettings, label: 'claude-settings', p, transform: (d) => addOurHooks(d, CLAUDE_EVENTS, cmd, 5) }),
      });
    } else if (t === 'codex') {
      if (!fs.existsSync(p.codexDir) && !force) {
        results.push({ target: 'codex', skipped: `${p.codexDir} not found` });
        continue;
      }
      const cmd = hookCommand(script, 'codex', port);
      results.push({
        target: 'codex',
        ...applyChange({ file: p.codexHooks, label: 'codex-hooks', p, transform: (d) => addOurHooks(d, CODEX_EVENTS, cmd, 3) }),
      });
    }
  }
  return { script, results };
}

export function uninstallHooks({ targets = ['claude', 'codex'] } = {}) {
  const p = getPaths();
  const results = [];
  for (const t of targets) {
    const file = t === 'claude' ? p.claudeSettings : p.codexHooks;
    if (!fs.existsSync(file)) {
      results.push({ target: t, file, changed: false, backup: null });
      continue;
    }
    results.push({
      target: t,
      ...applyChange({ file, label: t === 'claude' ? 'claude-settings' : 'codex-hooks', p, transform: removeOurHooks }),
    });
  }
  return { results };
}

// ---------------------------------------------------------------- launchd

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist({ nodePath = process.execPath, daemonScript = path.join(REPO_ROOT, 'bin', 'aistatusd.js'), p = getPaths() } = {}) {
  const arr = (xs) => xs.map((x) => `    <string>${xmlEscape(x)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aistatus.daemon</string>
  <key>ProgramArguments</key>
  <array>
${arr([nodePath, daemonScript])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(p.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(p.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(p.logFile)}</string>
</dict>
</plist>
`;
}

/** Write (but never load) the LaunchAgent plist. */
export function installDaemonPlist({ dryRun = false } = {}) {
  const p = getPaths();
  const xml = launchdPlist({ p });
  if (!dryRun) {
    fs.mkdirSync(path.dirname(p.launchAgent), { recursive: true });
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.writeFileSync(p.launchAgent, xml);
  }
  return { file: p.launchAgent, xml };
}
