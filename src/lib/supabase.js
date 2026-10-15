// Demo backend. The production build talks to Supabase (Postgres + Auth with
// row-level security). This public demo has no database: it serves the same
// tables as static JSON, produced by scripts/build-demo-data.mjs from synthetic
// weekly LIS exports, through a small stand-in for the parts of the
// supabase-js query builder the dashboard uses.
//
// Large per-week tables are split into one file per week, so opening a week
// downloads only that week, the same way the production queries filter by
// week_start on the server.

const BASE = `${import.meta.env.BASE_URL}data/`;
const cache = new Map();

async function loadJson(file) {
  if (!cache.has(file)) {
    cache.set(file, fetch(BASE + file).then(r => (r.ok ? r.json() : [])));
  }
  return cache.get(file);
}

let manifestPromise;
const manifest = () => (manifestPromise ||= loadJson('manifest.json'));

async function rowsFor(table, filters) {
  const m = await manifest();
  if (!m.perWeek.includes(table)) return loadJson(`${table}.json`);
  const eqWeek = filters.find(f => f.op === 'eq' && f.col === 'week_start');
  let weeks = m.weeks;
  if (eqWeek) weeks = weeks.filter(w => w.week_start === eqWeek.val);
  const gte = filters.find(f => f.op === 'gte' && f.col === 'date');
  const lt = filters.find(f => f.op === 'lt' && f.col === 'date');
  if (gte) weeks = weeks.filter(w => w.week_end >= gte.val);
  if (lt) weeks = weeks.filter(w => w.week_start < lt.val);
  const parts = await Promise.all(weeks.map(w => loadJson(`${table}/${w.week_start}.json`)));
  return parts.flat();
}

const OPS = {
  eq:  (a, b) => a === b,
  gte: (a, b) => a >= b,
  gt:  (a, b) => a > b,
  lte: (a, b) => a <= b,
  lt:  (a, b) => a < b,
};

class Query {
  constructor(table) {
    this.table = table; this.filters = []; this.orders = [];
    this.from_ = null; this.to_ = null; this.limit_ = null; this.single = false; this.write = null;
  }
  select() { return this; }
  eq(col, val)  { this.filters.push({ op:'eq',  col, val }); return this; }
  gte(col, val) { this.filters.push({ op:'gte', col, val }); return this; }
  gt(col, val)  { this.filters.push({ op:'gt',  col, val }); return this; }
  lte(col, val) { this.filters.push({ op:'lte', col, val }); return this; }
  lt(col, val)  { this.filters.push({ op:'lt',  col, val }); return this; }
  or()          { this.filters.push({ op:'none' }); return this; }
  order(col, opts = {}) { this.orders.push({ col, asc: opts.ascending !== false }); return this; }
  range(a, b)   { this.from_ = a; this.to_ = b; return this; }
  limit(n)      { this.limit_ = n; return this; }
  maybeSingle() { this.single = true; return this; }
  delete()      { this.write = 'delete'; return this; }
  upsert()      { this.write = 'upsert'; return this; }
  insert()      { this.write = 'insert'; return this; }

  async run() {
    if (this.write) return { data: null, error: { message: 'Uploading is turned off in this demo.' } };
    if (this.table === 'app_uploaders') return { data: null, error: null };
    let rows = await rowsFor(this.table, this.filters);
    for (const f of this.filters) {
      rows = f.op === 'none' ? [] : rows.filter(r => OPS[f.op](r[f.col], f.val));
    }
    if (this.orders.length) {
      rows = [...rows].sort((x, y) => {
        for (const { col, asc } of this.orders) {
          if (x[col] === y[col]) continue;
          if (x[col] == null) return 1;
          if (y[col] == null) return -1;
          return (x[col] < y[col] ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    if (this.from_ != null) rows = rows.slice(this.from_, this.to_ + 1);
    if (this.limit_ != null) rows = rows.slice(0, this.limit_);
    if (this.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  then(resolve, reject) { return this.run().then(resolve, reject); }
}

const DEMO_SESSION = { user: { id: 'demo-viewer', email: 'demo@example.com' } };
const disabled = async () => ({ data: null, error: { message: 'Accounts are turned off in this demo.' } });

export const supabase = {
  from: table => new Query(table),
  auth: {
    getSession: async () => ({ data: { session: DEMO_SESSION } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: async () => ({ data: { session: DEMO_SESSION }, error: null }),
    signOut: async () => ({ error: null }),
    updateUser: disabled,
    resetPasswordForEmail: disabled,
  },
};

// Unchanged from production: page through results with .range() until a short
// page comes back, rather than trusting one request to return every row.
export async function fetchAllRows(queryFactory, pageSize = 1000) {
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) return { data: all, error };
    all = all.concat(data || []);
    if (!data || data.length < pageSize) return { data: all, error: null };
    from += pageSize;
  }
}
