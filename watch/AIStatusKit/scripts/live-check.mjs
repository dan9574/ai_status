#!/usr/bin/env node
// Run the Swift checks *against a real aistatusd process*:
//   node watch/AIStatusKit/scripts/live-check.mjs [port]
// Scratch HOME (never touches ~/.claude, ~/.codex, ~/.aistatus), Bonjour off,
// token set (enforced only for the LAN address). The Swift runner prints
// RESTART_DAEMON when it wants the daemon bounced to test reconnection.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PKG, '..', '..');
const PORT = Number(process.argv[2] || 17780);
const TOKEN = 'live-token';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-live-'));
const env = { ...process.env, HOME, AISTATUS_PORT: String(PORT), AISTATUS_BONJOUR: '0', AISTATUS_CODEX_SOURCE: 'hooks' };
delete env.AISTATUS_DIR;
fs.mkdirSync(path.join(HOME, '.aistatus'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.aistatus', 'config.json'), JSON.stringify({ token: TOKEN }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const build = spawnSync('swift', ['build'], { cwd: PKG, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

let daemon;
async function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'aistatusd.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.logs = '';
  daemon.stdout.on('data', (c) => (daemon.logs += c));
  daemon.stderr.on('data', (c) => (daemon.logs += c));
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
    if (ok) return;
    await sleep(100);
  }
  throw new Error('daemon did not start\n' + daemon.logs);
}
const stopDaemon = () => new Promise((r) => { daemon.once('exit', r); daemon.kill('SIGTERM'); });

await startDaemon();
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const args = ['--live', `127.0.0.1:${PORT}`, ...(lan ? ['--lan', lan, '--token', TOKEN] : [])];
const runner = spawn(path.join(PKG, '.build', 'debug', 'AIStatusChecks'), args, { cwd: PKG, stdio: ['ignore', 'pipe', 'inherit'] });
readline.createInterface({ input: runner.stdout }).on('line', async (line) => {
  console.log(line);
  if (line.trim() === 'RESTART_DAEMON') {
    await stopDaemon();
    console.log('  [orchestrator] daemon stopped; restarting in 1.5 s');
    await sleep(1500);
    await startDaemon();
    console.log('  [orchestrator] daemon restarted');
  }
});
const code = await new Promise((r) => runner.on('exit', (c) => r(c ?? 1)));
await stopDaemon();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`[orchestrator] runner exit ${code}; daemon stopped; scratch HOME removed`);
process.exit(code);
