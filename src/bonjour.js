// Bonjour advertisement via the system `dns-sd` binary (no npm dependency).
import { spawn } from 'node:child_process';
import os from 'node:os';

export const SERVICE_TYPE = '_aistatus._tcp';

export function advertise({ port, name, txt = {}, log = () => {} }) {
  const host = os.hostname().replace(/\.local\.?$/, '');
  const serviceName = name || `aistatus@${host}`;
  const txtArgs = Object.entries({ path: '/sessions', events: '/events', v: '1', ...txt }).map(([k, v]) => `${k}=${v}`);
  const args = ['-R', serviceName, SERVICE_TYPE, 'local', String(port), ...txtArgs];
  let child;
  try {
    child = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    log(`bonjour: cannot spawn dns-sd: ${e.message}`);
    return { stop() {} };
  }
  child.on('error', (e) => log(`bonjour: dns-sd error: ${e.message}`));
  child.on('exit', (code, sig) => {
    if (!stopped) log(`bonjour: dns-sd exited (${code ?? sig})`);
  });
  child.stderr.on('data', (d) => log(`bonjour: ${String(d).trim()}`));
  let stopped = false;
  log(`bonjour: advertising "${serviceName}" ${SERVICE_TYPE} port ${port}`);
  return {
    child,
    stop() {
      stopped = true;
      if (child.exitCode == null) child.kill('SIGTERM');
    },
  };
}
