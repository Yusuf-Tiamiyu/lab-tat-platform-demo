/**
 * processExcel.js — v7
 *
 * Rewritten following the September 2026 analytical audit. The headline change
 * is architectural: every aggregate grain now stores raw COUNTS and SUMS
 * (passed / failed / measured / tat_sum / tat_n / …) rather than only
 * pre-computed percentages and averages.
 *
 * Why that matters: the previous schema stored e.g. `shipped_compliance_pct`
 * and `shipped_tests`, and the dashboard then had to reconstruct rates when
 * aggregating across days, sites or departments. Because `shipped_passed` was
 * counted over the physically-received population while `shipped_tests`
 * counted all non-local tests, every such reconstruction divided one
 * population by another and produced a rate up to 15.8 points too low — and a
 * *different* wrong answer depending on which filter path the user took.
 * Storing counts makes aggregation associative: sum the numerators, sum the
 * denominators, divide once at the end. There is exactly one correct answer
 * and no filter path can produce another.
 *
 * DEFINITIONS (unchanged from v6 — these were correct):
 *   isLocal    = originating req prefix matches performing site   (Ver-Ent clock)
 *   isShipped  = has SiteRecDate, i.e. physically transported     (Ver-Rec clock)
 *   non-local  = !isLocal  (includes shipped + non-local without a receipt time)
 *
 *   OVERALL compliance : Ver-Ent <= Target, over all measurable tests
 *   LOCAL compliance   : Ver-Ent <= Target, over measurable local tests
 *   SHIPPED compliance : Ver-Rec <= Target, over measurable physically-received tests
 *
 * INVARIANT: local_tests + shipped_tests = total_tests, always.
 *
 * CHANGED IN v7:
 *   1. Unmeasurable rows (missing Ver-Ent or Target) are excluded from
 *      compliance instead of being silently scored as FAILURES. They are
 *      counted in `unmeasured_tests` and surfaced on the Data Quality tab.
 *   2. Failure severity bands (marginal / moderate / severe / critical) are
 *      computed at every grain.
 *   3. The >1 hour threshold on the failure register is GONE. Every failure
 *      is recorded. It previously hid 22.3% of all failures, and 100% of some
 *      sites' failures.
 *   4. `weekly_failures_detail` is now complete (one row per failing test,
 *      including repeats) rather than de-duplicated to the worst per test.
 *   5. Zero-TAT tests are counted separately at every grain so the dashboard
 *      can show compliance with and without them, instead of silently
 *      counting them as passes.
 *   6. A per-day test-level grain (`dailyTest`) exists, which is what makes
 *      monthly Top Tests, monthly failure export and test multi-select
 *      possible at all.
 *   7. Departments are normalised: blank, null and the literal "N/A" all fold
 *      into a single "Unassigned" bucket.
 */
import * as XLSX from "xlsx";

// Rows with a blank/missing Department field must still be counted somewhere,
// the same way every row is always counted under some site. Every department
// grouping in this file uses this bucket instead of silently dropping the row
// — a silent drop is what caused department-level totals to fall short of
// Total Tests while site-level totals (which don't depend on department)
// stayed correct.
const UNASSIGNED_DEPT = "Unassigned";

// The source data carries at least three spellings of "no department":
// null, empty string, and the literal text "N/A". They were previously
// treated as three distinct departments, so one real bucket appeared three
// times in dropdowns and split its own totals. Normalise on the way in.
function normDept(raw) {
  if (raw == null) return UNASSIGNED_DEPT;
  const s = String(raw).trim();
  if (!s || s.toUpperCase() === "N/A" || s.toUpperCase() === "NULL" || s === "?") return UNASSIGNED_DEPT;
  return s;
}

// Demo build: fictional sites. Every performing-site code must also appear in
// PREFIX_MAP, or a site could originate work but never be credited with
// performing it, and site totals would silently fall short of Total Tests.
export const SITE_MAP = {
  8101:"Central",8102:"Harbour",8103:"Northgate",8104:"Riverside",8105:"Eastfield",
  8106:"Hilltop",8107:"Lakeside",8108:"Westbrook",8109:"Parkview",
};

// Any performing-site code not in SITE_MAP resolves here rather than to null.
// The bug above was only possible because unknown codes had nowhere to go; a
// named bucket means an unrecognised code shows up as a visible "Unmapped"
// row that someone can act on, instead of quietly reducing every site total.
const UNMAPPED_SITE = "Unmapped site";
const PREFIX_MAP = {
  "8101":"Central","8102":"Harbour","8103":"Northgate","8104":"Riverside","8105":"Eastfield",
  "8106":"Hilltop","8107":"Lakeside","8108":"Westbrook","8109":"Parkview",
};
const SITE_24HR = new Set(["Central","Harbour","Northgate"]);
const EXCEL_EPOCH_MS = Date.UTC(1899,11,30);

// Date sanity limits. See the "Date sanity check" block in processExcelFile.
// 14 days is more than double the furthest any genuine entry has sat from the
// middle of its weekly file (5.9 days, measured across all 2026 workbooks).
export const DATE_WINDOW_FLOOR_DAYS = 14;
const EARLIEST_PLAUSIBLE_YEAR = 2020;
// Above this share of unusable dates, the file is refused rather than
// uploaded with gaps. A handful of mistyped dates is normal LIS noise; one row
// in a hundred means the date column itself has been damaged.
export const MAX_BAD_DATE_SHARE_PCT = 1;

// ── Failure severity banding ──────────────────────────────────────────────
// Severity is deliberately BOTH absolute and relative. Thirty minutes late on
// a 3-hour test and thirty minutes late on a 72-hour test are not the same
// operational event, and a purely absolute scale would rank the second as
// more serious than it is. The relative test is applied first, so anything
// within 15% of its own target counts as marginal regardless of clock time;
// past that, absolute thresholds decide.
//
// The bands map to distinct operational responses, which is the point of
// having them at all:
//   marginal → process tightening (batching, verification timing)
//   moderate → workflow review (handover, courier, instrument queue)
//   severe   → escalate (usually a specific incident on a specific day)
//   critical → investigate individually
export const FAIL_BANDS = ["marginal", "moderate", "severe", "critical"];
export const FAIL_BAND_LABELS = {
  marginal: "Marginal (≤ 30 min or ≤ 15% over)",
  moderate: "Moderate (31 min – 3 h)",
  severe:   "Severe (3 – 12 h)",
  critical: "Critical (> 12 h)",
};
export function failBand(overrunMins, targetMins) {
  if (overrunMins == null || overrunMins <= 0) return null;
  const relPct = targetMins > 0 ? (overrunMins / targetMins) * 100 : Infinity;
  if (overrunMins <= 30 || relPct <= 15) return "marginal";
  if (overrunMins <= 180) return "moderate";
  if (overrunMins <= 720) return "severe";
  return "critical";
}

function getShift(hour, siteName) {
  if (hour >= 8  && hour < 14) return "Morning (8am-2pm)";
  if (hour >= 14 && hour < 16) return "Handover (2pm-4pm)";
  if (hour >= 16 && hour < 20) return "Afternoon (4pm-8pm)";
  return SITE_24HR.has(siteName) ? "Night (8pm-8am)" : "Outside Hours";
}
function excelSerial(s) {
  if (s==null||typeof s!=="number"||s<=1) return null;
  return new Date(EXCEL_EPOCH_MS+s*86400*1000);
}
function tdToMins(v) { return (v==null||typeof v!=="number")?null:v*24*60; }
function getOrigSite(req) {
  const s=String(req).replace(/\.0$/,""), p=s.slice(0,4);
  if (PREFIX_MAP[p]) return PREFIX_MAP[p];
  return "Unknown";
}
function groupBy(arr,fn) {
  return arr.reduce((a,x)=>{const k=String(fn(x));if(!a[k])a[k]=[];a[k].push(x);return a;},{});
}
// medianVal / pctile now take an ALREADY-FILTERED array of real numbers.
// The previous versions were called with `verEntMins ?? 0`, which substituted
// zero for missing data and dragged both statistics toward zero.
function pctile(arr,p) { if(!arr.length) return null; const s=[...arr].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(s.length*p))]; }
function medianVal(arr) { if(!arr.length) return null; const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function r2(n) { return n==null||!isFinite(n)?null:parseFloat(n.toFixed(2)); }
function r1(n) { return n==null||!isFinite(n)?null:parseFloat(n.toFixed(1)); }
function toDate(d) { return d?new Date(d).toISOString().split("T")[0]:null; }
// A getWeekStart() helper used to live here, snapping every week to a
// Monday-aligned calendar grid. It was removed: this lab's weeks don't run
// Mon-Sun (uploads start on Fri, Fri, Mon, Mon in practice), so snapping
// could push a week's start date into the previous month even when none of
// its data belonged there. week_start is now simply the upload's own
// earliest date — see wkStart below.
function weekLabel(a,b) {
  const MO=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const da=new Date(a),db=new Date(b);
  if(da.getUTCMonth()===db.getUTCMonth()&&da.getUTCFullYear()===db.getUTCFullYear())
    return `${da.getUTCDate()}–${db.getUTCDate()} ${MO[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
  return `${da.getUTCDate()} ${MO[da.getUTCMonth()].slice(0,3)} – ${db.getUTCDate()} ${MO[db.getUTCMonth()].slice(0,3)} ${db.getUTCFullYear()}`;
}

// ── THE single statistics kernel ──────────────────────────────────────────
// Every grain in this file — network, site, department, day, day×site,
// day×site×dept, day×test, shift, route — is computed by calling this one
// function on a subset of rows. That is deliberate. In v6 each grain
// re-implemented its own counting, which is how the shipped-compliance
// denominator ended up correct in one place and wrong in three others.
//
// It returns counts and sums, never only rates. Rates are derived at the end
// (and re-derived identically in the dashboard when aggregating), so
// aggregating across any combination of grains is exact rather than a
// weighted approximation.
function statsFor(rows) {
  const s = {
    total_tests: rows.length,
    // OVERALL (Ver-Ent, all tests)
    measured_tests: 0, unmeasured_tests: 0,
    passed: 0, failed: 0, zero_tat_tests: 0,
    tat_sum_mins: 0, tat_n: 0,
    fail_marginal: 0, fail_moderate: 0, fail_severe: 0, fail_critical: 0,
    overrun_sum_mins: 0,
    // LOCAL (Ver-Ent, local tests only)
    local_tests: 0, local_measured: 0, local_passed: 0, local_failed: 0,
    local_zero_tat: 0, local_tat_sum_mins: 0, local_tat_n: 0,
    // Severity bands for local failures specifically. Without these, any
    // screen showing a severity breakdown under a "Local only" filter would
    // have to fall back to the all-tests bands, and the breakdown would not
    // add up to the local failure count sitting next to it.
    local_fail_marginal: 0, local_fail_moderate: 0, local_fail_severe: 0, local_fail_critical: 0,
    // SHIPPED (Ver-Rec, physically received tests only)
    shipped_tests: 0,        // non-local volume — classification, not the compliance base
    shipped_rec_count: 0,    // physically received (has SiteRecDate)
    shipped_measured: 0,     // received AND has both Ver-Rec and Target — the compliance base
    shipped_passed: 0, shipped_failed: 0,
    shipped_tat_sum_mins: 0, shipped_tat_n: 0,
    shipped_fail_marginal: 0, shipped_fail_moderate: 0, shipped_fail_severe: 0, shipped_fail_critical: 0,
    transport_sum_mins: 0, transport_n: 0,
  };
  const bandKey = { marginal:"fail_marginal", moderate:"fail_moderate", severe:"fail_severe", critical:"fail_critical" };
  const locBandKey = { marginal:"local_fail_marginal", moderate:"local_fail_moderate", severe:"local_fail_severe", critical:"local_fail_critical" };
  const shBandKey = { marginal:"shipped_fail_marginal", moderate:"shipped_fail_moderate", severe:"shipped_fail_severe", critical:"shipped_fail_critical" };

  for (const r of rows) {
    // ---- Ver-Ent clock (overall + local) ----
    if (r.verEntMins != null) { s.tat_sum_mins += r.verEntMins; s.tat_n++; }
    if (r.isLocal) {
      s.local_tests++;
      if (r.verEntMins != null) { s.local_tat_sum_mins += r.verEntMins; s.local_tat_n++; }
    } else {
      s.shipped_tests++;
    }
    if (r.metOverall == null) {
      s.unmeasured_tests++;
    } else {
      s.measured_tests++;
      if (r.verEntMins === 0) s.zero_tat_tests++;
      if (r.isLocal) {
        s.local_measured++;
        if (r.verEntMins === 0) s.local_zero_tat++;
      }
      if (r.metOverall === true) {
        s.passed++;
        if (r.isLocal) s.local_passed++;
      } else {
        s.failed++;
        if (r.isLocal) s.local_failed++;
        const ov = r.verEntMins - r.targetMins;
        s.overrun_sum_mins += ov;
        const b = failBand(ov, r.targetMins);
        if (b) { s[bandKey[b]]++; if (r.isLocal) s[locBandKey[b]]++; }
      }
    }
    // ---- Ver-Rec clock (shipped) ----
    if (r.isShipped) {
      s.shipped_rec_count++;
      if (r.verRecMins != null) { s.shipped_tat_sum_mins += r.verRecMins; s.shipped_tat_n++; }
      if (r.transportMins != null) { s.transport_sum_mins += r.transportMins; s.transport_n++; }
      if (r.metShipped != null) {
        s.shipped_measured++;
        if (r.metShipped === true) s.shipped_passed++;
        else {
          s.shipped_failed++;
          const b = failBand(r.verRecMins - r.targetMins, r.targetMins);
          if (b) s[shBandKey[b]]++;
        }
      }
    }
  }
  return s;
}

// Derive the display rates/averages from a stats object. Kept separate from
// statsFor so the same derivation runs here (per week) and in the dashboard
// (when summing across days/sites/departments) — one formula, one answer.
function derive(s) {
  return {
    ...s,
    compliance_pct:          s.measured_tests   ? r1(s.passed / s.measured_tests * 100) : null,
    // Compliance with zero-TAT records removed. Zero-TAT means verified at the
    // same instant as entry — almost always batch entry or retrospective
    // verification rather than a genuine instant result. They always score as
    // passes, so they can only ever inflate compliance. Both figures are
    // stored; the dashboard shows whichever the user has selected.
    compliance_excl_zero_pct: (s.measured_tests - s.zero_tat_tests)
      ? r1((s.passed - s.zero_tat_tests) / (s.measured_tests - s.zero_tat_tests) * 100) : null,
    local_compliance_pct:    s.local_measured   ? r1(s.local_passed / s.local_measured * 100) : null,
    // THE fix for the audit's F2/F3/F17: the shipped compliance denominator is
    // shipped_measured (received + measurable), never shipped_tests (all
    // non-local). These are different populations and dividing one by the
    // other is what produced the 15.8-point Monthly/Weekly contradiction.
    shipped_compliance_pct:  s.shipped_measured ? r1(s.shipped_passed / s.shipped_measured * 100) : null,
    avg_tat_hrs:             s.tat_n            ? r2(s.tat_sum_mins / s.tat_n / 60) : null,
    local_avg_tat_hrs:       s.local_tat_n      ? r2(s.local_tat_sum_mins / s.local_tat_n / 60) : null,
    shipped_avg_tat_hrs:     s.shipped_tat_n    ? r2(s.shipped_tat_sum_mins / s.shipped_tat_n / 60) : null,
    avg_transport_hrs:       s.transport_n      ? r2(s.transport_sum_mins / s.transport_n / 60) : null,
    avg_overrun_hrs:         s.failed           ? r2(s.overrun_sum_mins / s.failed / 60) : null,
  };
}

// Build daily aggregates for any subset of rows.
function buildDaily(subset, extra, ws_str) {
  const byDay = groupBy(subset.filter(r=>r.dateStr), r=>r.dateStr);
  return Object.entries(byDay).map(([dateStr,grp]) => {
    // Keep the actual distinct req numbers, not just their count. A monthly
    // view spans multiple days, and a patient tested on two different days
    // is one patient, not two — that can only be known by de-duplicating the
    // real IDs across days, which a per-day count alone can never recover.
    const patientIds = [...new Set(grp.map(r=>r.reqNumber).filter(Boolean))];
    return {
      week_start:ws_str, date:dateStr, day_name:grp[0].dayName,
      ...derive(statsFor(grp)),
      unique_patients:patientIds.length,   // same-day distinct count, kept for quick display
      patient_ids:patientIds,              // source of truth for any cross-day (monthly) de-dup
      ...extra,
    };
  }).sort((a,b)=>a.date.localeCompare(b.date));
}

export function processExcelFile(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer,{type:"array"});
  const ws = wb.Sheets["TAT Data"];
  if (!ws) throw new Error("Sheet \"TAT Data\" not found.");
  const raw = XLSX.utils.sheet_to_json(ws,{raw:true,defval:null});
  if (!raw.length) throw new Error("TAT Data sheet is empty.");

  const DAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const allRows = raw.map(r => {
    const entSerial  = r["EntDate & EntTime"];
    const recSerial  = r["SiteRecDate & SiteRecTime"];
    const verEntMins = tdToMins(r["Ver-Ent"]);
    const verRecMins = tdToMins(r["Ver-Rec"]);
    const targetMins = tdToMins(r["Target TAT"]);
    const isShipped  = recSerial!=null&&typeof recSerial==="number"&&recSerial>1;
    const transportMins = isShipped?(recSerial-entSerial)*24*60:null;
    const perfRaw    = r["PerfSite"]!=null?Math.round(parseFloat(r["PerfSite"])):null;
    const perfSite   = perfRaw?(SITE_MAP[perfRaw]??null):null;
    const reqStr     = String(r["Req Number"]??"").replace(/\.0$/,"");
    const origSite   = getOrigSite(reqStr);
    const isLocal    = perfSite!==null&&perfSite===origSite;
    const entDate    = excelSerial(entSerial);
    // TAT compliance. NOTE the three-state result: true (met), false (missed),
    // null (not measurable). v6 returned `false` for unmeasurable rows, which
    // scored missing data as a performance failure. With 14 such rows in the
    // reference week the practical impact was tiny, but a single week where
    // the LIS export dropped the Target TAT column for one department would
    // have reported that department at 0% compliance with nothing flagging it
    // as a data problem rather than a collapse.
    const measurableEnt = verEntMins!=null && targetMins!=null;
    const metOverall = measurableEnt ? verEntMins<=targetMins : null;
    const metShipped = (isShipped && verRecMins!=null && targetMins!=null) ? verRecMins<=targetMins : null;
    return {
      perfSiteNum:perfRaw, perfSiteName:perfSite,
      // siteKey is what every site-keyed grouping below uses. It is never
      // null, so a row can never fall out of the site dimension the way an
      // unrecognised PerfSite code used to.
      siteKey:perfSite ?? UNMAPPED_SITE,
      reqNumber:reqStr, testName:r["Test Name"], department:normDept(r["Department"]),
      entSerial, recSerial, entDate,
      verEntMins, verRecMins, targetMins, transportMins,
      isShipped, isLocal, metOverall, metShipped,
      origSite,
      dayName:entDate?DAY[entDate.getUTCDay()]:null,
      dateStr:entDate?toDate(entDate):null,
      hour:entDate?entDate.getUTCHours():null,
    };
  });

  // ── Date sanity check ───────────────────────────────────────
  // October 2026: a damaged copy of the 7–13 Sept workbook was uploaded in
  // which 1,558 rows (5.5%) had entry dates reading as anything from 2000 to
  // 2102. Two things went wrong because nothing checked them:
  //   1. Every impossible date became its own day, so the Monthly dropdown
  //      filled with months like "August 2102".
  //   2. week_start was taken as the EARLIEST date in the file. One row
  //      dated 2000 made the week "16 May 2000 – 15 Aug 2102", so it was
  //      saved as a new week instead of replacing the existing 7–13 Sept
  //      upload, and September was counted twice.
  //
  // A weekly file's real dates cluster tightly: across all eighteen 2026
  // workbooks the furthest genuine entry sat 5.9 days from the middle of its
  // file. So: find the middle (median, which a minority of bad rows cannot
  // drag), and accept dates within 14 days of it, widening automatically if a
  // longer file is uploaded. Anything outside is not this file's data.
  //
  // Bad rows are EXCLUDED rather than guessed at. A date that reads as 2069
  // cannot be repaired with confidence, and including the row anywhere would
  // put its test into a total that its day-by-day breakdown then cannot
  // match. They are counted, and the upload screen shows them before anything
  // is saved, and refuses the file outright if there are too many.
  const goodSerials = allRows
    .map(r => r.entSerial).filter(v => typeof v === "number" && v > 1).sort((a, b) => a - b);
  if (!goodSerials.length) {
    throw new Error('No usable dates were found in the "EntDate & EntTime" column. Check the file was exported from the LIS without being edited.');
  }
  const qs = p => goodSerials[Math.min(goodSerials.length - 1, Math.floor(goodSerials.length * p))];
  const medianSerial = qs(0.5);
  const windowDays = Math.max(DATE_WINDOW_FLOOR_DAYS, 4 * (qs(0.75) - qs(0.25)));
  const latestYear = new Date().getUTCFullYear() + 1;
  for (const r of allRows) {
    let ok = typeof r.entSerial === "number" && r.entSerial > 1 && r.entDate != null
          && Math.abs(r.entSerial - medianSerial) <= windowDays;
    if (ok) {
      const y = r.entDate.getUTCFullYear();
      if (y < EARLIEST_PLAUSIBLE_YEAR || y > latestYear) ok = false;
    }
    r.dateValid = ok;
  }
  const badDateRows = [];
  allRows.forEach((r, i) => { if (!r.dateValid) badDateRows.push({ r, excelRow: i + 2 }); });
  const rows = allRows.filter(r => r.dateValid);
  if (!rows.length) {
    throw new Error("None of the rows in this file have a usable entry date.");
  }

  const serials = rows.map(r => r.entSerial);
  const minDate = excelSerial(Math.min(...serials));
  const maxDate = excelSerial(Math.max(...serials));
  const wkStart = minDate; // the earliest VALID date in the file, never rounded to a different calendar day
  const wkEnd   = maxDate;
  const ws_str  = toDate(wkStart);

  // Reported to the upload screen so the person uploading sees exactly what
  // will be left out, with spreadsheet row numbers they can look up.
  const dateCheck = {
    rowsInFile: allRows.length,
    usedRows: rows.length,
    invalid: badDateRows.length,
    share: allRows.length ? +(badDateRows.length / allRows.length * 100).toFixed(2) : 0,
    window: { start: toDate(excelSerial(medianSerial - windowDays)), end: toDate(excelSerial(medianSerial + windowDays)) },
    samples: badDateRows.slice(0, 5).map(({ r, excelRow }) => ({
      excelRow,
      reqNumber: r.reqNumber,
      readAs: r.entDate ? toDate(r.entDate) : (r.entSerial == null ? "blank" : String(r.entSerial)),
    })),
  };

  const shippedRows = rows.filter(r=>r.isShipped);  // has SiteRecDate

  // ── 1. KPI Summary ─────────────────────────────────────────
  const netStats = derive(statsFor(rows));
  const summary = {
    week_start:ws_str, week_end:toDate(wkEnd),
    week_label:weekLabel(minDate,maxDate),
    total_patients:new Set(rows.map(r=>r.reqNumber)).size,
    ...netStats,
    // Legacy aliases kept so nothing downstream that still reads the old
    // column names breaks mid-migration.
    overall_compliance_pct: netStats.compliance_pct,
    overall_passed:         netStats.passed,
    overall_failed:         netStats.failed,
    avg_overall_tat_hrs:    netStats.avg_tat_hrs,
    total_shipped:          netStats.shipped_rec_count,
  };

  // ── 2. Sites ────────────────────────────────────────────────
  // Driven by the sites PRESENT IN THE DATA, not by the SITE_MAP constant.
  // Iterating the constant meant any code missing from it produced no bucket
  // at all, so its rows disappeared from the site dimension silently. Driving
  // from the data guarantees sum(sites.total_tests) === total_tests for every
  // upload, whatever codes turn up in it.
  const rowsBySite = groupBy(rows, r=>r.siteKey);
  const siteKeys = Object.keys(rowsBySite).sort();
  const sites = siteKeys.map(name => {
    const sd = rowsBySite[name];
    const st = derive(statsFor(sd));
    return {
      week_start:ws_str, site:name,
      unique_patients:new Set(sd.map(r=>r.reqNumber)).size,
      ...st,
      shipped_in_tests: st.shipped_tests,   // legacy alias: !isLocal — local + shipped_in = total, always
      shipped_analytical_comp_pct: st.shipped_compliance_pct, // legacy alias
      workload_pct:r1(sd.length/rows.length*100),
    };
  });

  // ── 3. Departments (network) ────────────────────────────────
  // Every row lands in exactly one department bucket, same as it lands in
  // exactly one site bucket above — a row with a blank/missing/"N/A"
  // department goes to "Unassigned" rather than being dropped.
  const deptGrps = groupBy(rows,r=>r.department);
  const departments = Object.entries(deptGrps).map(([dept,grp]) => ({
    week_start:ws_str, department:dept,
    unique_patients:new Set(grp.map(r=>r.reqNumber)).size,
    ...derive(statsFor(grp)),
  })).sort((a,b)=>b.total_tests-a.total_tests);

  // ── 4. Network daily ────────────────────────────────────────
  const daily = buildDaily(rows,{},ws_str);

  // ── 5. Per-site daily ───────────────────────────────────────
  const dailySite = [];
  for (const siteName of siteKeys) {
    buildDaily(rowsBySite[siteName],{perf_site:siteName},ws_str).forEach(d=>dailySite.push(d));
  }

  // ── 6. Per-site per-dept daily ──────────────────────────────
  const dailySiteDept = [];
  for (const siteName of siteKeys) {
    for (const [dept,grp] of Object.entries(groupBy(rowsBySite[siteName],r=>r.department))) {
      buildDaily(grp,{perf_site:siteName,department:dept},ws_str).forEach(d=>dailySiteDept.push(d));
    }
  }

  // ── 6b. Per-day per-test grain ──────────────────────────────
  // New in v7. Without a day-level test grain, "Top Tests" and the failure
  // export could only ever describe a single upload week — a monthly view of
  // either was impossible, and test could not be offered as a filter at all
  // because there was nothing to aggregate across days. Patient ids are
  // deliberately NOT stored here; this grain exists for volume and compliance
  // only, and carrying id arrays at test grain would balloon the table.
  const dailyTest = [];
  for (const [key,grp] of Object.entries(groupBy(
        rows.filter(r=>r.dateStr),
        r=>`${r.dateStr}||${r.testName||"?"}||${r.siteKey}||${r.department}`))) {
    const [dateStr,testName,perfSite,dept] = key.split("||");
    dailyTest.push({
      week_start:ws_str, date:dateStr, test_name:testName, perf_site:perfSite, department:dept,
      day_name:grp[0].dayName,
      ...derive(statsFor(grp)),
    });
  }

  // ── 7. Per-site per-dept weekly aggregate ───────────────────
  const deptSite = [];
  for (const siteName of siteKeys) {
    for (const [dept,grp] of Object.entries(groupBy(rowsBySite[siteName],r=>r.department))) {
      deptSite.push({
        week_start:ws_str, perf_site:siteName, department:dept,
        unique_patients:new Set(grp.map(r=>r.reqNumber)).size,
        ...derive(statsFor(grp)),
      });
    }
  }

  // ── 8-10. Hourly grains ─────────────────────────────────────
  const hourlyRow = (grp) => ({
    count:grp.length,
    local_count:grp.filter(r=>r.isLocal).length,
    shipped_count:grp.filter(r=>r.isShipped).length,
    failed_count:grp.filter(r=>r.metOverall===false).length,
    measured_count:grp.filter(r=>r.metOverall!=null).length,
  });
  const hourly = Object.entries(groupBy(rows.filter(r=>r.hour!=null),r=>r.hour))
    .map(([hr,grp])=>({week_start:ws_str, hour:+hr, ...hourlyRow(grp)}))
    .sort((a,b)=>a.hour-b.hour);

  const hourlySite = [];
  for (const siteName of siteKeys) {
    const sd = rowsBySite[siteName].filter(r=>r.hour!=null);
    for (const [hr,grp] of Object.entries(groupBy(sd,r=>r.hour))) {
      hourlySite.push({week_start:ws_str,perf_site:siteName,hour:+hr,...hourlyRow(grp)});
    }
  }

  const hourlySiteDept = [];
  for (const siteName of siteKeys) {
    const sd = rowsBySite[siteName].filter(r=>r.hour!=null);
    for (const [dept,dg] of Object.entries(groupBy(sd,r=>r.department))) {
      for (const [hr,grp] of Object.entries(groupBy(dg,r=>r.hour))) {
        hourlySiteDept.push({week_start:ws_str,perf_site:siteName,department:dept,hour:+hr,...hourlyRow(grp)});
      }
    }
  }

  // ── 11. Routes ──────────────────────────────────────────────
  const routeGrps = groupBy(shippedRows.filter(r=>r.perfSiteName),r=>`${r.origSite}||${r.perfSiteName}`);
  const routes = Object.entries(routeGrps).map(([key,grp]) => {
    const [origin,destination] = key.split("||");
    const st = statsFor(grp);
    const tMins = grp.filter(r=>r.transportMins!=null).map(r=>r.transportMins);
    return {week_start:ws_str,origin,destination,count:grp.length,
      avg_transport_hrs:st.transport_n?r2(st.transport_sum_mins/st.transport_n/60):null,
      max_transport_hrs:tMins.length?r2(Math.max(...tMins)/60):null,
      median_transport_hrs:tMins.length?r2(medianVal(tMins)/60):null,
      avg_analytical_tat_hrs:st.shipped_tat_n?r2(st.shipped_tat_sum_mins/st.shipped_tat_n/60):null,
      shipped_measured:st.shipped_measured, shipped_passed:st.shipped_passed,
      analytical_compliance_pct:st.shipped_measured?r1(st.shipped_passed/st.shipped_measured*100):null};
  }).sort((a,b)=>b.count-a.count);

  // ── 12. Test failures (aggregated by test+site+dept) ────────
  // v6 discarded any group whose MEAN TAT beat its MEAN target
  // (`if (overrun <= 0) return null`) and then capped the result at 200 rows.
  // Between them those two lines deleted exactly the pattern that matters
  // most operationally: a test that is normally fine but fails
  // intermittently. Both are gone. Any group with at least one failure is
  // kept, and median overrun replaces mean-minus-mean, which was not a
  // meaningful quantity.
  const tsgGrps = groupBy(rows,r=>`${r.testName||"?"}||${r.siteKey}||${r.department}`);
  const testFailures = Object.entries(tsgGrps).map(([key,grp]) => {
    const [testName,perfSite,dept] = key.split("||");
    const st = derive(statsFor(grp));
    if (!st.failed) return null;
    const overruns = grp.filter(r=>r.metOverall===false).map(r=>r.verEntMins-r.targetMins);
    const targets  = grp.filter(r=>r.targetMins!=null).map(r=>r.targetMins);
    return {week_start:ws_str,test_name:testName,perf_site:perfSite,department:dept,
      total:st.total_tests, measured:st.measured_tests, failures:st.failed,
      compliance_pct:st.compliance_pct,
      avg_tat_hrs:st.avg_tat_hrs,
      avg_target_hrs:targets.length?r2(targets.reduce((a,b)=>a+b,0)/targets.length/60):null,
      median_overrun_hrs:r2(medianVal(overruns)/60),
      max_overrun_hrs:r2(Math.max(...overruns)/60),
      avg_overrun_hrs:st.avg_overrun_hrs,
      fail_marginal:st.fail_marginal, fail_moderate:st.fail_moderate,
      fail_severe:st.fail_severe, fail_critical:st.fail_critical};
  }).filter(Boolean).sort((a,b)=>b.failures-a.failures);

  // ── 13. Data quality ────────────────────────────────────────
  const microRows = rows.filter(r=>r.department==="Microbiology");
  const realTats  = rows.filter(r=>r.verEntMins!=null).map(r=>r.verEntMins);
  const p995 = pctile(realTats,0.995);
  // Top offenders by actual count in THIS upload's data — the Data Quality
  // tab uses these to name real names instead of hardcoded ones that go
  // stale the moment a different site/test/route becomes the problem.
  const topByCount = (arr, keyFn, n=3) => {
    const counts = {};
    arr.forEach(r => { const k = keyFn(r); if (!k) return; counts[k] = (counts[k]||0)+1; });
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([name,count])=>({name,count}));
  };
  const zeroTatRows      = rows.filter(r=>r.verEntMins===0);
  const outlierRows      = p995!=null?rows.filter(r=>r.verEntMins!=null&&r.verEntMins>p995):[];
  const longTransitRows  = shippedRows.filter(r=>r.transportMins&&r.transportMins>1440);
  const negTransitRows   = shippedRows.filter(r=>r.transportMins!=null&&r.transportMins<0);
  // Duplicate detection: the same test, on the same requisition, entered at
  // the same instant. A genuine repeat of a test is normally entered at a
  // different time, so same-instant repeats are far more likely to be an
  // export artefact. Surfaced rather than silently removed, because only the
  // lab can say which they are.
  const dupCounts = {};
  rows.forEach(r => { const k=`${r.reqNumber}||${r.testName}||${r.entSerial}`; dupCounts[k]=(dupCounts[k]||0)+1; });
  const duplicateRows = Object.values(dupCounts).reduce((a,n)=>a+(n>1?n-1:0),0);

  const dataQuality = {week_start:ws_str,
    zero_tat_count:zeroTatRows.length,
    zero_tat_sites:topByCount(zeroTatRows, r=>r.perfSiteName),
    extreme_outliers_count:outlierRows.length,
    extreme_outlier_tests:topByCount(outlierRows, r=>r.testName),
    transport_over24h:longTransitRows.length,
    transport_over48h:shippedRows.filter(r=>r.transportMins&&r.transportMins>2880).length,
    transport_negative:negTransitRows.length,
    transport_routes:topByCount(longTransitRows, r=>r.origSite&&r.perfSiteName?`${r.origSite}→${r.perfSiteName}`:null),
    micro_null_persite:microRows.filter(r=>!r.perfSiteNum).length,
    micro_total:microRows.length,
    max_tat_hrs:realTats.length?r1(Math.max(...realTats)/60):null,
    median_tat_hrs:r2(medianVal(realTats)/60),
    p95_tat_hrs:r2(pctile(realTats,0.95)/60),
    // New quality signals surfaced by the audit
    unmeasured_tests:netStats.unmeasured_tests,
    unmeasured_sites:topByCount(rows.filter(r=>r.metOverall==null), r=>r.perfSiteName),
    duplicate_rows:duplicateRows,
    unknown_origin_count:rows.filter(r=>r.origSite==="Unknown").length,
    unmapped_site_count:rows.filter(r=>!r.perfSiteName).length,
    compliance_incl_zero_pct:netStats.compliance_pct,
    compliance_excl_zero_pct:netStats.compliance_excl_zero_pct,
    // Rows left out because their entry date could not belong to this file.
    rows_in_file:allRows.length,
    invalid_date_rows:badDateRows.length,
  };

  // ── 14. Referral ────────────────────────────────────────────
  const allSites = [...new Set([...Object.values(SITE_MAP), ...rows.map(r=>r.origSite)])].filter(s=>s && s!=="Unknown").sort();
  const referral = allSites.map(s=>{
    const orig = rows.filter(r=>r.origSite===s);
    const ref  = orig.filter(r=>!r.perfSiteName||r.perfSiteName!==s);
    return {week_start:ws_str,site:s,total_originated:orig.length,
      shipped_out:ref.length,
      referral_rate_pct:orig.length?r1(ref.length/orig.length*100):0};
  });

  // ── 15. Microbiology ────────────────────────────────────────
  const microbiology = Object.entries(groupBy(microRows,r=>r.origSite))
    .filter(([k])=>k&&k!=="Unknown").map(([s,grp])=>{
      const st = derive(statsFor(grp));
      return {week_start:ws_str,site:s,count:grp.length,
        compliance_pct:st.compliance_pct, avg_tat_hrs:st.avg_tat_hrs};
    });

  // ── 15b. Top Tests — every (test, site, department) combo, by volume ──
  // Must stay uncapped: this table is the denominator source for failure-rate
  // calculations whose numerator comes from the complete failure register. A
  // capped denominator against an uncapped numerator is what produced failure
  // rates over 100% in an earlier version.
  const topTests = Object.entries(tsgGrps).map(([key, grp]) => {
    const [testName, perfSite, dept] = key.split("||");
    return {week_start:ws_str, test_name:testName, perf_site:perfSite, department:dept,
      ...derive(statsFor(grp))};
  }).sort((a,b)=>b.total_tests-a.total_tests);

  // ── 16. Failed Requests — requisition-level rollup ──────────
  // THE >1 HOUR THRESHOLD IS GONE. v6 only recorded a requisition here if some
  // test on it exceeded target by more than 60 minutes. Measured against the
  // real data that hid more than a fifth of all failures, and every failure at
  // the smallest sites — so a manager filtering to those sites saw an empty
  // table and concluded there was nothing to investigate.
  //
  // Grouped by (reqNumber, department, performing site) so each row belongs to
  // exactly one department and one site — this is what stops a Microscopy test
  // name appearing on a Serology row when a requisition spans departments.
  const reqDeptGrps = groupBy(rows, r => `${r.reqNumber}||${r.department}||${r.siteKey}`);
  const failedRequests = [];
  for (const [key, reqRows] of Object.entries(reqDeptGrps)) {
    const [reqNum, dept, perfSite] = key.split("||");
    const origSite = reqRows[0].origSite;
    const groupIsLocal = reqRows.every(r => r.isLocal);

    const ovFail = reqRows
      .filter(r => r.metOverall === false)
      .sort((a,b) => (b.verEntMins-b.targetMins)-(a.verEntMins-a.targetMins));
    const locFail = ovFail.filter(r => r.isLocal);
    const shpFail = reqRows
      .filter(r => r.metShipped === false)
      .sort((a,b) => (b.verRecMins-b.targetMins)-(a.verRecMins-a.targetMins));

    if (!ovFail.length && !shpFail.length) continue;

    const wo = ovFail[0], wl = locFail[0], ws2 = shpFail[0];
    const ovOverrun  = wo  ? wo.verEntMins - wo.targetMins   : null;
    const locOverrun = wl  ? wl.verEntMins - wl.targetMins   : null;
    const shpOverrun = ws2 ? ws2.verRecMins - ws2.targetMins : null;
    // The date of the worst failing test — without this the table cannot
    // distinguish "twenty failures on one bad Tuesday" from "twenty failures
    // spread evenly across the week", which is the entire difference between
    // an incident and a systemic problem.
    const anchor = wo || ws2;
    failedRequests.push({
        week_start:ws_str,
        date:anchor?anchor.dateStr:null,
        day_name:anchor?anchor.dayName:null,
        req_number:reqNum,
        department:dept,
        perf_site:perfSite,
        originating_site:origSite,
        is_local:groupIsLocal,
        total_tests:reqRows.length,
        // OVERALL (Ver-Ent)
        overall_worst_test:wo?.testName||null,
        overall_overrun_hrs:ovOverrun!=null?r2(ovOverrun/60):null,
        overall_overrun_pct:(wo&&wo.targetMins>0)?r1(ovOverrun/wo.targetMins*100):null,
        overall_band:wo?failBand(ovOverrun,wo.targetMins):null,
        overall_failing_tests:ovFail.length,
        // LOCAL (Ver-Ent, local tests)
        local_worst_test:wl?.testName||null,
        local_overrun_hrs:locOverrun!=null?r2(locOverrun/60):null,
        local_overrun_pct:(wl&&wl.targetMins>0)?r1(locOverrun/wl.targetMins*100):null,
        local_band:wl?failBand(locOverrun,wl.targetMins):null,
        local_failing_tests:locFail.length,
        // SHIPPED (Ver-Rec, received tests)
        shipped_worst_test:ws2?.testName||null,
        shipped_overrun_hrs:shpOverrun!=null?r2(shpOverrun/60):null,
        shipped_overrun_pct:(ws2&&ws2.targetMins>0)?r1(shpOverrun/ws2.targetMins*100):null,
        shipped_band:ws2?failBand(shpOverrun,ws2.targetMins):null,
        shipped_failing_tests:shpFail.length,
    });
  }
  failedRequests.sort((a,b) => (b.overall_overrun_hrs||0)-(a.overall_overrun_hrs||0));

  // ── 15c. Individual failures detail — one row per failed test ──
  // Complete: every failing test, including a test repeated several times on
  // the same requisition. v6 collapsed repeats to the single worst occurrence,
  // which is why the detail table held 12,868 rows against 12,933 recorded
  // failures. An `occurrence` counter makes each repeat individually
  // addressable so the register reconciles exactly with the failure KPI.
  const occSeen = new Map();
  const failuresDetail = [];
  for (const r of rows) {
    const entFail = r.metOverall === false;
    const recFail = r.metShipped === false;
    if (!entFail && !recFail) continue;
    const baseKey = `${r.reqNumber}||${r.testName||""}||${r.siteKey}`;
    const occ = (occSeen.get(baseKey) || 0) + 1;
    occSeen.set(baseKey, occ);
    const ovEnt = entFail ? r.verEntMins - r.targetMins : null;
    const ovRec = recFail ? r.verRecMins - r.targetMins : null;
    failuresDetail.push({
      week_start:ws_str,
      date:r.dateStr, day_name:r.dayName, hour:r.hour,
      req_number:r.reqNumber,
      test_name:r.testName||"",
      department:r.department,
      perf_site:r.siteKey,
      originating_site:r.origSite||"Unknown",
      occurrence:occ,
      is_local:r.isLocal,
      is_shipped:r.isShipped,
      ver_ent_hrs:r.verEntMins!=null?r2(r.verEntMins/60):null,
      ver_rec_hrs:r.verRecMins!=null?r2(r.verRecMins/60):null,
      target_hrs:r.targetMins!=null?r2(r.targetMins/60):null,
      overrun_ent_hrs:ovEnt!=null?r2(ovEnt/60):null,
      overrun_rec_hrs:ovRec!=null?r2(ovRec/60):null,
      overrun_ent_pct:(ovEnt!=null&&r.targetMins>0)?r1(ovEnt/r.targetMins*100):null,
      overrun_rec_pct:(ovRec!=null&&r.targetMins>0)?r1(ovRec/r.targetMins*100):null,
      band_ent:failBand(ovEnt,r.targetMins),
      band_rec:failBand(ovRec,r.targetMins),
    });
  }

  // ── 17. Shift breakdown ─────────────────────────────────────
  const shiftGrps = {};
  for (const r of rows) {
    if (r.hour==null) continue;
    const key = `${r.siteKey}||${r.department}||${getShift(r.hour,r.siteKey)}`;
    if (!shiftGrps[key]) shiftGrps[key]=[];
    shiftGrps[key].push(r);
  }
  const shiftBreakdown = Object.entries(shiftGrps).map(([key,grp])=>{
    const [ps,dept,shift]=key.split("||");
    return {week_start:ws_str,perf_site:ps,department:dept,shift,...derive(statsFor(grp))};
  });

  return {summary,sites,departments,daily,dailySite,dailySiteDept,dailyTest,deptSite,
          routes,testFailures,dataQuality,referral,microbiology,
          hourly,hourlySite,hourlySiteDept,failedRequests,shiftBreakdown,topTests,failuresDetail,
          dateCheck};
}
