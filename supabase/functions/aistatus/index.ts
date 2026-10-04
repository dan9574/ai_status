// @ts-nocheck
// GENERATED FILE - do not edit. Built by scripts/build-supabase.mjs from
// src/core.js, src/hub/supabase-storage.js, src/hub/handler.js, src/hub/deno-entry.js.
// Supabase Edge Function "aistatus": the aistatus hub (hooks in, watch reads).
// Deploy: paste this whole file into the function editor of the Supabase
// dashboard, with "Verify JWT" turned OFF (the function checks its own Bearer
// tokens). See README.md, section "云端中转（Supabase）".
import { createClient } from 'npm:@supabase/supabase-js@2';

// ===== src/core.js ===========================================================
// Session state machine (see PLAN.md "状态机"): pure and dependency-free.
//
// This module must stay runtime-neutral: no Node APIs, no imports. It is used
// by the Node daemon (src/store.js wraps it) and, copied verbatim by
// scripts/build-supabase.mjs, by the Supabase Edge Function (Deno). Time is
// injectable (`now`), and change notification is a minimal built-in emitter.
//
// A session is keyed by `${tool}:${sessionId}` for this computer and by
// `${tool}@${machine}:${sessionId}` for sessions reported by another computer
// (remote hooks), so equal session ids from two machines never collide.
// Hook payloads are first normalised (normalizeHook) into a small set of event
// types, then applied by SessionStore.apply(). The store emits 'change' after
// every real mutation.
//
// Sub-agents: SubagentStart/SubagentStop maintain a per-session set of active
// sub-agent ids. A Stop that arrives while sub-agents are still active keeps
// the card running (`pendingStop`); it becomes done when the last one stops.
const TOOLS = ['claude', 'codex'];
const STATUS_ORDER = { waiting: 0, running: 1, done: 2, idle: 3 };

// A "done" session that sees tool activity within this window is treated as a
// continuation of the same run (e.g. a Stop hook that told the agent to keep going).
const CONTINUATION_MS = 30_000;
// A session waiting on sub-agents with no events at all for this long is
// finalised anyway (guards against a lost SubagentStop).
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * Sanitise a machine display name: letters, digits, '.', '_' and '-' only
 * (anything else becomes '-'), at most 32 characters. Returns null if empty.
 */
function sanitizeMachine(name) {
  if (name == null) return null;
  const s = String(name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const out = [...s].slice(0, 32).join('').replace(/[-.]+$/, '');
  return out || null;
}

/** Last path component of a POSIX or Windows path (`C:\\x\\proj` -> `proj`). */
function projectName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

function snippet(text, max = 160) {
  if (text == null) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const NOTIFICATION_WAIT = {
  permission_prompt: 'permission',
  elicitation_dialog: 'input',
  elicitation_url_dialog: 'input',
  agent_needs_input: 'input',
};

/**
 * Map a raw hook payload (Claude Code or Codex; both use the same shape) to a
 * normalised event, or null if it is irrelevant to card status.
 */
function normalizeHook(tool, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const name = payload.hook_event_name;
  const sessionId = payload.session_id;
  if (!name || !sessionId) return null;
  const base = {
    tool,
    sessionId: String(sessionId),
    cwd: payload.cwd || null,
    transcriptPath: payload.transcript_path || null,
    via: 'hook',
    hook: name,
  };
  // Present on events fired inside a sub-agent (Claude Code) and on Subagent* events.
  if (payload.agent_id != null && payload.agent_id !== '') base.agentId = String(payload.agent_id);
  switch (name) {
    case 'SessionStart':
      return { ...base, type: 'start' };
    case 'UserPromptSubmit':
      return { ...base, type: 'prompt', message: payload.prompt };
    case 'Notification': {
      const nt = payload.notification_type;
      let reason = nt ? NOTIFICATION_WAIT[nt] : undefined;
      // Older Claude Code versions had no notification_type; only the
      // permission message means "waiting" (the idle message fires after Stop).
      if (!nt && /permission/i.test(payload.message || '')) reason = 'permission';
      if (!reason) return null;
      return { ...base, type: 'wait', reason, message: payload.message };
    }
    case 'PermissionRequest':
      return {
        ...base,
        type: 'wait',
        reason: 'permission',
        message: payload.tool_name ? `Permission: ${payload.tool_name}` : 'Permission requested',
      };
    case 'PreToolUse':
      if (payload.tool_name === 'AskUserQuestion') {
        return { ...base, type: 'wait', reason: 'question', message: 'Asking a question' };
      }
      return { ...base, type: 'activity' };
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return { ...base, type: 'activity' };
    case 'Stop':
      return { ...base, type: 'stop', message: payload.last_assistant_message };
    case 'StopFailure':
      return { ...base, type: 'stop', error: payload.error || payload.error_type || 'error', message: payload.error_message || payload.message };
    case 'Interrupt': // Codex: user interrupted the turn
      return { ...base, type: 'stop', interrupted: true };
    case 'SubagentStart':
      return base.agentId ? { ...base, type: 'subStart' } : null;
    case 'SubagentStop':
      return base.agentId ? { ...base, type: 'subStop' } : null;
    case 'SessionEnd':
      return { ...base, type: 'end', reason: payload.reason };
    default:
      return null;
  }
}

/** Minimal event emitter (on/off/emit), so this module needs no Node APIs. */
class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
    return this;
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }
}

/**
 * All sessions of one hub and the rules that change them. The daemon keeps one
 * long-lived instance; the cloud hub builds a short-lived one per request from
 * the rows it read (see src/hub/handler.js).
 */
class SessionState extends Emitter {
  /**
   * machine: display name of this computer (local sessions).
   * subagentTimeoutMs: see DEFAULT_SUBAGENT_TIMEOUT_MS.
   */
  constructor({ swipeThresholdSec = 60, now = () => Date.now(), machine = 'local', subagentTimeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS } = {}) {
    super();
    this.swipeThresholdSec = swipeThresholdSec;
    this.now = now;
    this.machine = machine;
    this.subagentTimeoutMs = subagentTimeoutMs;
    this.sessions = new Map();
  }

  _hookOwnsTranscript(p) {
    for (const s of this.sessions.values()) if (!s.remote && s.via === 'hook' && s.transcriptPath === p) return true;
    return false;
  }

  /** Session key. `remoteMachine` is set only for sessions reported by another computer. */
  key(tool, sessionId, remoteMachine = null) {
    return remoteMachine ? `${tool}@${remoteMachine}:${sessionId}` : `${tool}:${sessionId}`;
  }

  _keyOf(ev) {
    return this.key(ev.tool, ev.sessionId, ev.remote ? ev.machine : null);
  }

  _create(ev, now) {
    const s = {
      id: this._keyOf(ev),
      tool: ev.tool,
      sessionId: ev.sessionId,
      machine: ev.remote ? ev.machine : this.machine,
      remote: !!ev.remote,
      cwd: ev.cwd || null,
      project: projectName(ev.cwd),
      status: 'idle',
      startedAt: null,
      startedAtApprox: false,
      finishedAt: null,
      runDurationMs: null,
      waitingSince: null,
      waitingReason: null,
      lastMessage: null,
      transcriptPath: ev.transcriptPath || null,
      interrupted: false,
      error: null,
      ended: false,
      dismissedAt: null,
      subagents: [],
      pendingStop: false,
      via: ev.via || 'hook',
      createdAt: now,
      updatedAt: now,
      lastEventAt: now,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  _startRun(s, now, approx) {
    s.status = 'running';
    s.startedAt = now;
    s.startedAtApprox = approx;
    s.finishedAt = null;
    s.runDurationMs = null;
    s.waitingSince = null;
    s.waitingReason = null;
    s.interrupted = false;
    s.error = null;
    s.ended = false;
    s.dismissedAt = null;
    s.subagents = [];
    s.pendingStop = false;
  }

  _finish(s, at) {
    s.status = 'done';
    s.finishedAt = at;
    s.runDurationMs = s.startedAt != null ? Math.max(0, at - s.startedAt) : null;
    s.pendingStop = false;
  }

  /** Apply a normalised event. Returns true if state changed. */
  apply(ev) {
    if (!ev || !TOOLS.includes(ev.tool) || !ev.sessionId) return false;
    if (ev.remote && !ev.machine) return false;
    const now = ev.ts ?? this.now();
    const id = this._keyOf(ev);
    let s = this.sessions.get(id);

    let removedDup = false;
    if (ev.via === 'watcher') {
      // Hooks are authoritative: ignore the rollout watcher for any session
      // (or rollout file) already reported through hooks.
      if (s && s.via === 'hook') return false;
      if (ev.transcriptPath && this._hookOwnsTranscript(ev.transcriptPath)) return false;
      // Replayed / stale lines (e.g. after a daemon restart) must not undo a dismiss.
      if (s && ev.ts != null && (ev.ts < s.updatedAt || (s.dismissedAt && ev.ts <= s.dismissedAt))) return false;
    } else if (ev.transcriptPath && !ev.remote) {
      // A hook arrived for a rollout file the watcher was tracking under
      // another id: drop the watcher's duplicate card.
      for (const [k, o] of this.sessions) {
        if (k !== id && o.via === 'watcher' && o.transcriptPath === ev.transcriptPath) {
          this.sessions.delete(k);
          removedDup = true;
        }
      }
    }

    if ((ev.type === 'end' || ev.type === 'subStop') && !s) return false;
    const isNew = !s;
    if (!s) s = this._create(ev, now);
    if (!Array.isArray(s.subagents)) s.subagents = [];
    const before = fingerprint(s);
    s.lastEventAt = Math.max(s.lastEventAt ?? 0, now);
    if (ev.cwd && ev.cwd !== s.cwd) {
      s.cwd = ev.cwd;
      s.project = projectName(ev.cwd);
    }
    if (ev.via === 'hook') s.via = 'hook';
    if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;

    switch (ev.type) {
      case 'start':
        // Never changes status: SessionStart also fires on resume/compact mid-run.
        break;

      case 'prompt':
        if (s.status === 'idle' || s.status === 'done') this._startRun(s, now, false);
        else s.status = 'running';
        // A new prompt starts a new turn: forget sub-agents of the previous one
        // (also recovers from a lost SubagentStop).
        s.subagents = [];
        s.pendingStop = false;
        s.waitingSince = null;
        s.waitingReason = null;
        s.dismissedAt = null;
        s.lastMessage = snippet(ev.message) ?? s.lastMessage;
        break;

      case 'wait':
        if (s.status === 'idle' || s.status === 'done') {
          if (s.status === 'idle' && s.dismissedAt) break; // user dismissed this run
          this._startRun(s, now, true); // we missed the prompt (daemon was down)
        }
        if (s.status !== 'waiting') s.waitingSince = now;
        s.status = 'waiting';
        s.waitingReason = ev.reason || 'input';
        s.lastMessage = snippet(ev.message) ?? s.lastMessage;
        break;

      case 'subStart':
        // A sub-agent starting is activity of this session. First, because
        // starting a (missed) run resets the sub-agent list.
        this._activity(s, now);
        if (!s.subagents.includes(ev.agentId)) s.subagents.push(ev.agentId);
        break;

      case 'subStop': {
        const i = s.subagents.indexOf(ev.agentId);
        if (i < 0) break; // unknown (e.g. after a new prompt reset the list)
        s.subagents.splice(i, 1);
        if (s.subagents.length === 0 && s.pendingStop && (s.status === 'running' || s.status === 'waiting')) {
          this._finish(s, now);
          s.waitingSince = null;
          s.waitingReason = null;
        }
        break;
      }

      case 'activity':
        // Tool calls inside a sub-agent never resurrect a finished/dismissed run.
        if (ev.agentId && (s.status === 'done' || s.status === 'idle')) break;
        this._activity(s, now);
        break;

      case 'stop':
        if (ev.interrupted || ev.error) s.subagents = []; // the turn was aborted
        if (s.subagents.length && (s.status === 'running' || s.status === 'waiting')) {
          // Main turn finished but sub-agents are still working: stay running.
          s.status = 'running';
          s.pendingStop = true;
        } else if (s.status === 'running' || s.status === 'waiting') {
          this._finish(s, now);
        } else if (s.status === 'idle') {
          if (s.dismissedAt) break;
          // Finished a run we never saw start: show it, duration unknown.
          s.status = 'done';
          s.finishedAt = now;
          s.startedAt = null;
          s.runDurationMs = null;
          s.subagents = [];
        }
        s.waitingSince = null;
        s.waitingReason = null;
        if (ev.interrupted) s.interrupted = true;
        if (ev.error) s.error = String(ev.error);
        s.lastMessage = snippet(ev.message) ?? (ev.interrupted ? '(interrupted)' : s.lastMessage);
        break;

      case 'end':
        s.subagents = [];
        if (s.pendingStop && (s.status === 'running' || s.status === 'waiting')) this._finish(s, now);
        if (s.status === 'done') s.ended = true;
        else {
          this.sessions.delete(id);
          this.emit('change');
          return true;
        }
        break;

      default:
        if (isNew) this.sessions.delete(id);
        return false;
    }

    if (fingerprint(s) === before && !isNew && !removedDup) return false;
    s.updatedAt = now;
    this.emit('change');
    return true;
  }

  _activity(s, now) {
    if (s.status === 'waiting') {
      s.status = 'running';
      s.waitingSince = null;
      s.waitingReason = null;
    } else if (s.status === 'idle') {
      if (!s.dismissedAt) this._startRun(s, now, true);
    } else if (s.status === 'done') {
      if (s.finishedAt != null && now - s.finishedAt <= CONTINUATION_MS && s.startedAt != null) {
        // continuation of the same run
        s.status = 'running';
        s.finishedAt = null;
        s.runDurationMs = null;
      } else {
        this._startRun(s, now, true);
      }
    }
  }

  /** Resolve an id: exact `tool:sessionId`, exact sessionId, or unique prefix. */
  resolve(idOrPrefix) {
    if (!idOrPrefix) return null;
    if (this.sessions.has(idOrPrefix)) return this.sessions.get(idOrPrefix);
    const matches = [...this.sessions.values()].filter(
      (s) => s.sessionId === idOrPrefix || s.sessionId.startsWith(idOrPrefix) || s.id.startsWith(idOrPrefix),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /** Remove a card. Returns the dismissed session view or null if unknown. */
  dismiss(idOrPrefix) {
    const s = this.resolve(idOrPrefix);
    if (!s) return null;
    const view = this.view(s);
    if (s.ended) {
      this.sessions.delete(s.id);
    } else {
      s.status = 'idle';
      s.dismissedAt = this.now();
      s.waitingSince = null;
      s.waitingReason = null;
      s.subagents = [];
      s.pendingStop = false;
      s.updatedAt = this.now();
    }
    this.emit('change');
    return view;
  }

  dismissPolicy(s) {
    if (s.status !== 'done') return 'confirm';
    return s.runDurationMs != null && s.runDurationMs < this.swipeThresholdSec * 1000 ? 'swipe' : 'confirm';
  }

  /** Public JSON shape of one card (see README API reference). */
  view(s) {
    return {
      id: s.id,
      tool: s.tool,
      sessionId: s.sessionId,
      machine: s.machine ?? this.machine,
      project: s.project,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt,
      startedAtApprox: s.startedAtApprox,
      finishedAt: s.finishedAt,
      runDurationMs: s.runDurationMs,
      waitingSince: s.waitingSince,
      waitingReason: s.waitingReason,
      lastMessage: s.lastMessage,
      dismissPolicy: this.dismissPolicy(s),
      interrupted: s.interrupted,
      error: s.error,
      ended: s.ended,
      // Sub-agents still running (the card stays running until they finish).
      activeSubagents: Array.isArray(s.subagents) ? s.subagents.length : 0,
      updatedAt: s.updatedAt,
    };
  }

  /** Visible cards (non-idle), sorted waiting > running > done, then oldest first. */
  cards() {
    return [...this.sessions.values()]
      .filter((s) => s.status !== 'idle')
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          (a.startedAt ?? a.finishedAt ?? 0) - (b.startedAt ?? b.finishedAt ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map((s) => this.view(s));
  }

  snapshot() {
    const now = this.now();
    return {
      version: 1,
      serverTime: now,
      swipeThresholdSec: this.swipeThresholdSec,
      sessions: this.cards(),
    };
  }

  /** Forget idle sessions untouched for longer than maxAgeMs. */
  prune(maxAgeMs) {
    const cutoff = this.now() - maxAgeMs;
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.status === 'idle' && s.updatedAt < cutoff) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
    return changed;
  }

  /**
   * Guard against a lost SubagentStop: a session with active sub-agents and no
   * events at all for subagentTimeoutMs forgets them; if its main turn had
   * already stopped it becomes done as of its last event.
   */
  expireSubagents() {
    const cutoff = this.now() - this.subagentTimeoutMs;
    let changed = false;
    for (const s of this.sessions.values()) {
      if (!Array.isArray(s.subagents) || !s.subagents.length) continue;
      const last = s.lastEventAt ?? s.updatedAt ?? 0;
      if (last > cutoff) continue;
      s.subagents = [];
      if (s.pendingStop && (s.status === 'running' || s.status === 'waiting')) {
        this._finish(s, last);
        s.waitingSince = null;
        s.waitingReason = null;
      }
      s.pendingStop = false;
      s.updatedAt = this.now();
      changed = true;
    }
    if (changed) this.emit('change');
    return changed;
  }

  toJSON() {
    return { version: 2, sessions: [...this.sessions.values()] };
  }

  /**
   * Load persisted state. Accepts the phase-1/2 format (version 1: no machine,
   * remote, subagents or pendingStop fields): such sessions are local.
   */
  load(data) {
    this.sessions.clear();
    if (!data || !Array.isArray(data.sessions)) return;
    for (const raw of data.sessions) {
      if (!raw || typeof raw !== 'object' || !raw.id || !TOOLS.includes(raw.tool) || !raw.sessionId) continue;
      const s = { ...raw };
      s.remote = s.remote === true && typeof s.machine === 'string' && s.machine !== '';
      if (!s.remote) s.machine = this.machine; // local sessions follow this computer's current name
      s.sessionId = String(s.sessionId);
      s.id = this.key(s.tool, s.sessionId, s.remote ? s.machine : null);
      if (!Array.isArray(s.subagents)) s.subagents = [];
      s.pendingStop = s.pendingStop === true;
      if (s.lastEventAt == null) s.lastEventAt = s.updatedAt ?? null;
      this.sessions.set(s.id, s);
    }
  }
}

// Change detection ignores lastEventAt, which moves on every event (liveness only).
function fingerprint(s) {
  const { lastEventAt, ...rest } = s;
  return JSON.stringify(rest);
}

// ===== src/hub/supabase-storage.js ===========================================
// Hub storage on the Postgres table of supabase/schema.sql, through a
// supabase-js v2 client created with a secret (service-role) key. Runtime-
// neutral: it only calls methods of the client it is given (tests pass a fake
// that mimics PostgREST, see test/hub-supabase.test.js).
//
// Atomicity: each call below is ONE SQL statement (PostgREST runs every request
// in its own transaction), and the conditional ones carry the version that was
// read:
//   UPDATE aistatus_sessions SET ..., version = v+1 WHERE id = $1 AND version = v
//   DELETE FROM aistatus_sessions WHERE id = $1 AND version = v
// Postgres locks the row for the UPDATE/DELETE and re-checks the WHERE clause
// against the newest row version after waiting for a concurrent writer, so
// exactly one of two writers holding the same version succeeds; the other sees
// zero affected rows and the handler retries from the read. A first write is
// an INSERT that fails with unique_violation (23505) if the row appeared
// meanwhile. No row lock is held across the JavaScript state-machine step.

const SESSIONS_TABLE = 'aistatus_sessions';

function fail(op, error) {
  // error.message from PostgREST never contains the API key.
  const e = new Error(`database ${op} failed: ${error?.message || error}`);
  e.code = error?.code;
  return e;
}

/** Columns besides `state`, for looking at the table in the dashboard. */
function columns(state, now) {
  return {
    tool: String(state.tool),
    machine: String(state.machine ?? ''),
    session_id: String(state.sessionId),
    status: String(state.status),
    state,
    updated_at: new Date(now()).toISOString(),
  };
}

function supabaseStorage(client, { table = SESSIONS_TABLE, now = () => Date.now() } = {}) {
  return {
    async get(id) {
      const { data, error } = await client.from(table).select('id, state, version').eq('id', id).maybeSingle();
      if (error) throw fail('read', error);
      return data ? { id: data.id, state: data.state, version: Number(data.version) } : null;
    },

    async list() {
      const { data, error } = await client.from(table).select('id, state, version').limit(1000);
      if (error) throw fail('list', error);
      return (data || []).map((r) => ({ id: r.id, state: r.state, version: Number(r.version) }));
    },

    async put(id, expectedVersion, state) {
      if (expectedVersion == null) {
        const { error } = await client.from(table).insert({ id, version: 1, ...columns(state, now) });
        if (!error) return true;
        if (error.code === '23505') return false; // inserted concurrently: retry from the read
        throw fail('insert', error);
      }
      const { data, error } = await client
        .from(table)
        .update({ ...columns(state, now), version: expectedVersion + 1 })
        .eq('id', id)
        .eq('version', expectedVersion)
        .select('id');
      if (error) throw fail('update', error);
      return Array.isArray(data) && data.length === 1;
    },

    async remove(id, expectedVersion) {
      const { data, error } = await client.from(table).delete().eq('id', id).eq('version', expectedVersion).select('id');
      if (error) throw fail('delete', error);
      return Array.isArray(data) && data.length === 1;
    },
  };
}

// ===== src/hub/handler.js ====================================================
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

const HUB_NAME = 'aistatus-hub';
const HUB_VERSION = '0.1.0';
const MIN_TOKEN_LENGTH = 16;
const HUB_DEFAULTS = Object.freeze({
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
function hubTokens({ readToken, hookToken } = {}) {
  return { read: strongToken(readToken), hook: strongToken(hookToken || readToken) };
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time comparison of two strings (hashed first so lengths never leak). */
async function tokenEquals(a, b) {
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
function redactEvent(ev, storeDetails) {
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
function createHubHandler(opts = {}) {
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

// ===== src/hub/deno-entry.js =================================================
// Deno adapter of the Supabase Edge Function: the only code that touches Deno
// or supabase-js. scripts/build-supabase.mjs appends it, after core.js,
// supabase-storage.js and handler.js, to supabase/functions/aistatus/index.ts,
// whose first line imports createClient:
//   import { createClient } from 'npm:@supabase/supabase-js@2';
// (This file is not imported anywhere in Node; the bundle test runs it with a
// fake Deno global and a fake client.)

function envOf(name) {
  return Deno.env.get(name) ?? '';
}

/**
 * The secret API key provided by the platform: SUPABASE_SECRET_KEYS (JSON
 * dictionary, key "default") on projects with the new API keys, else the legacy
 * SUPABASE_SERVICE_ROLE_KEY. Never logged.
 */
function serviceKeyOf() {
  try {
    const keys = JSON.parse(envOf('SUPABASE_SECRET_KEYS') || 'null');
    if (keys && typeof keys === 'object') {
      if (typeof keys.default === 'string' && keys.default) return keys.default;
      const first = Object.values(keys).find((v) => typeof v === 'string' && v);
      if (first) return first;
    }
  } catch {
    /* not JSON: fall back to the legacy key */
  }
  return envOf('SUPABASE_SERVICE_ROLE_KEY');
}

function makeStorage() {
  const url = envOf('SUPABASE_URL');
  const key = serviceKeyOf();
  if (!url || !key) {
    const missing = async () => {
      throw new Error('SUPABASE_URL or the secret API key is not available to the function');
    };
    return { get: missing, list: missing, put: missing, remove: missing };
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return supabaseStorage(client);
}

const aistatusHandler = createHubHandler({
  storage: makeStorage(),
  readToken: envOf('AISTATUS_READ_TOKEN'),
  hookToken: envOf('AISTATUS_HOOK_TOKEN'),
  storeDetails: envOf('AISTATUS_STORE_DETAILS') === '1',
  log: (msg) => console.log(msg),
});

Deno.serve(aistatusHandler);
