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
export const TOOLS = ['claude', 'codex'];
export const STATUS_ORDER = { waiting: 0, running: 1, done: 2, idle: 3 };

// A "done" session that sees tool activity within this window is treated as a
// continuation of the same run (e.g. a Stop hook that told the agent to keep going).
const CONTINUATION_MS = 30_000;
// A session waiting on sub-agents with no events at all for this long is
// finalised anyway (guards against a lost SubagentStop).
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * Sanitise a machine display name: letters, digits, '.', '_' and '-' only
 * (anything else becomes '-'), at most 32 characters. Returns null if empty.
 */
export function sanitizeMachine(name) {
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
export function projectName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

export function snippet(text, max = 160) {
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
export function normalizeHook(tool, payload) {
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
export class SessionState extends Emitter {
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
