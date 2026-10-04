// Cloud hub: the daemon's HTTP protocol as one runtime-neutral fetch handler,
// `(Request) => Promise<Response>`, over a small storage interface.
//
// Runs unchanged in the Supabase Edge Function (Deno; bundled into
// supabase/functions/aistatus/index.ts by scripts/build-supabase.mjs) and under
// Node 22 (tests, src/hub/node-server.js). Uses only web-standard globals
// (Request, Response, URL, TextEncoder, crypto.subtle) and src/core.js.
// Keep it that way: no Node or Deno APIs here, and the only import is core.js.
//
// Routes (relative to the function's base URL, e.g.
// https://<ref>.supabase.co/functions/v1/aistatus):
//   POST /hook/:tool              hook token  (Bearer)   ?machine= / X-AIStatus-Machine
//   GET  /sessions                read token
//   POST /sessions/:id/dismiss    read token
//   GET  /health                  open: {"ok":true}; with the read token: details
//   GET  /events                  read token, then 501: no SSE here, poll /sessions
//
// Tokens follow the daemon's public listener: the read token never works for
// hooks when a separate hook token is set and the hook token never works for
// reads; tokens shorter than MIN_TOKEN_LENGTH are not accepted at all;
// `?token=` is ignored; comparisons are constant-time; tokens are never logged.
//
// Storage holds one row per session: { id, state, version }. Every change is a
// read-modify-write guarded by the row version (compare-and-swap): `put` with
// the version that was read succeeds only if nobody wrote in between; otherwise
// the whole step (read, apply the state machine, write) is retried. Inserts use
// expectedVersion null and fail if the row appeared meanwhile. See
// supabase/schema.sql and src/hub/supabase-storage.js.
import { SessionState, normalizeHook, TOOLS, sanitizeMachine, projectName, snippet } from '../core.js';

export const HUB_NAME = 'aistatus-hub';
export const HUB_VERSION = '0.1.0';
export const MIN_TOKEN_LENGTH = 16;
export const HUB_DEFAULTS = Object.freeze({
  maxBodyBytes: 1024 * 1024, // hook payloads; larger ones get 413
  maxSmallBodyBytes: 16 * 1024, // dismiss
  maxSessionIdLength: 200,
  maxAttempts: 30, // compare-and-swap retries per request
  swipeThresholdSec: 60,
  subagentTimeoutMs: 30 * 60_000,
  idlePruneMs: 24 * 3600_000,
  basePaths: ['/functions/v1/aistatus', '/aistatus'],
});

function strongToken(t) {
  return typeof t === 'string' && t.length >= MIN_TOKEN_LENGTH ? t : null;
}

/** { read, hook } tokens actually accepted (null = that kind of request is refused). */
export function hubTokens({ readToken, hookToken } = {}) {
  return { read: strongToken(readToken), hook: strongToken(hookToken || readToken) };
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time comparison of two strings (hashed first so lengths never leak). */
export async function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerOf(request) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Read the request body as text, refusing more than `limit` bytes (413). */
async function readBody(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'payload too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new HttpError(413, 'payload too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Keep only what the hub needs. Default (minimal): tool, machine, session id,
 * status, timestamps and sub-agent ids; no paths, prompts, messages or error
 * texts. With storeDetails: also the project name (last path component only,
 * never the full path) and short message snippets.
 */
export function redactEvent(ev, storeDetails) {
  delete ev.transcriptPath;
  if (storeDetails) {
    if (ev.cwd) ev.cwd = projectName(ev.cwd);
    if (ev.error) ev.error = snippet(String(ev.error), 80) || 'error';
  } else {
    delete ev.cwd;
    delete ev.message;
    if (ev.error) ev.error = 'error';
  }
  return ev;
}

/**
 * createHubHandler({ storage, readToken, hookToken, storeDetails, now, log, ... })
 *   storage: { get(id), list(), put(id, expectedVersion|null, state), remove(id, expectedVersion) }
 *   now: () => epoch ms (injectable for tests)
 * Returns async (Request) => Response.
 */
export function createHubHandler(opts = {}) {
  const o = { ...HUB_DEFAULTS, ...opts };
  const {
    storage,
    storeDetails = false,
    now = () => Date.now(),
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = o;
  const tokens = hubTokens(o);

  const newState = () =>
    new SessionState({ swipeThresholdSec: o.swipeThresholdSec, now, machine: 'cloud', subagentTimeoutMs: o.subagentTimeoutMs });

  const backoff = (attempt) => sleep(Math.min(250, 4 * 2 ** Math.min(attempt, 6)) * (0.5 + random()));

  /**
   * Atomic read-modify-write of one session row: fn(state) runs the state
   * machine on a state holding just that row (or nothing). Retried from the
   * read when another request wrote the row in between.
   */
  async function mutate(id, fn) {
    for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
      const row = await storage.get(id);
      const state = newState();
      if (row) state.load({ sessions: [row.state] });
      const before = row ? JSON.stringify(state.sessions.get(id) ?? null) : null;
      const result = fn(state);
      const next = state.sessions.get(id) ?? null;
      const after = next ? JSON.stringify(next) : null;
      let ok = true;
      if (after !== before) {
        if (!next) ok = await storage.remove(id, row.version);
        else ok = await storage.put(id, row ? row.version : null, next);
      }
      if (ok) return { result, attempts: attempt + 1 };
      await backoff(attempt);
    }
    throw new HttpError(503, 'busy, try again');
  }

  async function handleHook(request, url, tool) {
    if (!TOOLS.includes(tool)) return json(404, { error: 'unknown tool' });
    const raw = await readBody(request, o.maxBodyBytes);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(400, { error: 'invalid json' });
    }
    const ev = normalizeHook(tool, payload);
    // Events the state machine ignores never touch the database.
    if (!ev) return json(200, { ok: true, event: null, changed: false });
    if (ev.sessionId.length > o.maxSessionIdLength) return json(400, { error: 'session_id too long' });
    const machine = sanitizeMachine(url.searchParams.get('machine') || request.headers.get('x-aistatus-machine')) || 'remote';
    Object.assign(ev, { remote: true, machine });
    redactEvent(ev, storeDetails);
    const id = newState().key(ev.tool, ev.sessionId, machine);
    const { result: changed, attempts } = await mutate(id, (state) => state.apply(ev));
    log(`hook ${tool}@${machine} ${String(payload.hook_event_name).slice(0, 32)} ${ev.sessionId.slice(0, 8)} -> ${ev.type}${changed ? '' : ' (no change)'}${attempts > 1 ? ` [${attempts} attempts]` : ''}`);
    return json(200, { ok: true, event: ev.type, changed });
  }

  /** All rows as one state, after sub-agent expiry and idle pruning (written back best-effort). */
  async function loadAll() {
    const rows = await storage.list();
    const state = newState();
    state.load({ sessions: rows.map((r) => r.state) });
    const before = new Map();
    for (const r of rows) {
      const s = state.sessions.get(r.id);
      if (s) before.set(r.id, { version: r.version, json: JSON.stringify(s) });
    }
    state.expireSubagents();
    state.prune(o.idlePruneMs);
    // Housekeeping writes are optimistic too: on a conflict another request
    // changed the row and the next read redoes the check.
    const writes = [];
    for (const [id, b] of before) {
      const s = state.sessions.get(id);
      if (!s) writes.push(storage.remove(id, b.version));
      else if (JSON.stringify(s) !== b.json) writes.push(storage.put(id, b.version, s));
    }
    if (writes.length) {
      const res = await Promise.allSettled(writes);
      for (const r of res) if (r.status === 'rejected') log(`housekeeping write failed: ${r.reason?.message || r.reason}`);
    }
    return state;
  }

  async function handleDismiss(request, rawId) {
    await readBody(request, o.maxSmallBodyBytes);
    let id = rawId;
    if (!(await storage.get(id))) {
      // Not an exact id: resolve a session id or unique prefix like the daemon.
      const s = (await loadAll()).resolve(rawId);
      if (!s) return json(404, { error: 'no such session (or ambiguous prefix)' });
      id = s.id;
    }
    const { result: dismissed } = await mutate(id, (state) => state.dismiss(id));
    if (!dismissed) return json(404, { error: 'no such session (or ambiguous prefix)' });
    log(`dismiss ${dismissed.id}`);
    return json(200, { ok: true, dismissed });
  }

  function stripBase(pathname) {
    for (const b of o.basePaths) {
      if (pathname === b) return '/';
      if (pathname.startsWith(b + '/')) return pathname.slice(b.length);
    }
    return pathname;
  }

  return async function handle(request) {
    const method = request.method;
    let path = '?';
    try {
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return json(400, { error: 'bad url' });
      }
      path = stripBase(url.pathname);
      let parts;
      try {
        parts = path.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return json(400, { error: 'bad url' });
      }
      const isHook = parts[0] === 'hook';
      const expected = isHook ? tokens.hook : tokens.read;
      const ok = !!expected && (await tokenEquals(bearerOf(request), expected));

      if (!isHook && parts.length === 1 && parts[0] === 'health' && method === 'GET') {
        if (!ok) return json(200, { ok: true });
        const state = await loadAll();
        return json(200, {
          ok: true,
          name: HUB_NAME,
          version: HUB_VERSION,
          serverTime: now(),
          sessions: state.cards().length,
          storeDetails: !!storeDetails,
          remoteHooks: !!tokens.hook,
          stream: false,
        });
      }

      if (!tokens.read && !tokens.hook) {
        return json(503, { error: `hub not configured: set the AISTATUS_READ_TOKEN (and AISTATUS_HOOK_TOKEN) secrets, at least ${MIN_TOKEN_LENGTH} characters` });
      }
      if (!ok) return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

      if (isHook) {
        if (method !== 'POST') return json(405, { error: 'method not allowed' });
        if (parts.length !== 2) return json(404, { error: 'unknown tool' });
        return await handleHook(request, url, parts[1]);
      }

      if (parts.length === 1 && parts[0] === 'sessions') {
        if (method !== 'GET') return json(405, { error: 'method not allowed' });
        const state = await loadAll();
        return json(200, state.snapshot());
      }

      if (parts.length === 1 && parts[0] === 'events') {
        // Edge functions are short-lived: no server-sent events. 501 tells the
        // watch (and `aistatus`) to poll GET /sessions instead.
        return json(501, { error: 'no event stream on the cloud hub; poll GET /sessions' });
      }

      if (parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'dismiss') {
        if (method !== 'POST') return json(405, { error: 'method not allowed' });
        return await handleDismiss(request, parts[1]);
      }

      return json(404, { error: 'not found' });
    } catch (e) {
      // (No hop-by-hop headers such as Connection: the platform owns the connection.)
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      log(`error ${method} ${String(path).slice(0, 100)}: ${e?.message || e}`);
      return json(500, { error: 'internal error' });
    }
  };
}
