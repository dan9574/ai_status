// HTTP API. See README.md "API" for the contract consumed by the watch app.
//
// Two listeners share this code:
//  - the LAN listener (`port`, default 7778): loopback is trusted (local hooks,
//    the CLI); other computers need a token (see config.js).
//  - the public listener (`publicPort`, default 7779, 127.0.0.1 only), meant to
//    sit behind a reverse proxy / tunnel such as Tailscale Funnel. Every request
//    arrives from loopback there, so NOTHING is trusted by source address: every
//    route needs `Authorization: Bearer <token>` (see createPublicServer).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHook, TOOLS } from './store.js';
import { VERSION, sanitizeMachine, hookTokenOf, safeEqual } from './config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Files a remote (Windows) machine may fetch for a one-line install. No secrets.
// Served on the LAN listener only, never on the public listener.
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
export function remoteMachineName(req, url, ip = req.socket.remoteAddress) {
  const given = url.searchParams.get('machine') || req.headers['x-aistatus-machine'];
  return sanitizeMachine(given) || sanitizeMachine(String(ip || '').replace(/^::ffff:/, '')) || 'remote';
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

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        if (limit === MAX_BODY) req.destroy(); // LAN listener: unchanged behaviour
        else req.pause(); // public: answer 413 (with Connection: close) instead of resetting
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

/** Path for log lines: never the query string (it could carry a token). */
function logPath(req) {
  return String(req.url || '').split('?')[0].slice(0, 200);
}

/** Shared SSE plumbing: a client set, snapshot broadcast on change, 15 s heartbeat. */
function sseHub(store) {
  const clients = new Set();
  const broadcast = () => {
    const frame = `event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.on('change', broadcast);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref();
  return {
    clients,
    open(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    close() {
      clearInterval(heartbeat);
      store.off('change', broadcast);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

function attachCloseAll(server, hub) {
  server.closeAll = () =>
    new Promise((resolve) => {
      hub.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  return server;
}

/**
 * Create the API server. `store` is a SessionStore; `config` provides token.
 * Returns the http.Server (not yet listening) with a `.closeAll()` helper.
 * `status()` (optional) adds extra fields to /health (e.g. public listener state).
 */
export function createServer({ store, config = {}, log = () => {}, status = () => ({}) }) {
  const startedAt = Date.now();
  const hub = sseHub(store);
  const sseClients = hub.clients;

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
          ...status(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        return send(res, 200, store.snapshot());
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        return hub.open(req, res);
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
      log(`error ${req.method} ${logPath(req)}: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    }
  });

  return attachCloseAll(server, hub);
}

// ------------------------------------------------------------ public listener

export const MIN_PUBLIC_TOKEN_LENGTH = 16;
export const PUBLIC_LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024, // hook payloads; larger ones are refused with 413
  maxSmallBodyBytes: 16 * 1024, // dismiss
  maxSseClients: 8,
  authFailLimit: 10, // wrong Bearer tokens per client per window ...
  authFailWindowMs: 60_000, // ... before further attempts get 429 until the window ends
  maxConnections: 64,
});

function strongToken(t) {
  return typeof t === 'string' && t.length >= MIN_PUBLIC_TOKEN_LENGTH ? t : null;
}

/**
 * Tokens accepted on the public listener:
 *  - read: `token` -> GET /sessions, GET /events, full GET /health, POST dismiss
 *  - hook: `hookToken`, else `token` -> POST /hook/:tool
 * Tokens shorter than MIN_PUBLIC_TOKEN_LENGTH are not accepted on the public
 * listener. When `hookToken` is set, `token` is NOT accepted for hooks and
 * `hookToken` is never accepted for reads (same as the LAN listener).
 */
export function publicTokens(config = {}) {
  return { read: strongToken(config.token), hook: strongToken(hookTokenOf(config)) };
}

/**
 * Whether the public listener should start, and why not.
 * Returns { enabled, port, reason, read, hook } (read/hook: booleans).
 */
export function publicListenerPlan(config = {}) {
  const port = config.publicPort;
  const t = publicTokens(config);
  const out = { enabled: false, port: null, read: !!t.read, hook: !!t.hook, reason: null };
  if (port === false || port === null || port === undefined || port === '' || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    out.reason = 'publicPort is not set (or is false)';
    return out;
  }
  out.port = Number(port);
  if (!t.read && !t.hook) {
    const weak = (config.token || config.hookToken) ? ` (tokens must be at least ${MIN_PUBLIC_TOKEN_LENGTH} characters)` : '';
    out.reason = `no token configured${weak}; run: aistatus token --new`;
    return out;
  }
  out.enabled = true;
  return out;
}

/**
 * Client identity for rate limiting behind a reverse proxy: the right-most
 * X-Forwarded-For entry (the one the proxy itself appended; earlier entries are
 * client-supplied), else the socket address.
 */
export function publicClientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  return String(req.socket.remoteAddress || 'unknown');
}

/** Fixed-window counter of failed auth attempts per client key. */
export class AuthFailLimiter {
  constructor({ limit = PUBLIC_LIMITS.authFailLimit, windowMs = PUBLIC_LIMITS.authFailWindowMs, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.map = new Map();
  }
  /** Seconds until `key` may try again, or 0 when not blocked. */
  blockedFor(key) {
    const e = this.map.get(key);
    const t = this.now();
    if (!e || t >= e.resetAt) return 0;
    return e.count >= this.limit ? Math.max(1, Math.ceil((e.resetAt - t) / 1000)) : 0;
  }
  fail(key) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || t >= e.resetAt) {
      if (this.map.size >= 10_000) this.prune();
      e = { count: 0, resetAt: t + this.windowMs };
      this.map.set(key, e);
    }
    e.count++;
  }
  prune() {
    const t = this.now();
    for (const [k, e] of this.map) if (t >= e.resetAt) this.map.delete(k);
    if (this.map.size >= 10_000) this.map.clear();
  }
}

/**
 * The public listener (bind it to 127.0.0.1 and put the tunnel in front).
 * Every route needs a valid Bearer token (constant-time compared); `?token=` is
 * ignored. Unauthenticated GET /health answers only {"ok":true}. Setup files are
 * not served. Hooks are always remote hooks (machine from ?machine= /
 * X-AIStatus-Machine, else the forwarded client IP, never this Mac).
 */
export function createPublicServer({ store, config = {}, log = () => {}, limits = {} }) {
  const lim = { ...PUBLIC_LIMITS, ...limits };
  const startedAt = Date.now();
  const hub = sseHub(store);
  const limiter = new AuthFailLimiter({ limit: lim.authFailLimit, windowMs: lim.authFailWindowMs });

  // Refuse without reading a (possibly large) request body: small bodies are
  // drained so the connection can be reused, anything else closes it.
  const refuse = (req, res, code, body, headers = {}) => {
    const len = Number(req.headers['content-length'] || 0);
    if (req.headers['transfer-encoding'] || !(len <= lim.maxSmallBodyBytes)) headers = { ...headers, Connection: 'close' };
    else req.resume();
    return send(res, code, body, headers);
  };

  const server = http.createServer(async (req, res) => {
    const key = publicClientKey(req);
    try {
      const wait = limiter.blockedFor(key);
      if (wait) return refuse(req, res, 429, { error: 'too many failed attempts' }, { 'Retry-After': String(wait) });
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return send(res, 400, { error: 'bad url' });
      }
      let parts;
      try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return send(res, 400, { error: 'bad url' });
      }
      const tokens = publicTokens(config); // read at request time (tests mutate config)
      const bearer = bearerOf(req);
      const isHook = parts[0] === 'hook';
      const expected = isHook ? tokens.hook : tokens.read;
      const ok = !!expected && safeEqual(bearer, expected);
      // Requests without any Authorization header (scanners) are refused but not
      // counted, so they cannot lock out the watch; wrong tokens are counted.
      const failed = () => {
        if (bearer || req.headers.authorization) limiter.fail(key);
      };

      if (url.pathname === '/health' && req.method === 'GET' && !isHook) {
        if (!ok) {
          failed();
          return send(res, 200, { ok: true });
        }
        return send(res, 200, {
          ok: true,
          name: 'aistatusd',
          version: VERSION,
          machine: store.machine,
          remoteHooks: !!tokens.hook,
          startedAt,
          serverTime: Date.now(),
          sessions: store.cards().length,
          sseClients: hub.clients.size,
        });
      }

      if (!ok) {
        failed();
        return refuse(req, res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }

      const tooBig = (limit) => {
        const len = Number(req.headers['content-length']);
        return Number.isFinite(len) && len > limit;
      };
      const payloadTooLarge = () => send(res, 413, { error: 'payload too large' }, { Connection: 'close' });

      if (isHook) {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const tool = parts[1];
        if (!TOOLS.includes(tool) || parts.length !== 2) return send(res, 404, { error: 'unknown tool' });
        if (tooBig(lim.maxBodyBytes)) return payloadTooLarge();
        const raw = await readBody(req, lim.maxBodyBytes);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'invalid json' });
        }
        const machine = remoteMachineName(req, url, isLoopback(key) ? null : key);
        const ev = normalizeHook(tool, payload);
        if (ev) Object.assign(ev, { remote: true, machine });
        const changed = ev ? store.apply(ev) : false;
        log(`public hook ${tool}@${machine} ${payload?.hook_event_name} ${String(payload?.session_id || '').slice(0, 8)} -> ${ev ? ev.type : 'ignored'}${changed ? '' : ' (no change)'}`);
        return send(res, 200, { ok: true, event: ev ? ev.type : null, changed });
      }

      if (req.method === 'GET' && url.pathname === '/sessions') return send(res, 200, store.snapshot());

      if (req.method === 'GET' && url.pathname === '/events') {
        if (hub.clients.size >= lim.maxSseClients) {
          return send(res, 503, { error: 'too many event streams' }, { 'Retry-After': '5' });
        }
        return hub.open(req, res);
      }

      if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'dismiss') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        if (tooBig(lim.maxSmallBodyBytes)) return payloadTooLarge();
        await readBody(req, lim.maxSmallBodyBytes);
        const dismissed = store.dismiss(parts[1]);
        if (!dismissed) return send(res, 404, { error: 'no such session (or ambiguous prefix)' });
        log(`public dismiss ${dismissed.id}`);
        return send(res, 200, { ok: true, dismissed });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`public error ${req.method} ${logPath(req)}: ${e.message}`);
      if (!res.headersSent) {
        if (e.status === 413) return send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
        send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // time to receive a request; SSE responses are not affected
  server.maxConnections = lim.maxConnections;
  server.limiter = limiter;
  return attachCloseAll(server, hub);
}
