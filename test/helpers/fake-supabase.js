// A small stand-in for a supabase-js v2 client talking to PostgREST, covering
// exactly the calls src/hub/supabase-storage.js makes:
//   from(t).select(cols).eq(c, v).maybeSingle()
//   from(t).select(cols).limit(n)
//   from(t).insert(row)                                  -> 23505 on duplicate id
//   from(t).update(patch).eq(..).eq(..).select(cols)     -> affected rows
//   from(t).delete().eq(..).eq(..).select(cols)          -> affected rows
// Each statement is atomic (like one PostgREST request = one transaction) and
// resolves after a random delay, so concurrent statements interleave.
// Unsupported calls throw, so the storage cannot silently rely on more.

export class FakeSupabase {
  constructor({ latencyMs = () => Math.random() * 2 } = {}) {
    this.tables = new Map();
    this.latencyMs = latencyMs;
    this.calls = [];
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  from(name) {
    return new Query(this, name);
  }
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.tableName = table;
    this.op = null;
    this.filters = [];
    this.cols = null;
    this.returning = false;
    this.single = false;
    this.max = null;
  }

  select(cols = '*') {
    if (this.op === null) this.op = 'select';
    else this.returning = true;
    this.cols = cols;
    return this;
  }
  insert(row) {
    this.op = 'insert';
    this.payload = row;
    return this;
  }
  update(patch) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col, val) {
    this.filters.push([col, val]);
    return this;
  }
  limit(n) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  project(row) {
    if (!this.cols || this.cols === '*') return structuredClone(row);
    const out = {};
    for (const c of this.cols.split(',').map((x) => x.trim())) out[c] = structuredClone(row[c]);
    return out;
  }

  matches(row) {
    return this.filters.every(([c, v]) => row[c] === v);
  }

  run() {
    const t = this.db.table(this.tableName);
    this.db.calls.push({ op: this.op, table: this.tableName, filters: this.filters.map((f) => f[0]) });
    switch (this.op) {
      case 'select': {
        let rows = [...t.values()].filter((r) => this.matches(r));
        if (this.max != null) rows = rows.slice(0, this.max);
        if (this.single) {
          if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
          return { data: rows[0] ? this.project(rows[0]) : null, error: null };
        }
        return { data: rows.map((r) => this.project(r)), error: null };
      }
      case 'insert': {
        const row = structuredClone(this.payload);
        if (!row.id) return { data: null, error: { code: '23502', message: 'null value in column "id"' } };
        if (t.has(row.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        t.set(row.id, row);
        return { data: this.returning ? [this.project(row)] : null, error: null };
      }
      case 'update': {
        if (!this.filters.length) throw new Error('fake: UPDATE without a filter');
        const hit = [...t.values()].filter((r) => this.matches(r));
        for (const r of hit) Object.assign(r, structuredClone(this.payload));
        return { data: this.returning ? hit.map((r) => this.project(r)) : null, error: null };
      }
      case 'delete': {
        if (!this.filters.length) throw new Error('fake: DELETE without a filter');
        const hit = [...t.values()].filter((r) => this.matches(r));
        for (const r of hit) t.delete(r.id);
        return { data: this.returning ? hit.map((r) => this.project(r)) : null, error: null };
      }
      default:
        throw new Error(`fake: unsupported operation ${this.op}`);
    }
  }

  then(resolve, reject) {
    const ms = this.db.latencyMs();
    return new Promise((r) => setTimeout(r, ms))
      .then(() => this.run())
      .then(resolve, reject);
  }
}
