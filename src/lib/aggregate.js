/**
 * aggregate.js — the dashboard's single aggregation kernel.
 *
 * Everything the UI displays for a filtered selection goes through aggregate()
 * here. That is the whole point: the September 2026 audit found the same
 * metric computed four different ways in four different code paths, giving
 * answers that differed by up to 15.8 percentage points depending on which
 * filter the user had clicked. Weekly said one thing, Monthly another, and a
 * department filter a third.
 *
 * The rule this module enforces:
 *
 *     SUM THE COUNTS, THEN DIVIDE ONCE.
 *
 * Never average a stored percentage, and never weight one population's rate by
 * another population's volume. Because the v7 ETL stores raw counts and sums at
 * every grain, summing is exact — aggregation becomes associative, so the
 * answer cannot depend on the order or the path the user took to get there.
 */

// ── Count/sum fields that are safe to add across rows ─────────────────────
// Deliberately explicit rather than "add every numeric field": adding two
// percentages or two averages together is exactly the bug this module exists
// to prevent, so rates must never appear in this list.
const SUMMABLE = [
  "total_tests", "measured_tests", "unmeasured_tests", "passed", "failed",
  "zero_tat_tests", "tat_sum_mins", "tat_n", "overrun_sum_mins",
  "fail_marginal", "fail_moderate", "fail_severe", "fail_critical",
  "local_tests", "local_measured", "local_passed", "local_failed",
  "local_zero_tat", "local_tat_sum_mins", "local_tat_n",
  "local_fail_marginal", "local_fail_moderate", "local_fail_severe", "local_fail_critical",
  "shipped_tests", "shipped_rec_count", "shipped_measured",
  "shipped_passed", "shipped_failed", "shipped_tat_sum_mins", "shipped_tat_n",
  "shipped_fail_marginal", "shipped_fail_moderate", "shipped_fail_severe", "shipped_fail_critical",
  "transport_sum_mins", "transport_n",
];

const r1 = n => (n == null || !isFinite(n)) ? null : parseFloat(n.toFixed(1));
const r2 = n => (n == null || !isFinite(n)) ? null : parseFloat(n.toFixed(2));

/**
 * Sum a set of grain rows and derive every displayed rate from the totals.
 * `opts.excludeZeroTat` swaps in the zero-TAT-excluded compliance figures.
 */
export function aggregate(rows, opts = {}) {
  const a = {};
  for (const k of SUMMABLE) a[k] = 0;
  let n = 0;
  for (const row of rows || []) {
    if (!row) continue;
    n++;
    for (const k of SUMMABLE) a[k] += row[k] || 0;
  }
  if (!n) return null;

  const excl = !!opts.excludeZeroTat;
  // Zero-TAT records are verified at the same instant they were entered, so
  // they always score as passes and can only inflate compliance. Removing them
  // means removing them from BOTH sides of the fraction, not just the top.
  const measured = excl ? a.measured_tests - a.zero_tat_tests : a.measured_tests;
  const passed   = excl ? a.passed - a.zero_tat_tests : a.passed;
  const lMeasured = excl ? a.local_measured - a.local_zero_tat : a.local_measured;
  const lPassed   = excl ? a.local_passed - a.local_zero_tat : a.local_passed;

  return {
    ...a,
    grain_rows: n,
    compliance_pct:         measured   > 0 ? r1(passed / measured * 100) : null,
    local_compliance_pct:   lMeasured  > 0 ? r1(lPassed / lMeasured * 100) : null,
    // The audit's F2/F3/F17 in one line: the shipped denominator is
    // shipped_measured (physically received AND measurable), never
    // shipped_tests (all non-local). Those are different populations.
    shipped_compliance_pct: a.shipped_measured > 0
      ? r1(a.shipped_passed / a.shipped_measured * 100) : null,
    avg_tat_hrs:         a.tat_n         ? r2(a.tat_sum_mins / a.tat_n / 60) : null,
    local_avg_tat_hrs:   a.local_tat_n   ? r2(a.local_tat_sum_mins / a.local_tat_n / 60) : null,
    shipped_avg_tat_hrs: a.shipped_tat_n ? r2(a.shipped_tat_sum_mins / a.shipped_tat_n / 60) : null,
    avg_transport_hrs:   a.transport_n   ? r2(a.transport_sum_mins / a.transport_n / 60) : null,
    avg_overrun_hrs:     a.failed        ? r2(a.overrun_sum_mins / a.failed / 60) : null,
    failure_rate_pct:    measured   > 0 ? r1((measured - passed) / measured * 100) : null,
    // Failures per 1,000 tests — comparable across sites of very different
    // size, which a raw failure count is not.
    failures_per_1k:     measured   > 0 ? r1((measured - passed) / measured * 1000) : null,
    // Effective denominators, exposed so callers can show "n =" and suppress
    // statistically meaningless comparisons.
    effective_measured: measured,
    effective_passed:   passed,
    effective_local_measured: lMeasured,
    effective_local_passed:   lPassed,
  };
}

// ── Analysis basis ────────────────────────────────────────────────────────
// "Overall", "Local only" and "Shipped only" are not cosmetic view options.
// Each one measures a different population on a different clock:
//
//   Overall  every test, timed from when it was booked in (Ver-Ent)
//   Local    only tests done at the site that booked them, same clock
//   Shipped  only samples that physically arrived from another site, timed
//            from when they were received (Ver-Rec)
//
// Comparing Overall against Local is the quickest way to tell whether a site's
// figure is being dragged down by work sent in from elsewhere: if Local is
// well above Overall, the site's own bench is fine and transport is the story.
//
// Every screen reads its numbers through this one function, so the basis
// selector cannot work on some screens and silently do nothing on others.
export function basisView(agg, basis = 'overall') {
  if (!agg) return null;
  if (basis === 'local') {
    return {
      basis, label: 'Local only', clock: 'Ver-Ent',
      volume: agg.local_tests,
      measured: agg.effective_local_measured,
      passed: agg.effective_local_passed,
      failed: Math.max(0, agg.effective_local_measured - agg.effective_local_passed),
      compliance_pct: agg.local_compliance_pct,
      avg_tat_hrs: agg.local_avg_tat_hrs,
      volumeLabel: 'Local tests',
      note: 'Tests carried out at the site that booked them in.',
    };
  }
  if (basis === 'shipped') {
    return {
      basis, label: 'Shipped only', clock: 'Ver-Rec',
      volume: agg.shipped_rec_count,
      measured: agg.shipped_measured,
      passed: agg.shipped_passed,
      failed: agg.shipped_failed,
      compliance_pct: agg.shipped_compliance_pct,
      avg_tat_hrs: agg.shipped_avg_tat_hrs,
      volumeLabel: 'Samples received',
      note: 'Samples sent in from another site, timed from when they arrived.',
    };
  }
  return {
    basis: 'overall', label: 'Overall', clock: 'Ver-Ent',
    volume: agg.total_tests,
    measured: agg.effective_measured,
    passed: agg.effective_passed,
    failed: agg.failed,
    compliance_pct: agg.compliance_pct,
    avg_tat_hrs: agg.avg_tat_hrs,
    volumeLabel: 'Total tests',
    note: 'Every test, timed from when it was booked in.',
  };
}

// Plain-language reading of the gap between Overall and Local. This is the
// inference a lab manager would otherwise have to make in their head, and the
// single most useful sentence on the Overview.
export function shippingImpact(agg) {
  if (!agg) return null;
  const overall = agg.compliance_pct, local = agg.local_compliance_pct;
  if (overall == null || local == null) return null;
  const gap = +(local - overall).toFixed(1);
  if (Math.abs(gap) < 2) {
    return { gap, tone: 'neutral',
      text: 'Local and overall performance are about the same, so samples sent in from other sites are not affecting the result either way.' };
  }
  if (gap > 0) {
    return { gap, tone: 'bad',
      text: `Work done on site is ${gap} points better than the overall figure. Samples sent in from other sites are what is pulling the overall result down.` };
  }
  return { gap, tone: 'good',
    text: `Samples sent in from other sites are performing ${Math.abs(gap)} points better than work done on site, so the local bench is the area to look at.` };
}

// ── Month bucketing ───────────────────────────────────────────────────────
// Every screen buckets a row into a month using THAT ROW'S OWN DATE, never the
// week it happened to be uploaded in. A week like "26 Jun – 3 Jul" contains
// rows from two months and must split across both.
export const rowMonth = row => (row && row.date) ? row.date.slice(0, 7) : null;

export const fmtMonthLbl = mo => {
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  return mo ? `${MONTHS[+mo.slice(5,7)-1]} ${mo.slice(0,4)}` : '—';
};

/**
 * De-duplicate overlapping upload windows.
 *
 * Consecutive weekly extracts overlap: the "17–25 Aug" upload and the
 * "24–30 Aug" upload both contain 24 and 25 August. Seven such days exist in
 * the current history. Summing day-level rows without de-duplication counted
 * those days twice in every monthly total.
 *
 * Resolution: the most recent upload window wins (highest week_start). A date
 * sitting at the tail of one extract and the head of the next is nearly always
 * partial in the first and complete in the second — across all seven
 * overlapping days the later extract holds 20–125× more tests. "Last extract
 * wins" is also deterministic, which "largest row wins" would not be if two
 * extracts ever tied.
 *
 * The winner is chosen PER DATE and then applied to every row on that date —
 * not per individual row key. Choosing per row key looks equivalent but is
 * not: on an overlapping date the thin extract often contains a (site, dept,
 * test) combination the full extract happens not to have, and a per-key
 * winner would keep that orphan row alongside the full extract's rows,
 * re-introducing a smaller version of the very double-count being removed.
 * Deciding per date keeps each day's rows internally consistent, which is what
 * makes the grains reconcile with each other.
 */
export function dedupeOverlappingDays(rows) {
  if (!rows || rows.length === 0) return [];
  const winner = new Map();           // date -> the latest week_start covering it
  for (const r of rows) {
    const w = String(r.week_start || '');
    const cur = winner.get(r.date);
    if (cur === undefined || w > cur) winner.set(r.date, w);
  }
  return rows.filter(r => String(r.week_start || '') === winner.get(r.date));
}

/** Distinct months present in a set of day-level rows, newest first. */
export const availableMonths = dailyRows =>
  [...new Set((dailyRows || []).map(rowMonth))].filter(Boolean).sort().reverse();

/**
 * Day-level rows for one calendar month, de-duplicated across overlapping
 * upload windows. This is the ONLY function screens should use to get a
 * month's rows — calling .filter() directly is what let the double-count
 * survive as long as it did.
 */
export function rowsInMonth(dailyRows, month, extraFilter = () => true) {
  // De-duplicate BEFORE applying the caller's filter. Filtering first can
  // remove the rows that identify which upload window won a given date, so a
  // date could resolve differently under a site filter than without one —
  // exactly the kind of path-dependent answer this module exists to prevent.
  const inMonth = (dailyRows || []).filter(r => rowMonth(r) === month);
  return dedupeOverlappingDays(inMonth).filter(extraFilter);
}

/** Day-level rows for one upload week (no de-duplication needed within a week). */
export const rowsInWeek = (dailyRows, weekStart, extraFilter = () => true) =>
  (dailyRows || []).filter(r => r.week_start === weekStart && extraFilter(r));

// ── Unique patients ───────────────────────────────────────────────────────
// unique_patients on a day row is a same-day count; summing it across days
// double-counts anyone tested more than once in the range. patient_ids holds
// the real identifiers, so a true set-union is possible. If any row in the
// range predates that column, fall back to the sum for the WHOLE range and
// report exact:false, so a caller never presents an approximation as precise.
export function uniquePatientAgg(rows) {
  if (!rows || !rows.length) return { count: null, exact: true };
  if (rows.every(r => Array.isArray(r.patient_ids))) {
    return { count: new Set(rows.flatMap(r => r.patient_ids)).size, exact: true };
  }
  const withCounts = rows.filter(r => r.unique_patients != null);
  return {
    count: withCounts.length ? withCounts.reduce((a, r) => a + (r.unique_patients || 0), 0) : null,
    exact: false,
  };
}

// ── Multi-select filter matching ──────────────────────────────────────────
// An empty selection means "all", never "none". A manager who clears a filter
// expects to see everything; showing an empty dashboard instead reads as a
// broken tool.
export const matches = (selected, value) =>
  !selected || selected.length === 0 || selected.includes(value);

/** Build a row predicate from the global filter state. */
export function makeRowFilter({ sites, depts, tests } = {}) {
  return row =>
    matches(sites, row.perf_site ?? row.site) &&
    matches(depts, row.department) &&
    matches(tests, row.test_name);
}

// ── Period-over-period comparison ─────────────────────────────────────────
// Compliance is a proportion, so its change is in PERCENTAGE POINTS, not
// percent. Reporting "compliance up 2.4%" when it moved from 91.8 to 94.2 is a
// different (and wrong) claim. Counts change in percent. The two must never be
// shown in the same unit.
export const MIN_COMPARISON_VOLUME = 200;

export function compare(current, previous, key, { lowerIsBetter = false, unit = 'pp' } = {}) {
  if (current == null || previous == null) return null;
  const cur = current[key], prev = previous[key];
  if (cur == null || prev == null) return null;
  // A previous period with almost no volume produces a delta that is noise.
  // A small site with a handful of failures would otherwise swing the arrow wildly
  // week to week and train people to ignore it.
  const prevVol = previous.effective_measured ?? previous.measured_tests ?? previous.total_tests ?? 0;
  if (prevVol < MIN_COMPARISON_VOLUME) {
    return { suppressed: true, reason: `previous period had only ${prevVol.toLocaleString()} measurable tests`, current: cur, previous: prev };
  }
  const delta = cur - prev;
  const pctDelta = prev !== 0 ? (delta / Math.abs(prev)) * 100 : null;
  const improved = delta === 0 ? null : (lowerIsBetter ? delta < 0 : delta > 0);
  return {
    suppressed: false,
    current: cur, previous: prev,
    delta: unit === 'pp' ? r1(delta) : r1(delta),
    pctDelta: r1(pctDelta),
    unit,                       // 'pp' for rates, '%' for counts
    improved,
    direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
  };
}

// ── Failure severity ──────────────────────────────────────────────────────
export const BANDS = [
  { key: 'marginal', label: 'Marginal', short: 'within 30 min of target', action: 'Tighten the routine' },
  { key: 'moderate', label: 'Moderate', short: '31 min to 3 hours over', action: 'Review the workflow' },
  { key: 'severe',   label: 'Severe',   short: '3 to 12 hours over',         action: 'Escalate' },
  { key: 'critical', label: 'Critical', short: 'more than 12 hours over',    action: 'Investigate each one' },
];
export const BAND_COLORS = {
  marginal: '#FBBF24', moderate: '#FB923C', severe: '#F87171', critical: '#DC2626',
};
// Severity bands for the active basis. Each basis has its own set, because
// mixing them means the breakdown stops adding up to the failure count shown
// beside it, which is how a reader discovers they cannot trust the table.
export const bandPrefix = basis =>
  basis === 'shipped' ? 'shipped_fail_' : basis === 'local' ? 'local_fail_' : 'fail_';

export const bandCounts = (agg, basis = 'overall') => {
  if (!agg) return [];
  const p = bandPrefix(basis);
  return BANDS.map(b => ({ ...b, count: agg[p + b.key] || 0 }));
};

// Plain-language names. "Marginal / Moderate / Severe / Critical" is grading
// language; these say what actually happened.
export const BAND_PLAIN = {
  marginal: 'Marginal',
  moderate: 'Moderate',
  severe:   'Severe',
  critical: 'Critical',
};
