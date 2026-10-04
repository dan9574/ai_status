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

export const SESSIONS_TABLE = 'aistatus_sessions';

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

export function supabaseStorage(client, { table = SESSIONS_TABLE, now = () => Date.now() } = {}) {
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
