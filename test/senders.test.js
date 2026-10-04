// The two hook senders (hooks/aistatus-hook.sh on the Mac, cloud mode;
// hooks/aistatus-hook.ps1 on Windows) must forward exactly the same events,
// with the same marker rules. PowerShell is not available here, so the
// Windows script is checked statically: its decision table is parsed and
// compared with the shell script's (which test/cloud.test.js runs for real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_EVENTS, CODEX_EVENTS } from '../src/installer.js';
import { normalizeHook } from '../src/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = fs.readFileSync(path.join(ROOT, 'hooks', 'aistatus-hook.sh'), 'utf8');
const PS1 = fs.readFileSync(path.join(ROOT, 'hooks', 'aistatus-hook.ps1'), 'utf8');
const INSTALL_PS1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install-windows.ps1'), 'utf8');

/** Normalised description of what an arm does. */
function describe(body, { setMark, clearMark, ifMark, mini, send }) {
  const f = [];
  if (setMark.test(body)) f.push('set');
  if (clearMark.test(body)) f.push('clear');
  if (ifMark.test(body)) f.push('if-marked');
  if (mini.test(body)) f.push('mini');
  if (send.test(body)) f.push('send');
  return f.join(',');
}

function shTable() {
  const start = SH.indexOf('case "$event" in');
  const end = SH.indexOf('\nesac', start);
  assert.ok(start > 0 && end > start, 'event case statement found');
  const block = SH.slice(start + 'case "$event" in'.length, end);
  const out = {};
  for (const m of block.matchAll(/^ {2}([A-Za-z|]+)\)([\s\S]*?);;/gm)) {
    const d = describe(m[2], { setMark: /set_mark/, clearMark: /clear_mark/, ifMark: /-f "\$mark"/, mini: /send mini/, send: /\bsend\b/ });
    for (const ev of m[1].split('|')) out[ev] = d;
  }
  return out;
}

function psTable() {
  const head = 'switch -CaseSensitive ($hookEvent) {';
  let i = PS1.indexOf(head);
  assert.ok(i > 0, 'switch found');
  i += head.length;
  const out = {};
  for (;;) {
    const m = /^\s*'([A-Za-z]+)'\s*\{/.exec(PS1.slice(i));
    if (!m) break;
    let j = i + m[0].length;
    let depth = 1;
    while (depth > 0) {
      if (PS1[j] === '{') depth++;
      else if (PS1[j] === '}') depth--;
      j++;
    }
    const body = PS1.slice(i + m[0].length, j - 1);
    out[m[1]] = describe(body, { setMark: /Set-Mark/, clearMark: /Clear-Mark/, ifMark: /\$hasMark/, mini: /'mini'/, send: /\$mode = '(full|mini)'/ });
    i = j;
  }
  return out;
}

test('Mac (cloud mode) and Windows senders share one decision table', () => {
  const sh = shTable();
  const ps = psTable();
  assert.deepEqual(ps, sh);
  assert.equal(sh.SessionStart, undefined, 'SessionStart is never sent');
  assert.equal(sh.PostToolUse, 'clear,if-marked,mini,send');
  assert.equal(sh.PermissionRequest, 'set,send');
  assert.equal(sh.Stop, 'set,send');
  assert.equal(sh.UserPromptSubmit, 'clear,send');
});

test('every installed event the hub acts on is handled by the senders', () => {
  const sh = shTable();
  const relevant = (ev) =>
    normalizeHook('claude', { session_id: 's', hook_event_name: ev, agent_id: 'a', notification_type: 'permission_prompt' }) !== null;
  for (const { event } of [...CLAUDE_EVENTS, ...CODEX_EVENTS]) {
    if (event === 'SessionStart') continue; // never changes status
    if (relevant(event)) assert.ok(sh[event], `${event} is forwarded (at least sometimes)`);
  }
  for (const ev of Object.keys(sh)) assert.ok(relevant(ev) || ev === 'SessionEnd', `${ev}: the hub uses it`);
});

test('Windows hook: markers, mini payload, size cap, still silent and exit 0', () => {
  assert.match(PS1, /\$marks = Join-Path \$env:USERPROFILE '\.aistatus\\marks'/);
  assert.match(PS1, /\$body\.Length -gt 262144/);
  assert.match(PS1, /foreach \(\$k in @\('agent_id', 'notification_type', 'tool_name', 'cwd'\)\)/);
  assert.match(PS1, /if \(\$body\.Length -gt 0 -and \$mode\)/, 'nothing is sent for skipped events');
  assert.doesNotMatch(PS1, /\$event\b/i, '$Event is an automatic variable in PowerShell; not used');
  assert.doesNotMatch(PS1, /ConvertFrom-Json[^\n]*\$text/, 'payload is not parsed with ConvertFrom-Json (2 MB limit in 5.1)');
  assert.match(PS1, /\$mode = ''\ntry \{/, '$mode initialised before the try');
  // Set-Mark / Clear-Mark swallow their own errors so a marker problem never drops an event
  for (const fn of ['Set-Mark', 'Clear-Mark']) assert.match(PS1, new RegExp(`function ${fn} \\{\\s*try \\{`));
  // the same thresholds as the Mac script
  assert.match(SH, /"\$\{#body\}" -gt 262144/);
  assert.match(SH, /for k in agent_id notification_type tool_name cwd; do/);
});

test('Windows installer: -BaseUrl may carry a path (cloud hub), check uses an ignored event', () => {
  assert.match(INSTALL_PS1, /return \(\$u\.GetLeftPart\(\[System\.UriPartial\]::Authority\) \+ \$u\.AbsolutePath\)\.TrimEnd\('\/'\)/);
  assert.doesNotMatch(INSTALL_PS1, /AbsolutePath -ne '\/'/, 'paths are no longer refused');
  assert.match(INSTALL_PS1, /"hook_event_name":"AIStatusCheck"/);
  assert.equal(normalizeHook('codex', { session_id: 'aistatus-install-check', hook_event_name: 'AIStatusCheck' }), null, 'hub ignores the check event');
  assert.match(INSTALL_PS1, /404 \{ Write-Warning/);
});
