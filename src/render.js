// Terminal rendering of session cards (used by `aistatus` and `aistatus list`).

const ESC = '\x1b[';
const C = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
};

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// Approximate terminal column width (wide CJK / emoji = 2 columns).
function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) w += charWidth(ch.codePointAt(0));
  return w;
}

export function truncate(s, max) {
  s = String(s ?? '');
  if (strWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strWidth(s)));

/**
 * Render a snapshot to a string.
 * opts: { now (client ms, already skew-corrected), color, width }
 */
export function renderCards(snapshot, { now = Date.now(), color = true, width = 80 } = {}) {
  const c = (code, s) => (color ? `${code}${s}${C.reset}` : s);
  const sessions = snapshot?.sessions || [];
  const lines = [];
  if (!sessions.length) {
    lines.push(c(C.dim, '  (no active sessions)'));
    return lines.join('\n');
  }
  const projW = Math.min(24, Math.max(8, ...sessions.map((s) => strWidth(s.project || '?'))));
  for (const s of sessions) {
    let badge;
    let timer;
    if (s.status === 'running') {
      badge = c(C.yellow + C.bold, '● RUNNING');
      timer = `${s.startedAtApprox ? '~' : ''}${formatDuration(now - s.startedAt)}`;
    } else if (s.status === 'waiting') {
      badge = c(C.magenta + C.bold, '◆ WAITING');
      const reason = s.waitingReason ? ` (${s.waitingReason})` : '';
      timer = `${formatDuration(now - s.startedAt)} · waiting ${formatDuration(now - s.waitingSince)}${reason}`;
    } else {
      const label = s.interrupted ? '✕ STOPPED' : s.error ? '✕ FAILED ' : '✓ DONE   ';
      badge = c(s.interrupted || s.error ? C.red + C.bold : C.green + C.bold, label);
      const ran = s.runDurationMs == null ? 'ran ?' : `ran ${formatDuration(s.runDurationMs)}`;
      timer = `${ran} · idle ${formatDuration(now - s.finishedAt)} · ${s.dismissPolicy === 'swipe' ? 'swipe' : 'confirm'}`;
    }
    const tool = pad(s.tool, 6);
    const proj = pad(truncate(s.project || '?', projW), projW);
    const shortId = c(C.dim, s.sessionId.slice(0, 8));
    lines.push(` ${badge}  ${c(C.cyan, tool)} ${c(C.bold, proj)}  ${timer}  ${shortId}`);
    if (s.lastMessage) lines.push(`   ${c(C.dim, truncate(s.lastMessage, Math.max(20, width - 4)))}`);
  }
  return lines.join('\n');
}
