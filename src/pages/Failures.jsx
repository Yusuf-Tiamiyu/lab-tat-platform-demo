/**
 * Failures.jsx — the TAT failure investigation workbench.
 *
 * Replaces a single truncated table that could only ever answer "which
 * requisitions were worst?". It answers, in order, the questions a lab manager
 * actually works through:
 *
 *   1. How bad?    — severity profile, with every failure counted
 *   2. Where?      — site × department concentration
 *   3. What?       — Pareto by test, with cumulative share
 *   4. When?       — weekday × shift, and repeat-offender detection
 *   5. Which?      — the complete requisition register, sortable and searchable
 *
 * The single most important property of this screen: NOTHING IS HIDDEN. The
 * previous build filtered the register to failures exceeding target by more
 * than an hour, which removed 22.3% of all failures and 100% of some sites'.
 * Every count here is over every failure, and the register row count is always
 * displayed so a manager can see that nothing has been trimmed away.
 */
import React, { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, Line, ComposedChart,
} from 'recharts';
import {
  C, T, Icon, SectionTitle, DataTable, Note, Empty, fmtN, fmtH, fmtOverTarget, rag, Segmented, ProportionBar,
} from '../ui.jsx';
import { aggregate, basisView, BANDS, BAND_COLORS, BAND_PLAIN } from '../lib/aggregate.js';

const SHIFT_ORDER = ['Morning (8am-2pm)','Handover (2pm-4pm)','Afternoon (4pm-8pm)','Night (8pm-8am)','Outside Hours'];
const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#0B1220', border:`1px solid ${C.borderLt}`, borderRadius:8, padding:'9px 12px', fontSize:12.5 }}>
      <p style={{ color:C.t1, marginBottom:4, fontWeight:600 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color:p.color || C.t2, margin:0 }}>
          {p.name}: <b>{typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</b>
        </p>
      ))}
    </div>
  );
};

export default function PageFailures({
  failures,        // failuresDetail rows, already scoped to the active period
  grainRows,       // day×site×dept rows for the same period — the denominators
  shiftRows,       // shift breakdown rows for the selected week (weekly only)
  basis,           // 'overall' | 'local' | 'shipped'
  periodLabel,
  excludeZeroTat,
  onDrill,         // (patch) => void — lets a click here set the global filters
}) {
  const [selBands, setSelBands] = useState([]);
  const [search, setSearch] = useState('');
  const [paretoBy, setParetoBy] = useState('count');   // count | rate

  // ── Basis resolution ────────────────────────────────────────────────────
  // Which clock is being measured, and therefore which overrun/band columns
  // apply. Ver-Ent for overall and local; Ver-Rec for shipped.
  const isShipped = basis === 'shipped';
  const overrunKey = isShipped ? 'overrun_rec_hrs' : 'overrun_ent_hrs';
  const pctKey     = isShipped ? 'overrun_rec_pct' : 'overrun_ent_pct';
  const bandKey    = isShipped ? 'band_rec' : 'band_ent';
  const tatKey     = isShipped ? 'ver_rec_hrs' : 'ver_ent_hrs';

  const basisFiltered = useMemo(() => (failures || []).filter(r => {
    if (r[overrunKey] == null) return false;
    if (basis === 'local' && !r.is_local) return false;
    if (basis === 'shipped' && !r.is_shipped) return false;
    return true;
  }), [failures, basis, overrunKey]);

  const banded = useMemo(() =>
    selBands.length ? basisFiltered.filter(r => selBands.includes(r[bandKey])) : basisFiltered,
  [basisFiltered, selBands, bandKey]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return banded;
    return banded.filter(r =>
      String(r.req_number || '').toLowerCase().includes(q) ||
      String(r.test_name  || '').toLowerCase().includes(q) ||
      String(r.perf_site  || '').toLowerCase().includes(q) ||
      String(r.department || '').toLowerCase().includes(q));
  }, [banded, search]);

  // ── Denominators ────────────────────────────────────────────────────────
  const denom = useMemo(() => aggregate(grainRows, { excludeZeroTat }), [grainRows, excludeZeroTat]);
  const measuredBase = isShipped ? (denom?.shipped_measured || 0)
                     : basis === 'local' ? (denom?.local_measured || 0)
                     : (denom?.effective_measured || 0);

  // ── Layer 1: severity profile ───────────────────────────────────────────
  const bandProfile = useMemo(() => {
    const counts = Object.fromEntries(BANDS.map(b => [b.key, 0]));
    basisFiltered.forEach(r => { const b = r[bandKey]; if (b && counts[b] != null) counts[b]++; });
    const total = basisFiltered.length || 1;
    return BANDS.map(b => ({ ...b, count: counts[b.key], pct: +(counts[b.key] / total * 100).toFixed(1) }));
  }, [basisFiltered, bandKey]);

  const totalFailures = basisFiltered.length;
  const medianOverrun = useMemo(() => {
    if (!basisFiltered.length) return null;
    const v = basisFiltered.map(r => r[overrunKey]).filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }, [basisFiltered, overrunKey]);
  const per1k = measuredBase ? +(totalFailures / measuredBase * 1000).toFixed(1) : null;

  // ── Layer 2: site × department concentration ────────────────────────────
  const concentration = useMemo(() => {
    const failBy = {};
    basisFiltered.forEach(r => {
      const k = `${r.perf_site}||${r.department}`;
      failBy[k] = (failBy[k] || 0) + 1;
    });
    const volBy = {};
    (grainRows || []).forEach(r => {
      const k = `${r.perf_site}||${r.department}`;
      const v = isShipped ? (r.shipped_measured || 0)
              : basis === 'local' ? (r.local_measured || 0)
              : (r.measured_tests || 0) - (excludeZeroTat ? (r.zero_tat_tests || 0) : 0);
      volBy[k] = (volBy[k] || 0) + v;
    });
    const sites = [...new Set(Object.keys(volBy).map(k => k.split('||')[0]))].sort();
    const depts = [...new Set(Object.keys(volBy).map(k => k.split('||')[1]))].sort();
    return { sites, depts, failBy, volBy };
  }, [basisFiltered, grainRows, basis, isShipped, excludeZeroTat]);

  // ── Layer 3: Pareto by test ─────────────────────────────────────────────
  const pareto = useMemo(() => {
    const byTest = {};
    basisFiltered.forEach(r => {
      const t = r.test_name || 'Unnamed test';
      byTest[t] = (byTest[t] || 0) + 1;
    });
    let ranked = Object.entries(byTest).map(([test_name, n]) => ({ test_name, n }));
    ranked.sort((a, b) => b.n - a.n);
    const total = basisFiltered.length || 1;
    let run = 0;
    ranked = ranked.map(r => { run += r.n; return { ...r, pct:+(r.n / total * 100).toFixed(1), cum:+(run / total * 100).toFixed(1) }; });
    return ranked;
  }, [basisFiltered]);

  // Top ten only. An "All other tests" bar used to be appended here, but when
  // failures are spread across 240 tests that single bar is larger than every
  // real bar put together, flattening them into slivers and hiding exactly the
  // comparison the chart is for. The spread is now stated in words above the
  // chart instead, where it reads better anyway.
  const paretoTop = useMemo(() => pareto.slice(0, 10), [pareto]);

  const testsFor80 = useMemo(() => {
    let i = 0;
    for (const r of pareto) { i++; if (r.cum >= 80) break; }
    return i;
  }, [pareto]);

  // Share of all late results covered by the ten tests actually drawn. This is
  // the figure the heading quotes, so what is claimed and what is visible are
  // the same thing.
  const topShare = useMemo(() => {
    if (!basisFiltered.length) return 0;
    const n = pareto.slice(0, 10).reduce((a, r) => a + r.n, 0);
    return +(n / basisFiltered.length * 100).toFixed(1);
  }, [pareto, basisFiltered.length]);

  // Concentrated means a small minority of tests drives most of the lateness,
  // which implies a targeted fix. The usual Pareto rule of thumb is that 20%
  // of causes drive 80% of effects, so compare against that.
  const concentrated = pareto.length > 0 && testsFor80 <= Math.max(3, pareto.length * 0.2);

  // ── Layer 4a: weekday × shift ───────────────────────────────────────────
  // "Is this a Monday backlog or a night-shift problem?" was unanswerable
  // before — the data was collected but never crossed.
  const dayShift = useMemo(() => {
    const bucket = {};
    basisFiltered.forEach(r => {
      if (!r.day_name || r.hour == null) return;
      const sh = r.hour >= 8 && r.hour < 14 ? SHIFT_ORDER[0]
               : r.hour >= 14 && r.hour < 16 ? SHIFT_ORDER[1]
               : r.hour >= 16 && r.hour < 20 ? SHIFT_ORDER[2]
               : SHIFT_ORDER[3];
      const k = `${r.day_name}||${sh}`;
      bucket[k] = (bucket[k] || 0) + 1;
    });
    const max = Math.max(1, ...Object.values(bucket));
    const days = DAY_ORDER.filter(d => SHIFT_ORDER.some(s => bucket[`${d}||${s}`]));
    const shifts = SHIFT_ORDER.filter(s => days.some(d => bucket[`${d}||${s}`]));
    return { bucket, max, days, shifts };
  }, [basisFiltered]);

  // ── Layer 4b: repeat offenders ──────────────────────────────────────────
  // A (test × site) pair failing on at least 3 distinct days is a pattern;
  // one failing once is an incident. This is the distinction the previous
  // build could not make at all.
  const repeatOffenders = useMemo(() => {
    const byPair = {};
    basisFiltered.forEach(r => {
      const k = `${r.test_name}||${r.perf_site}||${r.department}`;
      (byPair[k] ||= { test_name:r.test_name, perf_site:r.perf_site, department:r.department, days:new Set(), n:0, worst:0 });
      byPair[k].n++;
      if (r.date) byPair[k].days.add(r.date);
      byPair[k].worst = Math.max(byPair[k].worst, r[overrunKey] || 0);
    });
    return Object.values(byPair)
      .map(p => ({ ...p, dayCount:p.days.size }))
      .filter(p => p.dayCount >= 3)
      .sort((a, b) => b.dayCount - a.dayCount || b.n - a.n)
      .slice(0, 12);
  }, [basisFiltered, overrunKey]);

  if (!failures) return <Empty msg="Loading failure data…"/>;

  const basisNote = isShipped
    ? 'Showing samples sent in from other sites, timed from the moment they arrived here.'
    : basis === 'local'
      ? 'Showing only tests the site booked in and ran itself, timed from booking in.'
      : 'Showing every test, timed from when it was booked in.';

  return (
    <div>
      {/* ── LAYER 1 · Severity profile ─────────────────────────────── */}
      <div style={T.panel}>
        <SectionTitle sub={`${basisNote} Every late test is listed. Nothing is filtered out for being only slightly late.`}>
          How late were they? {periodLabel}
        </SectionTitle>

        {totalFailures === 0 ? (
          <Empty msg="No TAT failures for the current filters. That is a real result, not an empty table."/>
        ) : (
          <>
            <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:18 }}>
              <div style={{ ...T.card, flex:'1 1 170px' }}>
                <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.3, fontWeight:600 }}>Total failures</div>
                <div style={{ fontSize:26, fontWeight:800, color:C.bad, marginTop:5, fontVariantNumeric:'tabular-nums' }}>{fmtN(totalFailures)}</div>
                <div style={{ color:C.t3, fontSize:12.5, marginTop:4 }}>of {fmtN(measuredBase)} measurable tests</div>
              </div>
              <div style={{ ...T.card, flex:'1 1 170px' }}>
                <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.3, fontWeight:600 }}>Failure rate</div>
                <div style={{ fontSize:26, fontWeight:800, color:C.t1, marginTop:5, fontVariantNumeric:'tabular-nums' }}>
                  {measuredBase ? `${(totalFailures / measuredBase * 100).toFixed(1)}%` : 'N/A'}
                </div>
                <div style={{ color:C.t3, fontSize:12.5, marginTop:4 }}>{per1k != null ? `${per1k} per 1,000 tests` : 'N/A'}</div>
              </div>
              <div style={{ ...T.card, flex:'1 1 170px' }}>
                <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.3, fontWeight:600 }}>Median overrun</div>
                <div style={{ fontSize:26, fontWeight:800, color:C.warn, marginTop:5, fontVariantNumeric:'tabular-nums' }}>{fmtH(medianOverrun)}</div>
                <div style={{ color:C.t3, fontSize:12.5, marginTop:4 }}>half of failures are worse than this</div>
              </div>
              <div style={{ ...T.card, flex:'1 1 170px' }}>
                <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.3, fontWeight:600 }}>Pareto</div>
                <div style={{ fontSize:26, fontWeight:800, color:C.accent, marginTop:5, fontVariantNumeric:'tabular-nums' }}>{testsFor80}</div>
                <div style={{ color:C.t3, fontSize:12.5, marginTop:4 }}>tests cause 80% of failures</div>
              </div>
            </div>

            {/* Stacked severity bar — click a band to filter everything below */}
            <div style={{ display:'flex', height:34, borderRadius:7, overflow:'hidden', border:`1px solid ${C.border}` }}>
              {bandProfile.map(b => b.count > 0 && (
                <button key={b.key} onClick={() => setSelBands(s => s.includes(b.key) ? s.filter(x => x !== b.key) : [...s, b.key])}
                        title={`${b.label}: ${b.short}. ${fmtN(b.count)} failures (${b.pct}%). ${b.action}. Click to filter.`}
                        style={{ width:`${b.pct}%`, background:BAND_COLORS[b.key], border:'none', cursor:'pointer',
                                 opacity: selBands.length && !selBands.includes(b.key) ? 0.3 : 1,
                                 color:'#0B1220', fontSize:12, fontWeight:700, fontFamily:'inherit',
                                 transition:'opacity .15s', padding:0, overflow:'hidden', whiteSpace:'nowrap' }}>
                  {b.pct >= 7 ? `${b.pct}%` : ''}
                </button>
              ))}
            </div>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginTop:12 }}>
              {bandProfile.map(b => (
                <button key={b.key} onClick={() => setSelBands(s => s.includes(b.key) ? s.filter(x => x !== b.key) : [...s, b.key])}
                        style={{ display:'flex', alignItems:'flex-start', gap:8, background:'none', border:'none',
                                 cursor:'pointer', padding:0, textAlign:'left', fontFamily:'inherit',
                                 opacity: selBands.length && !selBands.includes(b.key) ? 0.45 : 1 }}>
                  <span style={{ width:11, height:11, borderRadius:3, background:BAND_COLORS[b.key], marginTop:4, flexShrink:0 }}/>
                  <span>
                    <span style={{ color:C.t1, fontSize:13, fontWeight:600 }}>{b.label}</span>
                    <span style={{ color:C.t3, fontSize:12.5 }}> · {fmtN(b.count)} ({b.pct}%)</span>
                    <span style={{ display:'block', color:C.t4, fontSize:11.5 }}>{b.short} → {b.action}</span>
                  </span>
                </button>
              ))}
              {selBands.length > 0 && (
                <button onClick={() => setSelBands([])}
                        style={{ ...T.input, cursor:'pointer', color:C.bad, borderColor:`${C.bad}55`, fontSize:12, alignSelf:'center' }}>
                  Clear band filter
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {totalFailures > 0 && (
        <>
          {/* ── LAYER 2 · Concentration ──────────────────────────────── */}
          <div style={T.panel}>
            <SectionTitle sub="Cell colour is the failure RATE; the number is the failure COUNT. Rate alone over-weights small sites and count alone over-weights large ones, so both are shown. Click any cell to filter the whole dashboard to it.">
              Where the late tests are, by site and department
            </SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <div style={{ display:'grid',
                            gridTemplateColumns:`minmax(130px,150px) repeat(${concentration.depts.length}, minmax(88px,1fr))`,
                            gap:4, minWidth:150 + concentration.depts.length * 92 }}>
                <div/>
                {concentration.depts.map(d => (
                  <div key={d} title={d} style={{ color:C.t3, fontSize:11.5, fontWeight:600, textAlign:'center',
                                                  padding:'0 2px 6px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{d}</div>
                ))}
                {concentration.sites.map(s => (
                  <React.Fragment key={s}>
                    <div style={{ color:C.t2, fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center',
                                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={s}>{s}</div>
                    {concentration.depts.map(d => {
                      const k = `${s}||${d}`;
                      const vol = concentration.volBy[k] || 0;
                      const f = concentration.failBy[k] || 0;
                      if (!vol) return <div key={d} style={{ background:'#0A0F18', borderRadius:5, minHeight:38 }}/>;
                      const rate = f / vol * 100;
                      const col = rate >= 50 ? C.bad : rate >= 25 ? '#FB923C' : rate >= 10 ? C.warn : C.good;
                      return (
                        <button key={d} onClick={() => onDrill?.({ sites:[s], depts:[d] })}
                                title={`${s} · ${d}\n${fmtN(f)} failures of ${fmtN(vol)} measurable tests (${rate.toFixed(1)}%)\nClick to filter the dashboard to this cell`}
                                style={{ background:`${col}26`, border:`1px solid ${col}66`, borderRadius:5,
                                         minHeight:38, cursor:'pointer', fontFamily:'inherit', padding:'4px 2px',
                                         display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:1 }}>
                          <span style={{ color:col, fontSize:13, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{fmtN(f)}</span>
                          <span style={{ color:C.t3, fontSize:10.5, fontVariantNumeric:'tabular-nums' }}>{rate.toFixed(0)}%</span>
                        </button>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div style={{ display:'flex', gap:16, marginTop:12, flexWrap:'wrap', color:C.t3, fontSize:12 }}>
              {[['≥50% failure rate',C.bad],['25–49%','#FB923C'],['10–24%',C.warn],['<10%',C.good]].map(([l,col]) => (
                <span key={l} style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <i style={{ width:11, height:11, borderRadius:3, background:`${col}40`, border:`1px solid ${col}`, display:'inline-block' }}/>{l}
                </span>
              ))}
              <span style={{ color:C.t4 }}>Blank = no measurable tests in that combination.</span>
            </div>
          </div>

          {/* ── LAYER 3 · Which tests ────────────────────────────────── */}
          {/* The heading here used to read "74 tests account for 80% of all
              failures", while the chart below showed ten bars. Nothing on
              screen let anyone check the 74, and the ten visible tests
              actually covered only 14% of failures, so the sentence and the
              picture told different stories. The text now describes exactly
              what is drawn, and says plainly whether the failures are
              concentrated or spread out, which is the decision this chart
              exists to inform. */}
          <div style={T.panel}>
            <SectionTitle
              sub={`These are the ${Math.min(10, pareto.length)} tests with the most late results. Together they account for ${topShare}% of every late test in this period.`}
              right={<Segmented size="sm" value={paretoBy} onChange={setParetoBy}
                                options={[['count','Number late','How many results ran late'],
                                          ['rate','Share of total','What portion of all late results']]}/>}>
              Which tests run late most often
            </SectionTitle>

            <div style={{ background: concentrated ? `${C.warn}12` : `${C.accent}12`,
                          border:`1px solid ${concentrated ? C.warn : C.accent}44`,
                          borderLeft:`3px solid ${concentrated ? C.warn : C.accent}`,
                          borderRadius:7, padding:'11px 15px', marginBottom:14,
                          color:C.t2, fontSize:13.5, lineHeight:1.6 }}>
              <b style={{ color:C.t1 }}>What this tells you: </b>
              {concentrated
                ? `Late results are concentrated. Just ${testsFor80} of the ${pareto.length} tests involved cause 80% of them, so fixing that small group would clear most of the problem.`
                : `Late results are spread widely. It takes ${testsFor80} of the ${pareto.length} tests involved to reach 80% of them, so there is no small group to target. This usually points to something affecting the whole laboratory, such as staffing, transport or an instrument backlog, rather than a handful of tests.`}
            </div>
            <ResponsiveContainer width="100%" height={Math.max(280, paretoTop.length * 32)}>
              <ComposedChart data={paretoTop} layout="vertical" margin={{ top:6, right:56, left:8, bottom:6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16202F" horizontal={false}/>
                <XAxis type="number" tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
                <YAxis dataKey="test_name" type="category" tick={{ fill:C.t2, fontSize:12 }}
                       width={190} axisLine={false} tickLine={false} interval={0}/>
                <Tooltip content={<Tip/>}/>
                <Bar dataKey={paretoBy === 'count' ? 'n' : 'pct'} name={paretoBy === 'count' ? 'Failures' : '% of failures'} radius={[0,4,4,0]}>
                  {paretoTop.map((e, i) => <Cell key={i} fill={C.bad}/>)}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── LAYER 4 · Timing and recurrence ──────────────────────── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(340px,1fr))', gap:18, marginBottom:18 }}>
            <div style={{ ...T.panel, marginBottom:0 }}>
              <SectionTitle sub="Failure counts by the day and shift the sample was entered. Answers whether a problem is a weekday backlog or a specific shift.">
                When failures happen
              </SectionTitle>
              {dayShift.days.length === 0 ? <Empty msg="No timing data available for these failures."/> : (
                <div style={{ overflowX:'auto' }}>
                  <div style={{ display:'grid', gridTemplateColumns:`104px repeat(${dayShift.days.length}, minmax(52px,1fr))`, gap:4 }}>
                    <div/>
                    {dayShift.days.map(d => (
                      <div key={d} style={{ color:C.t3, fontSize:11.5, textAlign:'center', fontWeight:600, paddingBottom:5 }}>{d.slice(0,3)}</div>
                    ))}
                    {dayShift.shifts.map(sh => (
                      <React.Fragment key={sh}>
                        <div style={{ color:C.t2, fontSize:11.5, display:'flex', alignItems:'center' }} title={sh}>{sh.split(' ')[0]}</div>
                        {dayShift.days.map(d => {
                          const n = dayShift.bucket[`${d}||${sh}`] || 0;
                          const intensity = n / dayShift.max;
                          return (
                            <div key={d} title={`${d} · ${sh}: ${fmtN(n)} failures`}
                                 style={{ background: n ? `rgba(248,113,113,${0.12 + intensity * 0.6})` : '#0A0F18',
                                          border:`1px solid ${n ? 'rgba(248,113,113,0.35)' : C.border}`,
                                          borderRadius:5, minHeight:34, display:'flex', alignItems:'center', justifyContent:'center',
                                          color: n ? C.t1 : C.t4, fontSize:12, fontWeight:600, fontVariantNumeric:'tabular-nums' }}>
                              {n || ''}
                            </div>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ ...T.panel, marginBottom:0 }}>
              <SectionTitle sub="Test + site combinations failing on 3 or more separate days in this period. These are recurring operational problems rather than isolated incidents.">
                Repeat offenders
              </SectionTitle>
              {repeatOffenders.length === 0 ? (
                <Empty msg="No test at any site ran late on 3 or more separate days. The late results here look like one-off incidents rather than an ongoing problem."/>
              ) : (
                <DataTable dense maxH={300} pageSize={12}
                  initialSort={{ key:'dayCount', dir:'desc' }}
                  cols={[
                    { key:'test_name', label:'Test', wrap:true, maxW:'190px' },
                    { key:'perf_site', label:'Site' },
                    { key:'department', label:'Dept' },
                    { key:'dayCount', label:'Days', align:'right',
                      render:r => <span style={{ color:C.bad, fontWeight:700 }}>{r.dayCount}</span> },
                    { key:'n', label:'Failures', align:'right' },
                    { key:'worst', label:'Worst', align:'right', render:r => fmtH(r.worst) },
                  ]}
                  rows={repeatOffenders.map((r, i) => ({ ...r, _key:i }))}/>
              )}
            </div>
          </div>

          {/* ── LAYER 5 · The complete register ──────────────────────── */}
          <div style={T.panel}>
            <SectionTitle
              sub="Every late test in this period. Nothing is hidden and nothing is cut off. Click a column heading to sort, or search by requisition number, test, site or department."
              right={
                <div style={{ position:'relative', minWidth:230 }}>
                  <Icon name="search" size={14} style={{ position:'absolute', left:10, top:9, color:C.t3 }}/>
                  <input value={search} onChange={e => setSearch(e.target.value)}
                         placeholder="Search req / test / site…"
                         style={{ ...T.input, width:'100%', paddingLeft:32 }}/>
                </div>
              }>
              Requisition register
            </SectionTitle>

            {selBands.length > 0 && (
              <Note>
                Filtered to <b>{selBands.join(', ')}</b> severity.
                Showing {fmtN(searched.length)} of {fmtN(basisFiltered.length)} failures.
                {' '}<button onClick={() => setSelBands([])}
                             style={{ background:'none', border:'none', color:C.accent, cursor:'pointer',
                                      textDecoration:'underline', fontFamily:'inherit', fontSize:13, padding:0 }}>
                  Show all severities
                </button>
              </Note>
            )}

            <DataTable maxH={620} pageSize={100}
              initialSort={{ key:overrunKey, dir:'desc' }}
              emptyMsg="No failures match this search."
              cols={[
                { key:'date', label:'Date', defaultDir:'asc',
                  render:r => <span style={{ color:C.t2, whiteSpace:'nowrap' }}>{r.date || 'N/A'}</span> },
                { key:'day_name', label:'Day', render:r => <span style={{ color:C.t3 }}>{(r.day_name || '').slice(0,3) || 'N/A'}</span> },
                { key:'req_number', label:'Req Number',
                  render:r => <span style={{ color:C.accent, fontFamily:'ui-monospace,monospace', fontSize:12.5 }}>{r.req_number}</span> },
                { key:'test_name', label:'Test', wrap:true, maxW:'210px' },
                { key:'department', label:'Dept' },
                { key:'perf_site', label:'Perf. Site' },
                { key:'originating_site', label:'Origin',
                  render:r => <span style={{ color:r.is_local ? C.good : C.purple }}>{r.originating_site || 'N/A'}</span> },
                { key:'target_hrs', label:'Target', align:'right', render:r => fmtH(r.target_hrs) },
                { key:tatKey, label:isShipped ? 'Ver-Rec' : 'Ver-Ent', align:'right', render:r => fmtH(r[tatKey]) },
                { key:overrunKey, label:'Overrun', align:'right',
                  render:r => <span style={{ color:BAND_COLORS[r[bandKey]] || C.bad, fontWeight:700 }}>+{fmtH(r[overrunKey])}</span> },
                // "5,798.4%" is a true number that nobody can picture. Above
                // ten times over target this switches to a multiple, which
                // reads instantly: "59x target".
                { key:pctKey, label:'How far over', align:'right',
                  render:r => <span style={{ color:C.t2 }}>{fmtOverTarget(r[pctKey])}</span> },
                { key:bandKey, label:'Severity',
                  render:r => r[bandKey]
                    ? <span style={{ ...T.badge(BAND_COLORS[r[bandKey]]), textTransform:'capitalize' }}>{r[bandKey]}</span>
                    : 'N/A' },
              ]}
              rows={searched.map((r, i) => ({ ...r, _key:`${r.req_number}-${r.test_name}-${r.occurrence ?? i}` }))}/>
          </div>
        </>
      )}
    </div>
  );
}
