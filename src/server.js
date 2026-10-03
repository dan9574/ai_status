// HTTP API. See README.md "API" for the contract consumed by the watch app.
import http from 'node:http';
import { normalizeHook, TOOLS } from './store.js';
import { VERSION } from './config.js';

const MAX_BODY = 8 * 1024 * 1024; // hook payloads can include large tool output

export function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
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
    const h = req.headers.authorization || '';
    return h === `Bearer ${config.token}` || url.searchParams.get('token') === config.token;
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
      // --- hook ingestion: loopback only -------------------------------
      if (parts[0] === 'hook') {
        if (!isLoopback(remote)) return send(res, 403, { error: 'hooks are accepted from loopback only' });
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
        const changed = ev ? store.apply(ev) : false;
        log(`hook ${tool} ${payload?.hook_event_name} ${String(payload?.session_id || '').slice(0, 8)} -> ${ev ? ev.type : 'ignored'}${changed ? '' : ' (no change)'}`);
        return send(res, 200, { ok: true, event: ev ? ev.type : null, changed });
      }

      if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          name: 'aistatusd',
          version: VERSION,
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
