#!/usr/bin/env node
// Build the Supabase Edge Function from the single source of truth in src/:
//   src/core.js                  state machine (shared with the Node daemon)
//   src/hub/supabase-storage.js  storage on the Postgres table
//   src/hub/handler.js           HTTP routes, auth, compare-and-swap loop
//   src/hub/deno-entry.js        Deno.env / createClient / Deno.serve
// into ONE file, supabase/functions/aistatus/index.ts, so it can be pasted into
// the dashboard's function editor as is (or deployed with the Supabase CLI).
// The modules are concatenated with their local imports and `export`
// keywords removed; the code itself is unchanged.
//
//   node scripts/build-supabase.mjs           write the file
//   node scripts/build-supabase.mjs --check   exit 1 if it is out of date
// test/hub-bundle.test.js fails when the committed file is out of date.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = path.join(ROOT, 'supabase', 'functions', 'aistatus', 'index.ts');
export const SOURCES = ['src/core.js', 'src/hub/supabase-storage.js', 'src/hub/handler.js', 'src/hub/deno-entry.js'];
export const SUPABASE_JS_IMPORT = "import { createClient } from 'npm:@supabase/supabase-js@2';";

function strip(file, text) {
  // Local imports (single- or multi-line) between the bundled modules.
  let out = text.replace(/^import\s+(?:[^;]*?\s+from\s+)?'\.{1,2}\/[^']+';\n/gms, '');
  out = out.replace(/^export (?=(?:async function|function|const|let|class) )/gm, '');
  const leftover = /^\s*(?:import|export)\b.*$/m.exec(out);
  if (leftover) throw new Error(`${file}: cannot bundle this statement: ${leftover[0]}`);
  return out.trimEnd() + '\n';
}

export function bundle() {
  const parts = [
    '// @ts-nocheck',
    '// GENERATED FILE - do not edit. Built by scripts/build-supabase.mjs from',
    `// ${SOURCES.join(', ')}.`,
    '// Supabase Edge Function "aistatus": the aistatus hub (hooks in, watch reads).',
    '// Deploy: paste this whole file into the function editor of the Supabase',
    '// dashboard, with "Verify JWT" turned OFF (the function checks its own Bearer',
    '// tokens). See README.md, section "云端中转（Supabase）".',
    SUPABASE_JS_IMPORT,
    '',
  ];
  for (const rel of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    parts.push(`// ===== ${rel} ${'='.repeat(Math.max(3, 70 - rel.length))}`);
    parts.push(strip(rel, text));
  }
  return parts.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = bundle();
  if (process.argv.includes('--check')) {
    let cur = null;
    try {
      cur = fs.readFileSync(OUTPUT, 'utf8');
    } catch {
      /* missing */
    }
    if (cur !== text) {
      console.error(`${path.relative(ROOT, OUTPUT)} is out of date: run node scripts/build-supabase.mjs`);
      process.exit(1);
    }
    console.log(`${path.relative(ROOT, OUTPUT)} is up to date`);
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, text);
    console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${text.length} bytes)`);
  }
}
