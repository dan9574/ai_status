// In-memory hub storage with the same semantics as the Postgres table used by
// src/hub/supabase-storage.js (supabase/schema.sql): one row per session id,
// a version that starts at 1 and grows by one per write, and conditional
// writes that are atomic per statement:
//   put(id, null, state)  ~ INSERT ... (fails if the id exists: unique violation)
//   put(id, v, state)     ~ UPDATE ... WHERE id = $id AND version = $v
//   remove(id, v)         ~ DELETE ... WHERE id = $id AND version = $v
// Every call yields to the event loop first (like a network round trip), so
// concurrent requests really interleave between their read and their write.
// Used by the tests and by src/hub/node-server.js.

const tick = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

export class MemoryStorage {
  /** latencyMs: delay before each operation (number or () => number). */
  constructor({ latencyMs = 0 } = {}) {
    this.rows = new Map();
    this.latencyMs = latencyMs;
    this.ops = { get: 0, list: 0, put: 0, remove: 0, conflicts: 0 };
  }

  async _wait() {
    await tick(typeof this.latencyMs === 'function' ? this.latencyMs() : this.latencyMs);
  }

  async get(id) {
    this.ops.get++;
    await this._wait();
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async list() {
    this.ops.list++;
    await this._wait();
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  async put(id, expectedVersion, state) {
    this.ops.put++;
    await this._wait();
    const cur = this.rows.get(id);
    if (expectedVersion == null) {
      if (cur) {
        this.ops.conflicts++;
        return false;
      }
      this.rows.set(id, { id, state: structuredClone(state), version: 1 });
      return true;
    }
    if (!cur || cur.version !== expectedVersion) {
      this.ops.conflicts++;
      return false;
    }
    this.rows.set(id, { id, state: structuredClone(state), version: expectedVersion + 1 });
    return true;
  }

  async remove(id, expectedVersion) {
    this.ops.remove++;
    await this._wait();
    const cur = this.rows.get(id);
    if (!cur || cur.version !== expectedVersion) {
      this.ops.conflicts++;
      return false;
    }
    this.rows.delete(id);
    return true;
  }
}

/**
 * The same interface WITHOUT the version check (last write wins). Only for the
 * test that proves the race is real: concurrent hooks lose updates with it.
 */
export class UnsafeMemoryStorage extends MemoryStorage {
  async put(id, _expected, state) {
    this.ops.put++;
    await this._wait();
    const cur = this.rows.get(id);
    this.rows.set(id, { id, state: structuredClone(state), version: (cur?.version ?? 0) + 1 });
    return true;
  }
  async remove(id) {
    this.ops.remove++;
    await this._wait();
    this.rows.delete(id);
    return true;
  }
}
