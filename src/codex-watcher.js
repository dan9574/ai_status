// Fallback Codex integration: tail rollout files under ~/.codex/sessions and
// infer running/waiting/done from the event_msg lines Codex writes there.
//
// Rollout format (observed on codex-cli 0.159.0-alpha, Codex desktop app):
//   {"timestamp": ISO, "type": "session_meta", "payload": {"id", "cwd", ...}}
//   {"timestamp": ISO, "type": "event_msg", "payload": {"type": "task_started", "turn_id", ...}}
//   {"timestamp": ISO, "type": "event_msg", "payload": {"type": "task_complete", "last_agent_message", "duration_ms", ...}}
//   {"type": "event_msg", "payload": {"type": "turn_aborted"}}           -> interrupted
//   {"type": "event_msg", "payload": {"type": "exec_approval_request"}}  -> waiting (if persisted)
// Read-only: this module never writes under ~/.codex.
import fs from 'node:fs';
import path from 'node:path';

const WAIT_RE = /approval_request$|^request_user_input$|^request_permissions$|^elicitation_request$/;
const REPLAY_WINDOW_MS = 24 * 3600_000; // only look at files touched in the last day on startup
const RECENT_DONE_MS = 10 * 60_000; // ...and show "done" from replay only if it finished this recently
const SCAN_DAYS = 7; // day directories (YYYY/MM/DD) re-listed on each poll

/** Convert one parsed rollout line into a normalised store event (or null). */
export function rolloutLineToEvent(obj, file, fstate) {
  if (!obj || typeof obj !== 'object') return null;
  const ts = Date.parse(obj.timestamp) || undefined;
  const p = obj.payload || {};
  if (obj.type === 'session_meta') {
    fstate.sessionId = p.id || p.session_id || fstate.sessionId;
    fstate.cwd = p.cwd || fstate.cwd;
    return { type: 'start', ts };
  }
  if (obj.type === 'turn_context') {
    if (p.cwd) fstate.cwd = p.cwd;
    return null;
  }
  if (obj.type === 'event_msg') {
    const t = p.type;
    if (t === 'task_started' || t === 'turn_started') {
      fstate.waiting = false;
      return { type: 'prompt', ts };
    }
    if (t === 'task_complete' || t === 'turn_complete') {
      fstate.waiting = false;
      return { type: 'stop', ts, message: p.last_agent_message };
    }
    if (t === 'turn_aborted') {
      fstate.waiting = false;
      return { type: 'stop', ts, interrupted: true };
    }
    if (WAIT_RE.test(t || '')) {
      fstate.waiting = true;
      return { type: 'wait', ts, reason: /permission|approval/.test(t) ? 'permission' : 'input' };
    }
  }
  // Any other progress line after a wait means the agent resumed.
  if (fstate.waiting && (obj.type === 'event_msg' || obj.type === 'response_item')) {
    fstate.waiting = false;
    return { type: 'activity', ts };
  }
  return null;
}

function finish(ev, file, fstate) {
  if (!ev || !fstate.sessionId) return null;
  return { ...ev, tool: 'codex', sessionId: fstate.sessionId, cwd: fstate.cwd, transcriptPath: file, via: 'watcher' };
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial or corrupt line */
    }
  }
  return out;
}

export class CodexWatcher {
  constructor({ store, dir, pollMs = 1500, log = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.dir = dir;
    this.pollMs = pollMs;
    this.log = log;
    this.now = now;
    this.files = new Map(); // file -> { offset, rest, sessionId, cwd, waiting }
    this.timer = null;
  }

  start() {
    this.initialScan();
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (e) {
        this.log(`codex-watcher: ${e.message}`);
      }
    }, this.pollMs);
    this.timer.unref?.();
    this.log(`codex-watcher: watching ${this.dir}`);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** List rollout files in the most recent day directories plus tracked ones. */
  listFiles() {
    const found = new Set(this.files.keys());
    const sortedDirs = (d) => {
      try {
        return fs
          .readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
          .map((e) => e.name)
          .sort()
          .reverse();
      } catch {
        return [];
      }
    };
    const days = [];
    for (const y of sortedDirs(this.dir)) {
      for (const m of sortedDirs(path.join(this.dir, y))) {
        for (const d of sortedDirs(path.join(this.dir, y, m))) {
          days.push(path.join(this.dir, y, m, d));
          if (days.length >= SCAN_DAYS) break;
        }
        if (days.length >= SCAN_DAYS) break;
      }
      if (days.length >= SCAN_DAYS) break;
    }
    for (const day of days) {
      let names = [];
      try {
        names = fs.readdirSync(day);
      } catch {
        continue;
      }
      for (const n of names) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) found.add(path.join(day, n));
    }
    return [...found];
  }

  initialScan() {
    const now = this.now();
    for (const file of this.listFiles()) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const fstate = { offset: st.size, rest: '', sessionId: null, cwd: null, waiting: false };
      this.files.set(file, fstate);
      if (now - st.mtimeMs > REPLAY_WINDOW_MS) {
        this.readMeta(file, fstate);
        continue;
      }
      // Replay to find the current state of recently active sessions.
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lastNl = text.lastIndexOf('\n');
      fstate.offset = Buffer.byteLength(text.slice(0, lastNl + 1));
      fstate.rest = '';
      const evs = [];
      for (const obj of parseLines(text.slice(0, lastNl + 1))) {
        const ev = finish(rolloutLineToEvent(obj, file, fstate), file, fstate);
        if (ev) evs.push(ev);
      }
      let lastPrompt = -1;
      let lastLifecycle = null;
      evs.forEach((ev, i) => {
        if (ev.type === 'prompt') lastPrompt = i;
        if (ev.type === 'prompt' || ev.type === 'stop') lastLifecycle = ev;
      });
      if (!lastLifecycle || lastPrompt < 0) continue;
      const active = lastLifecycle.type === 'prompt';
      const recentDone = lastLifecycle.type === 'stop' && now - (lastLifecycle.ts ?? 0) < RECENT_DONE_MS;
      if (!active && !recentDone) continue;
      for (const ev of evs.slice(lastPrompt)) this.store.apply(ev);
    }
  }

  readMeta(file, fstate) {
    // First line is session_meta; read just enough to find it.
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
      rolloutLineToEvent(JSON.parse(first), file, fstate);
    } catch {
      /* ignore */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  poll() {
    for (const file of this.listFiles()) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        this.files.delete(file);
        continue;
      }
      let fstate = this.files.get(file);
      if (!fstate) {
        // New file since startup: read from the beginning.
        fstate = { offset: 0, rest: '', sessionId: null, cwd: null, waiting: false };
        this.files.set(file, fstate);
      }
      if (st.size < fstate.offset) {
        fstate.offset = 0; // truncated / rewritten
        fstate.rest = '';
      }
      if (st.size === fstate.offset) continue;
      if (!fstate.sessionId && fstate.offset > 0) this.readMeta(file, fstate);
      const fd = fs.openSync(file, 'r');
      let chunk;
      try {
        const len = st.size - fstate.offset;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, fstate.offset);
        fstate.offset += n;
        chunk = fstate.rest + buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const lastNl = chunk.lastIndexOf('\n');
      fstate.rest = chunk.slice(lastNl + 1);
      for (const obj of parseLines(chunk.slice(0, lastNl + 1))) {
        const ev = finish(rolloutLineToEvent(obj, file, fstate), file, fstate);
        if (ev) this.store.apply(ev);
      }
    }
  }
}
