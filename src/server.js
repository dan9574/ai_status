// HTTP API. See README.md "API" for the contract consumed by the watch app.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHook, TOOLS } from './store.js';
import { VERSION, sanitizeMachine, hookTokenOf, safeEqual } from './config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Files a remote (Windows) machine may fetch for a one-line install. No secrets.
export const SETUP_FILES = {
  'aistatus-hook.ps1': path.join(REPO_ROOT, 'hooks', 'aistatus-hook.ps1'),
  'install-windows.ps1': path.join(REPO_ROOT, 'scripts', 'install-windows.ps1'),
};

const MAX_BODY = 8 * 1024 * 1024; // hook payloads can include large tool output

export function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function bearerOf(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

/** Display name for a remote hook sender: ?machine= or X-AIStatus-Machine, else its IP. */
export function remoteMachineName(req, url) {
  const given = url.searchParams.get('machine') || req.headers['x-aistatus-machine'];
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return sanitizeMachine(given) || sanitizeMachine(ip) || 'remote';
}

function send(res, code, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Create the API server. `store` is a SessionStore; `config` provides token.
 * Returns the http.Server (not yet listening) with a `.closeAll()` helper.
 */
export function createServer({ store, config = {}, log = () => {} }) {
  const startedAt = Date.now();
  const sseClients = new Set();

  const broadcast = () => {
    const frame = `event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of sseClients) res.write(frame);
  };
  store.on('change', broadcast);

  const heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref();

  const authorized = (req, url) => {
    if (!config.token || isLoopback(req.socket.remoteAddress)) return true;
    return safeEqual(bearerOf(req), config.token) || safeEqual(url.searchParams.get('token'), config.token);
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad url' });
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const remote = req.socket.remoteAddress;

    try {
      // --- hook ingestion ------------------------------------------------
      // Loopback: always accepted (this Mac). Other computers: only when a
      // token is configured (hookToken || token) and sent as a Bearer header.
      if (parts[0] === 'hook') {
        let remoteMachine = null;
        if (!isLoopback(remote)) {
          const expected = hookTokenOf(config);
          if (!expected) return send(res, 403, { error: 'remote hooks are disabled; configure a token on the Mac (aistatus token --new)' });
          if (!safeEqual(bearerOf(req), expected)) return send(res, 401, { error: 'unauthorized' });
          remoteMachine = remoteMachineName(req, url);
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const tool = parts[1];
        if (!TOOLS.includes(tool) || parts.length !== 2) return send(res, 404, { error: `unknown tool ${tool}` });
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'invalid json' });
        }
        const ev = normalizeHook(tool, payload);
        if (ev && remoteMachine) Object.assign(ev, { remote: true, machine: remoteMachine });
        const changed = ev ? store.apply(ev) : false;
        log(`hook ${tool}${remoteMachine ? `@${remoteMachine}` : ''} ${payload?.hook_event_name} ${String(payload?.session_id || '').slice(0, 8)} -> ${ev ? ev.type : 'ignored'}${changed ? '' : ' (no change)'}`);
        return send(res, 200, { ok: true, event: ev ? ev.type : null, changed });
      }

      // --- setup files for remote machines (public, no secrets) ----------
      if (parts[0] === 'setup' && parts.length === 2 && req.method === 'GET' && Object.hasOwn(SETUP_FILES, parts[1])) {
        const data = fs.readFileSync(SETUP_FILES[parts[1]]);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': data.length });
        return res.end(data);
      }

      if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          name: 'aistatusd',
          version: VERSION,
          machine: store.machine,
          remoteHooks: !!hookTokenOf(config),
          pid: process.pid,
          startedAt,
          serverTime: Date.now(),
          sessions: store.cards().length,
          sseClients: sseClients.size,
        });
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        return send(res, 200, store.snapshot());
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'dismiss') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        await readBody(req).catch(() => '');
        const dismissed = store.dismiss(parts[1]);
        if (!dismissed) return send(res, 404, { error: 'no such session (or ambiguous prefix)' });
        log(`dismiss ${dismissed.id} from ${remote}`);
        return send(res, 200, { ok: true, dismissed });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`error ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    }
  });

  server.closeAll = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      store.off('change', broadcast);
      for (const res of sseClients) res.end();
      sseClients.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return server;
}
