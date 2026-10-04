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
