// Windows scripts (static checks: no PowerShell on this Mac) and the
// `aistatus token` / `aistatus remote-setup` commands, in a scratch HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODEX_EVENTS } from '../src/installer.js';
import { windowsInstallCommands } from '../src/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PS1 = fs.readFileSync(path.join(ROOT, 'hooks', 'aistatus-hook.ps1'), 'utf8');
const INSTALL_PS1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install-windows.ps1'), 'utf8');

test('Windows installer registers exactly the Codex events of the Mac installer', () => {
  const m = /^\$Events = @\(([^)]*)\)/m.exec(INSTALL_PS1);
  assert.ok(m, '$Events line found');
  const ps = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(ps, CODEX_EVENTS.map((e) => e.event));
  assert.ok(ps.includes('SubagentStart') && ps.includes('SubagentStop'));
});

test('PowerShell scripts are ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
  for (const [name, text] of [['aistatus-hook.ps1', HOOK_PS1], ['install-windows.ps1', INSTALL_PS1]]) {
    assert.ok(/^[\x00-\x7f]*$/.test(text), `${name} has non-ASCII characters`);
  }
});

test('Windows hook: constant command line, config file, Bearer token, machine param, always exit 0', () => {
  assert.match(INSTALL_PS1, /\$HookCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "'/);
  assert.match(INSTALL_PS1, /\$Marker = 'aistatus-hook'/, 'uninstall marker matches the Mac installer');
  assert.match(INSTALL_PS1, /UTF8Encoding \$false/, 'writes JSON without BOM');
  assert.match(HOOK_PS1, /\.aistatus\\config\.json/);
  assert.match(HOOK_PS1, /'\/hook\/codex\?machine=' \+ \[System\.Uri\]::EscapeDataString/);
  assert.match(HOOK_PS1, /'Authorization', 'Bearer '/);
  assert.match(HOOK_PS1, /\$req\.Timeout = 1000/);
  assert.match(HOOK_PS1, /\nexit 0\n$/);
  assert.doesNotMatch(HOOK_PS1, /Write-(Host|Output)|Out-Host/, 'hook prints nothing');
});

test('Codex hook timeout stays within the 3s SessionEnd/Interrupt limit', () => {
  const m = /\$HookTimeoutSec = (\d+)/.exec(INSTALL_PS1);
  assert.ok(m && Number(m[1]) <= 3);
});

test('remote-setup install commands', () => {
  const c = windowsInstallCommands({ host: '192.168.1.20', port: 7778, token: 'abc_DEF-1' });
  assert.match(c.oneLine, /DownloadString\('http:\/\/192\.168\.1\.20:7778\/setup\/install-windows\.ps1'\)/);
  assert.match(c.oneLine, /-MacHost 192\.168\.1\.20 -Port 7778 -Token 'abc_DEF-1'"$/);
  assert.match(c.fromFiles, /-File \.\\scripts\\install-windows\.ps1 -MacHost 192\.168\.1\.20/);
});

function cli(home, ...args) {
  const env = { ...process.env, HOME: home };
  delete env.AISTATUS_DIR;
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aistatus.js'), ...args], { env, encoding: 'utf8' });
}

test('aistatus token: none, --new (0600, merges config), --hooks-only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-tok-'));
  const cfgFile = path.join(home, '.aistatus', 'config.json');
  let r = cli(home, 'token');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no token configured/);

  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ port: 7779, swipeThresholdSec: 30 }));
  r = cli(home, 'token', '--new');
  assert.equal(r.status, 0);
  const tok = r.stdout.trim();
  assert.match(tok, /^[A-Za-z0-9_-]{32}$/);
  let cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(cfg, { port: 7779, swipeThresholdSec: 30, token: tok });
  assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
  assert.equal(cli(home, 'token').stdout.trim(), tok);

  r = cli(home, 'token', '--new', '--hooks-only');
  const hookTok = r.stdout.trim();
  assert.notEqual(hookTok, tok);
  cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(cfg.token, tok);
  assert.equal(cfg.hookToken, hookTok);
  assert.equal(cli(home, 'token').stdout.trim(), hookTok, 'prints the token remote hooks must use');

  fs.writeFileSync(cfgFile, '{ broken');
  r = cli(home, 'token', '--new');
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{ broken', 'invalid config is never overwritten');
  fs.rmSync(home, { recursive: true, force: true });
});

test('aistatus remote-setup prints IP, port, token and the install command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-rs-'));
  fs.mkdirSync(path.join(home, '.aistatus'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aistatus', 'config.json'), JSON.stringify({ hookToken: 'tok-xyz' }));
  const r = cli(home, 'remote-setup', '--port', '17795'); // nothing listens there
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Port: +17795/);
  assert.match(r.stdout, /Token: +tok-xyz/);
  assert.match(r.stdout, /-Port 17795 -Token 'tok-xyz'/);
  assert.match(r.stdout, /not reachable/);
  assert.match(r.stdout, /\/hooks/);
  fs.rmSync(home, { recursive: true, force: true });
});
