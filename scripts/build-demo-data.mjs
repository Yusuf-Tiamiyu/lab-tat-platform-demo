// Runs the dashboard's own ETL (src/lib/processExcel.js) over a folder of weekly
// LIS-style workbooks and writes the result as static JSON in public/data/,
// table by table, exactly as an upload would have written them to Supabase.
//
//   node scripts/build-demo-data.mjs <folder of .xlsx exports>
import fs from 'node:fs';
import path from 'node:path';
import { processExcelFile } from '../src/lib/processExcel.js';

const SRC = process.argv[2];
const OUT = path.resolve('public/data');
if (!SRC) throw new Error('usage: node scripts/build-demo-data.mjs <exports folder>');

// Same table ↔ payload pairs as the upload in App.jsx
const TABLES = {
  weekly_kpi: 'summary', weekly_daily: 'daily', weekly_daily_site: 'dailySite',
  weekly_daily_site_dept: 'dailySiteDept', weekly_daily_test: 'dailyTest', weekly_routes: 'routes',
  weekly_dq: 'dataQuality', weekly_referral: 'referral', weekly_hourly: 'hourly',
  weekly_hourly_site: 'hourlySite', weekly_hourly_site_dept: 'hourlySiteDept',
  weekly_shift_breakdown: 'shiftBreakdown', weekly_failures_detail: 'failuresDetail',
};
// Small enough to ship whole; everything else is split into one file per week
const WHOLE = ['weekly_kpi', 'weekly_daily', 'weekly_daily_site', 'weekly_daily_site_dept'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// Two decimals is more precision than any figure on screen uses
const round = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
const json = rows => JSON.stringify(rows, round);

const whole = Object.fromEntries(WHOLE.map(t => [t, []]));
const weeks = [];

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.xlsx')).sort();
for (const f of files) {
  const buf = fs.readFileSync(path.join(SRC, f));
  const out = processExcelFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ws = out.summary.week_start;
  weeks.push({ week_start: ws, week_end: out.summary.week_end, week_label: out.summary.week_label });
  for (const [table, key] of Object.entries(TABLES)) {
    const rows = Array.isArray(out[key]) ? out[key] : (out[key] ? [out[key]] : []);
    if (WHOLE.includes(table)) { whole[table].push(...rows); continue; }
    fs.mkdirSync(path.join(OUT, table), { recursive: true });
    fs.writeFileSync(path.join(OUT, table, `${ws}.json`), json(rows));
  }
  console.log(`${f}: ${out.summary.total_tests.toLocaleString()} tests, week ${out.summary.week_label}`);
}
for (const t of WHOLE) fs.writeFileSync(path.join(OUT, `${t}.json`), json(whole[t]));
const perWeek = Object.keys(TABLES).filter(t => !WHOLE.includes(t));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ weeks, perWeek }, null, 1));
console.log(`${weeks.length} weeks written to ${OUT}`);
