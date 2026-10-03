// Installers are exercised against a scratch HOME only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-home-'));
process.env.HOME = HOME;
delete process.env.AISTATUS_DIR;
const { installHooks, uninstallHooks, installDaemonPlist, CLAUDE_EVENTS, CODEX_EVENTS, HOOK_MARKER } = await import('../src/installer.js');

const claudeFile = path.join(HOME, '.claude', 'settings.json');
const codexFile = path.join(HOME, '.codex', 'hooks.json');
const backups = () => (fs.existsSync(path.join(HOME, '.aistatus', 'backups')) ? fs.readdirSync(path.join(HOME, '.aistatus', 'backups')) : []);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const EXISTING = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh', timeout: 10 }] }],
  },
};

before(() => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify(EXISTING, null, 2));
  fs.chmodSync(claudeFile, 0o600);
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
});

test('install merges into existing Claude settings without clobbering, with backup', () => {
  const { script, results } = installHooks({ targets: ['claude'] });
  assert.ok(fs.statSync(script).mode & 0o111, 'hook script is executable');
  assert.equal(results[0].changed, true);
  assert.ok(results[0].backup && fs.existsSync(results[0].backup));
  assert.deepEqual(read(results[0].backup), EXISTING, 'backup is the original file');

  const s = read(claudeFile);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, EXISTING.permissions);
  // foreign hooks preserved, ours appended
  assert.deepEqual(s.hooks.Stop[0], EXISTING.hooks.Stop[0]);
  assert.deepEqual(s.hooks.PreToolUse[0], EXISTING.hooks.PreToolUse[0]);
  for (const { event, matcher } of CLAUDE_EVENTS) {
    const ours = s.hooks[event].filter((g) => g.hooks.some((h) => h.command.includes(HOOK_MARKER)));
    assert.equal(ours.length, 1, `exactly one aistatus group for ${event}`);
    assert.equal(ours[0].matcher, matcher);
    assert.match(ours[0].hooks[0].command, /aistatus-hook' claude 7778$/);
    assert.equal(ours[0].hooks[0].timeout, 5);
  }
  assert.equal(fs.statSync(claudeFile).mode & 0o777, 0o600, 'file mode preserved');
});

test('install is idempotent (no rewrite, no new backup)', () => {
  const before = fs.readFileSync(claudeFile, 'utf8');
  const nBackups = backups().length;
  const { results } = installHooks({ targets: ['claude'] });
  assert.equal(results[0].changed, false);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), before);
  assert.equal(backups().length, nBackups);
});

test('reinstall with a different port replaces our entries instead of duplicating', () => {
  const { results } = installHooks({ targets: ['claude'], port: 7999 });
  assert.equal(results[0].changed, true);
  const s = read(claudeFile);
  const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command).filter((c) => c.includes(HOOK_MARKER));
  assert.equal(cmds.length, CLAUDE_EVENTS.length);
  assert.ok(cmds.every((c) => c.endsWith('claude 7999')));
  installHooks({ targets: ['claude'], port: 7778 });
});

test('user edits made after install survive uninstall; uninstall removes only ours', () => {
  const s = read(claudeFile);
  // user adds their own hook to an event we also hook
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo user-hook' }] });
  fs.writeFileSync(claudeFile, JSON.stringify(s, null, 2));

  const { results } = uninstallHooks({ targets: ['claude'] });
  assert.equal(results[0].changed, true);
  assert.ok(fs.existsSync(results[0].backup));
  const after = read(claudeFile);
  assert.deepEqual(after.hooks.Stop, EXISTING.hooks.Stop);
  assert.deepEqual(after.hooks.PreToolUse, EXISTING.hooks.PreToolUse);
  assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }]);
  assert.ok(!JSON.stringify(after).includes(HOOK_MARKER));
  assert.equal(after.model, 'opus');

  // second uninstall is a no-op
  const again = uninstallHooks({ targets: ['claude'] });
  assert.equal(again.results[0].changed, false);
});

test('install then uninstall on a file without hooks restores it exactly', () => {
  const plain = { theme: 'dark' };
  fs.writeFileSync(claudeFile, JSON.stringify(plain, null, 2));
  installHooks({ targets: ['claude'] });
  uninstallHooks({ targets: ['claude'] });
  assert.deepEqual(read(claudeFile), plain);
});

test('missing settings.json is created; invalid JSON is refused untouched', () => {
  fs.rmSync(claudeFile);
  const r = installHooks({ targets: ['claude'] });
  assert.equal(r.results[0].changed, true);
  assert.equal(r.results[0].backup, null);
  assert.ok(read(claudeFile).hooks.Stop);

  fs.writeFileSync(claudeFile, '{ not json');
  assert.throws(() => installHooks({ targets: ['claude'] }), /not valid JSON/);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), '{ not json');
  fs.rmSync(claudeFile);
});

test('codex hooks.json: create, merge, idempotent, uninstall', () => {
  fs.writeFileSync(codexFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  const r1 = installHooks({ targets: ['codex'] });
  assert.equal(r1.results[0].changed, true);
  const s = read(codexFile);
  assert.equal(s.hooks.Stop.length, 2);
  for (const { event } of CODEX_EVENTS) {
    const g = s.hooks[event].find((x) => x.hooks[0].command.includes(HOOK_MARKER));
    assert.ok(g, event);
    assert.equal(g.matcher, undefined);
    assert.match(g.hooks[0].command, /codex 7778$/);
    assert.equal(g.hooks[0].timeout, 3);
  }
  assert.equal(installHooks({ targets: ['codex'] }).results[0].changed, false);
  uninstallHooks({ targets: ['codex'] });
  assert.deepEqual(read(codexFile), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('codex skipped when ~/.codex is absent', async () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-home2-'));
  process.env.HOME = home2;
  try {
    const r = installHooks({ targets: ['codex'] });
    assert.ok(r.results[0].skipped);
    assert.ok(!fs.existsSync(path.join(home2, '.codex')));
  } finally {
    process.env.HOME = HOME;
  }
});

test('install-daemon writes a plist into the (scratch) LaunchAgents dir and does not load it', () => {
  const { file, xml } = installDaemonPlist();
  assert.ok(file.startsWith(HOME));
  assert.match(xml, /<string>com\.aistatus\.daemon<\/string>/);
  assert.match(xml, /aistatusd\.js<\/string>/);
  assert.equal(fs.readFileSync(file, 'utf8'), xml);
});
