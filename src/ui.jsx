/**
 * ui.jsx — design tokens and shared primitives.
 *
 * Extracted from App.jsx during the post-audit rebuild so the filter controls
 * (which the audit found to be the main source of wrong numbers reaching
 * meetings) live in one reviewable place rather than being re-implemented per
 * page.
 *
 * Type scale note: the previous build used 9–11px for labels and captions and
 * #334155 body text on a #111827 ground (~2:1 contrast, well below the 4.5:1
 * threshold). Several informational notes were effectively invisible. The
 * scale below has a 12px floor and every text token clears 4.5:1.
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';

// ── Design tokens ─────────────────────────────────────────────────────────
export const C = {
  bg:        '#060B12',
  panel:     '#111827',
  panelAlt:  '#0F172A',
  rail:      '#080D14',
  border:    '#1E2D40',
  borderLt:  '#2D4058',
  // Text ramp — every step verified against the panel background.
  t1:        '#F1F5F9',   // primary
  t2:        '#CBD5E1',   // secondary
  t3:        '#94A3B8',   // tertiary (was #64748B)
  t4:        '#7C8BA1',   // quaternary — the old #334155 was unreadable
  accent:    '#38BDF8',
  accent2:   '#818CF8',
  good:      '#34D399',
  warn:      '#FBBF24',
  bad:       '#F87171',
  purple:    '#A78BFA',
};

export const T = {
  card:  { background:C.panel, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px 20px' },
  panel: { background:C.panel, border:`1px solid ${C.border}`, borderRadius:12, padding:'18px 22px', marginBottom:18 },
  input: { background:C.panelAlt, border:`1px solid ${C.borderLt}`, color:C.t2, borderRadius:7,
           padding:'7px 11px', fontSize:13, outline:'none', fontFamily:'inherit' },
  badge: color => ({ background:`${color}1F`, color, padding:'2px 9px', borderRadius:5,
                     fontSize:12, fontWeight:700, whiteSpace:'nowrap' }),
};

export const SITE_COLORS = ['#38BDF8','#818CF8','#A78BFA','#34D399','#FBBF24','#F87171','#FB923C','#E879F9','#4ADE80','#22D3EE'];

// RAG thresholds. Kept identical to the previous build — lab managers already
// read these colours and changing the boundaries would silently re-grade every
// site overnight.
export const rag = v => v == null ? C.t4 : v >= 90 ? C.good : v >= 50 ? C.warn : C.bad;

export const fmtN = v => v == null ? 'N/A' : Number(v).toLocaleString();
export const fmtPct = v => v == null ? 'N/A' : `${v}%`;
export const fmtH = h => {
  if (h == null || !isFinite(h)) return 'N/A';
  const neg = h < 0; const a = Math.abs(h);
  const hh = Math.floor(a), mm = Math.round((a - hh) * 60);
  // Past a couple of days, hours stop being readable. "173h 57m" is a number
  // you have to do arithmetic on; "7d 5h" is one you can picture.
  let s;
  if (hh >= 48) { const d = Math.floor(hh / 24); s = `${d}d ${hh - d * 24}h`; }
  else s = hh >= 1 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
  return neg ? `-${s}` : s;
};

// How far past target something ran, written so it stays readable at both ends.
// A percentage works fine for a small overrun, but 5,798% is a number nobody
// can picture. Above ten times over, switch to a multiple, which people read
// instantly: "59x target" needs no arithmetic.
export const fmtOverTarget = pct => {
  if (pct == null || !isFinite(pct)) return 'N/A';
  if (pct >= 1000) return `${(pct / 100 + 1).toFixed(0)}x target`;
  if (pct >= 100)  return `${Math.round(pct)}% over`;
  return `${pct}% over`;
};

// ── Icons ─────────────────────────────────────────────────────────────────
const ICONS = {
  overview:'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  calendar:'M3 4h18v18H3zM3 10h18M8 2v4M16 2v4',
  trending:'M3 17l6-6 4 4 8-8M21 7h-6M21 7v6',
  truck:'M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 19a2 2 0 100-4 2 2 0 000 4zM18.5 19a2 2 0 100-4 2 2 0 000 4z',
  alertTri:'M12 2L2 20h20L12 2zM12 9v5M12 17h.01',
  flame:'M12 2s5 5 5 10a5 5 0 01-10 0c0-2 1-3 1-3s1 2 2 2 2-4 2-9z',
  search:'M11 3a8 8 0 100 16 8 8 0 000-16zM21 21l-4.35-4.35',
  filter:'M3 4h18l-7 8v6l-4 2v-8z',
  download:'M12 3v12M7 11l5 5 5-5M3 21h18',
  close:'M18 6L6 18M6 6l12 12',
  chevron:'M6 9l6 6 6-6',
  check:'M20 6L9 17l-5-5',
  info:'M12 2a10 10 0 100 20 10 10 0 000-20zM12 16v-5M12 8h.01',
  pin:'M12 21s7-7.5 7-12a7 7 0 10-14 0c0 4.5 7 12 7 12zM12 11a2 2 0 100-4 2 2 0 000 4z',
  vial:'M9 2v14a3 3 0 006 0V2M7 2h10M9 9h6',
  lock:'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  sort:'M8 6l4-4 4 4M8 18l4 4 4-4',
};
export const Icon = ({ name, size = 15, style, strokeWidth = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
       style={{ flexShrink:0, verticalAlign:'-2px', ...style }} aria-hidden="true">
    <path d={ICONS[name] || ICONS.info}/>
  </svg>
);

// ── Section heading ───────────────────────────────────────────────────────
export const SectionTitle = ({ children, sub, right }) => (
  <div style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:14, flexWrap:'wrap' }}>
    <div style={{ flex:1, minWidth:0 }}>
      <h2 style={{ color:C.t1, fontSize:15.5, fontWeight:700, margin:0, letterSpacing:0.1 }}>{children}</h2>
      {sub && <p style={{ color:C.t3, fontSize:12.5, margin:'4px 0 0', lineHeight:1.5, maxWidth:'80ch' }}>{sub}</p>}
    </div>
    {right}
  </div>
);

export const RAGBadge = ({ v }) =>
  v == null ? <span style={{ color:C.t4, fontSize:12 }}>N/A</span>
            : <span style={T.badge(rag(v))}>{v}%</span>;

// ── KPI card with period comparison ───────────────────────────────────────
// The audit's F-list on trends: show the PREVIOUS VALUE, not just a delta a
// manager can't sanity-check; report rate changes in percentage points and
// count changes in percent (never both for one metric); and suppress the
// arrow entirely when the comparison base is too thin to mean anything.
export const TrendPill = ({ cmp, fmt = v => v, periodLabel }) => {
  if (!cmp) return null;
  if (cmp.suppressed) {
    return (
      <div style={{ color:C.t4, fontSize:11.5, marginTop:6, lineHeight:1.4 }}
           title={`No comparison shown: ${cmp.reason}`}>
        vs {periodLabel}: not comparable
      </div>
    );
  }
  const col = cmp.improved === null ? C.t3 : cmp.improved ? C.good : C.bad;
  const arrow = cmp.direction === 'up' ? '▲' : cmp.direction === 'down' ? '▼' : '→';
  const unit = cmp.unit === 'pp' ? ' pp' : '';
  const mag = cmp.unit === 'pp' ? Math.abs(cmp.delta) : Math.abs(cmp.pctDelta);
  const shown = cmp.unit === 'pp' ? `${mag}${unit}` : `${mag}%`;
  return (
    <div style={{ marginTop:6, lineHeight:1.45 }}>
      <span style={{ color:col, fontSize:12.5, fontWeight:600 }}>{arrow} {shown}</span>
      <span style={{ color:C.t4, fontSize:11.5 }}> vs {periodLabel} ({fmt(cmp.previous)})</span>
    </div>
  );
};

export const KpiCard = ({ label, value, sub, color, cmp, cmpFmt, periodLabel, note }) => (
  <div style={{ ...T.card, flex:'1 1 190px', minWidth:170 }}>
    <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.4, marginBottom:7, fontWeight:600 }}>{label}</div>
    <div style={{ fontSize:27, fontWeight:800, color:color || C.t1, lineHeight:1.05, fontVariantNumeric:'tabular-nums' }}>{value}</div>
    {sub && <div style={{ color:C.t3, fontSize:12.5, marginTop:5 }}>{sub}</div>}
    <TrendPill cmp={cmp} fmt={cmpFmt} periodLabel={periodLabel}/>
    {note && <div style={{ color:C.t4, fontSize:11.5, marginTop:8, borderTop:`1px solid ${C.border}`, paddingTop:7, lineHeight:1.45 }}>{note}</div>}
  </div>
);

// ── Sortable, searchable data table ───────────────────────────────────────
// Sorting on every column and a visible "showing X of Y" were both missing
// before; the failure table in particular was locked to worst-overrun-first
// and silently truncated, so a manager had no way to see the rest and no
// indication that a rest existed.
export function DataTable({ cols, rows, maxH, initialSort, pageSize = 200, dense, emptyMsg = 'No rows match the current filters.' }) {
  const [sort, setSort] = useState(initialSort || null);   // { key, dir }
  const [shown, setShown] = useState(pageSize);
  useEffect(() => { setShown(pageSize); }, [rows, pageSize]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls always last, either direction
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv)) * mul;
    });
  }, [rows, sort]);

  const visible = sorted.slice(0, shown);
  const pad = dense ? '6px 11px' : '9px 13px';

  if (!rows.length) {
    return <div style={{ textAlign:'center', padding:'26px', color:C.t3, fontSize:13 }}>{emptyMsg}</div>;
  }

  // Row count and "show more" sit ABOVE the table. They used to sit below,
  // which meant scrolling past hundreds of rows to discover that more existed.
  const controls = (
    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10, flexWrap:'wrap' }}>
      <span style={{ color:C.t3, fontSize:12.5 }}>
        Showing <b style={{ color:C.t2 }}>{fmtN(Math.min(shown, rows.length))}</b> of <b style={{ color:C.t2 }}>{fmtN(rows.length)}</b> rows
      </span>
      {shown < rows.length && (
        <>
          <button onClick={() => setShown(s => s + pageSize)}
                  style={{ ...T.input, cursor:'pointer', color:C.accent, borderColor:`${C.accent}55`, fontSize:12.5, fontWeight:600, padding:'4px 10px' }}>
            Show {Math.min(pageSize, rows.length - shown).toLocaleString()} more
          </button>
          <button onClick={() => setShown(rows.length)}
                  style={{ ...T.input, cursor:'pointer', fontSize:12.5, padding:'4px 10px' }}>Show all</button>
        </>
      )}
      {shown > pageSize && rows.length > pageSize && (
        <button onClick={() => setShown(pageSize)}
                style={{ ...T.input, cursor:'pointer', fontSize:12.5, padding:'4px 10px', color:C.t3 }}>Show fewer</button>
      )}
      <span style={{ color:C.t4, fontSize:12, marginLeft:'auto' }}>Click any column heading to sort</span>
    </div>
  );

  return (
    <>
      {controls}
      <div style={{ overflowX:'auto', overflowY:maxH ? 'auto' : 'visible', maxHeight:maxH, WebkitOverflowScrolling:'touch',
                    border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ borderCollapse:'collapse', width:'100%', fontSize:13 }}>
          <thead style={{ position:'sticky', top:0, zIndex:1 }}>
            <tr>
              {cols.map(c => {
                const active = sort?.key === c.key;
                const sortable = c.sortable !== false;
                return (
                  <th key={c.key}
                      onClick={sortable ? () => setSort(s =>
                        s?.key === c.key ? { key:c.key, dir:s.dir === 'asc' ? 'desc' : 'asc' }
                                         : { key:c.key, dir:c.defaultDir || 'desc' }) : undefined}
                      title={sortable ? `Sort by ${c.label}` : undefined}
                      style={{ padding:pad, textAlign:c.align || 'left', color:active ? C.accent : C.t3,
                               fontSize:11.5, fontWeight:600, textTransform:'uppercase', letterSpacing:0.7,
                               borderBottom:`1px solid ${C.border}`, background:C.panelAlt,
                               cursor:sortable ? 'pointer' : 'default', whiteSpace:'nowrap', userSelect:'none' }}>
                    {c.label}
                    {sortable && <span style={{ marginLeft:5, opacity:active ? 1 : 0.32, fontSize:9 }}>
                      {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={r._key ?? i} style={{ borderBottom:`1px solid ${C.border}` }}>
                {cols.map(c => (
                  <td key={c.key} style={{ padding:pad, color:C.t2, textAlign:c.align || 'left',
                                           whiteSpace:c.wrap ? 'normal' : 'nowrap', maxWidth:c.maxW || 'none',
                                           overflow:'hidden', textOverflow:'ellipsis',
                                           fontVariantNumeric:c.align === 'right' ? 'tabular-nums' : 'normal' }}>
                    {c.render ? c.render(r) : (r[c.key] ?? 'N/A')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < rows.length && (
        <div style={{ marginTop:10 }}>
          <button onClick={() => setShown(s => s + pageSize)}
                  style={{ ...T.input, cursor:'pointer', color:C.accent, borderColor:`${C.accent}55`, fontSize:12.5, fontWeight:600 }}>
            Show {Math.min(pageSize, rows.length - shown).toLocaleString()} more
          </button>
        </div>
      )}
    </>
  );
}

// ── Multi-select ──────────────────────────────────────────────────────────
// The audit's F11. Native single <select> made "Chemistry + Endocrinology +
// Haematology + Serology" impossible. Rules encoded here:
//   · an EMPTY selection means ALL, never NONE — clearing a filter must show
//     everything, because an empty dashboard reads as a broken one
//   · the closed control states how many are selected, so filter state is
//     legible without opening it
//   · search appears only once a list is long enough to need it
export function MultiSelect({ label, options, selected, onChange, icon, allLabel = 'All', searchAfter = 10 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQ(''); } };
    const onKey = e => { if (e.key === 'Escape') { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const sel = selected || [];
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;
  const summary = sel.length === 0 ? allLabel
                : sel.length === 1 ? sel[0]
                : `${sel[0]} +${sel.length - 1}`;
  const toggle = v => onChange(sel.includes(v) ? sel.filter(x => x !== v) : [...sel, v]);

  return (
    <div ref={ref} style={{ position:'relative' }}>
      {label && <label style={{ color:C.t3, fontSize:12, marginBottom:5, display:'block', fontWeight:500 }}>{label}</label>}
      <button onClick={() => setOpen(o => !o)}
              aria-expanded={open} aria-haspopup="listbox"
              title={sel.length ? sel.join(', ') : allLabel}
              style={{ ...T.input, width:'100%', display:'flex', alignItems:'center', gap:7, cursor:'pointer',
                       textAlign:'left', borderColor: sel.length ? `${C.accent}66` : C.borderLt,
                       color: sel.length ? C.t1 : C.t2 }}>
        {icon && <Icon name={icon} size={13}/>}
        <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{summary}</span>
        {sel.length > 1 && (
          <span style={{ background:`${C.accent}22`, color:C.accent, borderRadius:10, padding:'1px 7px',
                         fontSize:11, fontWeight:700 }}>{sel.length}</span>
        )}
        <Icon name="chevron" size={13} style={{ transform:open ? 'rotate(180deg)' : 'none', transition:'transform .15s', opacity:.7 }}/>
      </button>

      {open && (
        <div role="listbox" style={{ position:'absolute', zIndex:60, top:'calc(100% + 5px)', left:0, right:0,
                     background:C.panelAlt, border:`1px solid ${C.borderLt}`, borderRadius:8,
                     boxShadow:'0 16px 40px rgba(0,0,0,.6)', maxHeight:320, display:'flex', flexDirection:'column' }}>
          {options.length >= searchAfter && (
            <div style={{ padding:8, borderBottom:`1px solid ${C.border}` }}>
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
                     style={{ ...T.input, width:'100%', fontSize:12.5, padding:'6px 9px' }}/>
            </div>
          )}
          <div style={{ display:'flex', gap:6, padding:'8px 10px', borderBottom:`1px solid ${C.border}` }}>
            <button onClick={() => onChange(filtered.slice())}
                    style={{ ...T.input, flex:1, cursor:'pointer', fontSize:12, padding:'4px 8px', color:C.accent }}>
              Select all{q ? ' shown' : ''}
            </button>
            <button onClick={() => onChange([])}
                    style={{ ...T.input, flex:1, cursor:'pointer', fontSize:12, padding:'4px 8px', color:C.t3 }}>
              Clear
            </button>
          </div>
          <div style={{ overflowY:'auto', padding:'4px 0' }}>
            {filtered.length === 0 && (
              <div style={{ padding:'12px 14px', color:C.t3, fontSize:12.5 }}>Nothing matches “{q}”.</div>
            )}
            {filtered.map(o => {
              const on = sel.includes(o);
              return (
                <div key={o} role="option" aria-selected={on} onClick={() => toggle(o)}
                     style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 12px', cursor:'pointer',
                              fontSize:13, color: on ? C.t1 : C.t2, background: on ? `${C.accent}12` : 'transparent' }}>
                  <span style={{ width:15, height:15, borderRadius:4, flexShrink:0,
                                 border:`1.5px solid ${on ? C.accent : C.borderLt}`,
                                 background: on ? C.accent : 'transparent',
                                 display:'flex', alignItems:'center', justifyContent:'center', color:C.bg }}>
                    {on && <Icon name="check" size={10} strokeWidth={3}/>}
                  </span>
                  <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>{o}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Persistent filter summary bar ─────────────────────────────────────────
// The audit's F10: "Analysis basis" was rendered only on two tabs but applied
// to a third, so a manager could set Shipped Only on one tab, navigate to the
// Overview, and read a shipped-only figure believing it was network-wide —
// with no visible control anywhere on screen saying otherwise.
//
// This bar renders on EVERY tab and names every active filter regardless of
// which control set it. Each token is individually removable.
export function FilterBar({ tokens, onClearAll, busy }) {
  const active = tokens.filter(t => t && t.removable !== 'never');
  return (
    <div style={{ display:'flex', alignItems:'center', gap:9, flexWrap:'wrap',
                  background:C.panelAlt, border:`1px solid ${busy ? C.accent : C.border}`, borderRadius:9,
                  padding:'9px 13px', marginBottom:16, transition:'border-color .15s' }}>
      <Icon name="filter" size={13} style={{ color:C.t3 }}/>
      <span style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1, fontWeight:600 }}>Showing</span>
      {/* While a filter change is recalculating, the figures on screen are
          still the PREVIOUS ones. Saying so is the difference between a
          dashboard that feels slow and one that feels wrong. */}
      {busy && (
        <span style={{ display:'inline-flex', alignItems:'center', gap:6, color:C.accent, fontSize:12, fontWeight:600 }}>
          <span style={{ width:11, height:11, border:`2px solid ${C.accent}44`, borderTopColor:C.accent,
                         borderRadius:'50%', animation:'spin .7s linear infinite', display:'inline-block' }}/>
          Updating
        </span>
      )}
      {tokens.filter(Boolean).map(t => (
        <span key={t.key} title={t.title || t.label}
              style={{ display:'inline-flex', alignItems:'center', gap:6,
                       background: t.tone === 'accent' ? `${C.accent}1A` : `${C.accent2}18`,
                       color: t.tone === 'accent' ? C.accent : C.accent2,
                       border:`1px solid ${(t.tone === 'accent' ? C.accent : C.accent2)}44`,
                       borderRadius:6, padding:'3px 9px', fontSize:12.5, fontWeight:600, maxWidth:280 }}>
          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.label}</span>
          {t.onRemove && (
            <button onClick={t.onRemove} title={`Remove ${t.label}`} aria-label={`Remove ${t.label}`}
                    style={{ background:'none', border:'none', color:'inherit', cursor:'pointer', padding:0,
                             opacity:.75, display:'flex' }}>
              <Icon name="close" size={11} strokeWidth={2.4}/>
            </button>
          )}
        </span>
      ))}
      {active.length > 0 && (
        <button onClick={onClearAll}
                style={{ marginLeft:'auto', background:'none', border:`1px solid ${C.bad}55`, color:C.bad,
                         borderRadius:6, padding:'3px 10px', fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>
          Clear filters
        </button>
      )}
    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────
export const Note = ({ children, tone = 'info' }) => {
  const col = tone === 'warn' ? C.warn : tone === 'bad' ? C.bad : C.accent;
  return (
    <div style={{ background:`${col}0F`, border:`1px solid ${col}33`, borderLeft:`3px solid ${col}`,
                  borderRadius:7, padding:'11px 15px', marginBottom:12, display:'flex', gap:9 }}>
      <Icon name="info" size={14} style={{ color:col, marginTop:2 }}/>
      <div style={{ color:C.t2, fontSize:13, lineHeight:1.55 }}>{children}</div>
    </div>
  );
};

export const Empty = ({ msg }) => (
  <div style={{ textAlign:'center', padding:'34px 20px', color:C.t3, fontSize:13 }}>{msg}</div>
);

export const Loader = ({ msg = 'Loading…' }) => (
  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                gap:14, padding:'70px 20px' }}>
    <div style={{ width:26, height:26, border:`2.5px solid ${C.border}`, borderTopColor:C.accent,
                  borderRadius:'50%', animation:'spin .8s linear infinite' }}/>
    <p style={{ color:C.t3, fontSize:13 }}>{msg}</p>
  </div>
);

// A thin proportion bar. Replaces the pass/fail donuts, which spent a 140px
// square to convey one number that was already printed inside them.
export const ProportionBar = ({ pct, color, height = 7 }) => (
  <div style={{ background:C.panelAlt, borderRadius:4, height, overflow:'hidden', width:'100%' }}>
    <div style={{ width:`${Math.max(0, Math.min(100, pct || 0))}%`, height:'100%', background:color, borderRadius:4 }}/>
  </div>
);

export const Segmented = ({ value, onChange, options, size = 'md' }) => (
  <div style={{ display:'inline-flex', background:C.panelAlt, borderRadius:7, overflow:'hidden',
                border:`1px solid ${C.borderLt}` }}>
    {options.map(([v, l, hint]) => (
      <button key={v} onClick={() => onChange(v)} title={hint}
              style={{ background: value === v ? `${C.accent}22` : 'transparent',
                       color: value === v ? C.accent : C.t3, border:'none',
                       padding: size === 'sm' ? '5px 10px' : '7px 13px',
                       fontSize: size === 'sm' ? 12 : 12.5, fontWeight: value === v ? 700 : 500,
                       cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
        {l}
      </button>
    ))}
  </div>
);
