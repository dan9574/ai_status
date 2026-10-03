// Session state machine (see PLAN.md "状态机").
//
// A session is keyed by `${tool}:${sessionId}`. Hook payloads are first
// normalised (normalizeHook) into a small set of event types, then applied by
// SessionStore.apply(). The store emits 'change' after every real mutation.
import { EventEmitter } from 'node:events';
import path from 'node:path';

export const TOOLS = ['claude', 'codex'];
export const STATUS_ORDER = { waiting: 0, running: 1, done: 2, idle: 3 };

// A "done" session that sees tool activity within this window is treated as a
// continuation of the same run (e.g. a Stop hook that told the agent to keep going).
const CONTINUATION_MS = 30_000;

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
    case 'SessionEnd':
      return { ...base, type: 'end', reason: payload.reason };
    default:
      return null;
  }
}

export class SessionStore extends EventEmitter {
  constructor({ swipeThresholdSec = 60, now = () => Date.now() } = {}) {
    super();
    this.swipeThresholdSec = swipeThresholdSec;
    this.now = now;
    this.sessions = new Map();
  }

  _hookOwnsTranscript(p) {
    for (const s of this.sessions.values()) if (s.via === 'hook' && s.transcriptPath === p) return true;
    return false;
  }

  key(tool, sessionId) {
    return `${tool}:${sessionId}`;
  }

  _create(ev, now) {
    const s = {
      id: this.key(ev.tool, ev.sessionId),
      tool: ev.tool,
      sessionId: ev.sessionId,
      cwd: ev.cwd || null,
      project: ev.cwd ? path.basename(ev.cwd) : null,
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
      via: ev.via || 'hook',
      createdAt: now,
      updatedAt: now,
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
  }

  /** Apply a normalised event. Returns true if state changed. */
  apply(ev) {
    if (!ev || !TOOLS.includes(ev.tool) || !ev.sessionId) return false;
    const now = ev.ts ?? this.now();
    const id = this.key(ev.tool, ev.sessionId);
    let s = this.sessions.get(id);

    let removedDup = false;
    if (ev.via === 'watcher') {
      // Hooks are authoritative: ignore the rollout watcher for any session
      // (or rollout file) already reported through hooks.
      if (s && s.via === 'hook') return false;
      if (ev.transcriptPath && this._hookOwnsTranscript(ev.transcriptPath)) return false;
      // Replayed / stale lines (e.g. after a daemon restart) must not undo a dismiss.
      if (s && ev.ts != null && (ev.ts < s.updatedAt || (s.dismissedAt && ev.ts <= s.dismissedAt))) return false;
    } else if (ev.transcriptPath) {
      // A hook arrived for a rollout file the watcher was tracking under
      // another id: drop the watcher's duplicate card.
      for (const [k, o] of this.sessions) {
        if (k !== id && o.via === 'watcher' && o.transcriptPath === ev.transcriptPath) {
          this.sessions.delete(k);
          removedDup = true;
        }
      }
    }

    if (ev.type === 'end' && !s) return false;
    const isNew = !s;
    if (!s) s = this._create(ev, now);
    const before = JSON.stringify(s);
    if (ev.cwd && ev.cwd !== s.cwd) {
      s.cwd = ev.cwd;
      s.project = path.basename(ev.cwd);
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

      case 'activity':
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
        break;

      case 'stop':
        if (s.status === 'running' || s.status === 'waiting') {
          s.status = 'done';
          s.finishedAt = now;
          s.runDurationMs = s.startedAt != null ? Math.max(0, now - s.startedAt) : null;
        } else if (s.status === 'idle') {
          if (s.dismissedAt) break;
          // Finished a run we never saw start: show it, duration unknown.
          s.status = 'done';
          s.finishedAt = now;
          s.startedAt = null;
          s.runDurationMs = null;
        }
        s.waitingSince = null;
        s.waitingReason = null;
        if (ev.interrupted) s.interrupted = true;
        if (ev.error) s.error = String(ev.error);
        s.lastMessage = snippet(ev.message) ?? (ev.interrupted ? '(interrupted)' : s.lastMessage);
        break;

      case 'end':
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

    if (JSON.stringify(s) === before && !isNew && !removedDup) return false;
    s.updatedAt = now;
    this.emit('change');
    return true;
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

  toJSON() {
    return { version: 1, sessions: [...this.sessions.values()] };
  }

  load(data) {
    this.sessions.clear();
    if (!data || !Array.isArray(data.sessions)) return;
    for (const s of data.sessions) {
      if (s && s.id && TOOLS.includes(s.tool) && s.sessionId) this.sessions.set(s.id, s);
    }
  }
}
