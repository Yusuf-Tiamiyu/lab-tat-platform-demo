/**
 * App.jsx — Lab network TAT Analytics, v3 (post-audit rebuild).
 *
 * Structural changes from v2, each traceable to a finding in the September
 * 2026 audit:
 *
 *   · Every displayed figure comes from lib/aggregate.js. No screen computes
 *     its own rate. This is what removed the 15.8-point Weekly/Monthly
 *     contradiction and the 10.7-point Haematology error — those existed
 *     because four code paths each rebuilt the same metric differently.
 *   · Information architecture is organised by DECISION, not by data domain:
 *     Overview → Performance → Failures → Trends → Logistics → Data Quality.
 *   · Filters are multi-select, and a persistent summary bar on every tab
 *     names every active filter, including the analysis basis. Previously the
 *     basis control rendered on two tabs but silently applied to a third.
 *   · Authentication is real. The old password was checked in browser JS
 *     after the data had already been delivered, and every table granted
 *     SELECT to the public role.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef, useTransition, Component } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ComposedChart, Cell, Area, AreaChart,
} from 'recharts';
import { supabase, fetchAllRows } from './lib/supabase';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';
import { LOGO_B64 } from './logo_b64';
import {
  C, T, Icon, SectionTitle, DataTable, MultiSelect, FilterBar, Note, Empty, Loader,
  KpiCard, RAGBadge, Segmented, ProportionBar, SITE_COLORS, rag, fmtN, fmtH, fmtPct, fmtOverTarget,
} from './ui.jsx';
import {
  aggregate, basisView, shippingImpact, bandPrefix, rowsInMonth, rowsInWeek, availableMonths,
  fmtMonthLbl, uniquePatientAgg, makeRowFilter, compare, BANDS, BAND_COLORS, MIN_COMPARISON_VOLUME,
} from './lib/aggregate.js';
import PageFailures from './pages/Failures.jsx';

// Catches a render-time crash anywhere in the tree and shows the error rather
// than a blank white page. main.jsx wraps <App/> in this.
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err:null }; }
  static getDerivedStateFromError(e) { return { err:e }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding:32, background:C.bg, minHeight:'100vh', fontFamily:'ui-monospace,monospace' }}>
        <h2 style={{ color:C.bad, marginBottom:14, display:'flex', alignItems:'center', gap:9, fontSize:18 }}>
          <Icon name="alertTri" size={18}/> Dashboard render error
        </h2>
        <p style={{ color:C.t3, marginBottom:10, fontSize:13 }}>
          Open DevTools (F12 → Console) for the full trace. Nothing has been written to the database.
        </p>
        <pre style={{ background:'#0D1117', padding:16, borderRadius:8, overflow:'auto', fontSize:12,
                      color:'#FCA5A5', border:`1px solid ${C.borderLt}`, maxHeight:420 }}>
          {(this.state.err?.toString() || '') + '\n\n' + (this.state.err?.stack || '')}
        </pre>
        <button onClick={() => this.setState({ err:null })}
                style={{ marginTop:16, background:C.border, border:`1px solid ${C.borderLt}`, color:C.t2,
                         padding:'9px 17px', borderRadius:7, cursor:'pointer', fontFamily:'inherit' }}>
          Retry
        </button>
      </div>
    );
  }
}

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#0B1220', border:`1px solid ${C.borderLt}`, borderRadius:8, padding:'10px 13px', fontSize:12.5 }}>
      <p style={{ color:C.t1, marginBottom:5, fontWeight:600 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color:p.color || C.t2, margin:0 }}>
          {p.name}: <b>{typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</b>
        </p>
      ))}
    </div>
  );
};

const fmtWeek = ws => {
  if (!ws) return '';
  const s = new Date(ws); const e = new Date(ws); e.setUTCDate(e.getUTCDate() + 6);
  return `${s.getUTCDate()} ${MO[s.getUTCMonth()]} – ${e.getUTCDate()} ${MO[e.getUTCMonth()]}`;
};

// ══════════════════════════════════════════════════════════════════════════
// AUTH LINK HANDLING
// ══════════════════════════════════════════════════════════════════════════
// When someone follows an invitation or a password-reset email, Supabase sends
// them back here with a one-time token in the URL. supabase-js exchanges that
// token for a session and then STRIPS IT FROM THE URL — so the only reliable
// moment to notice what kind of link it was is at module load, before the
// client has had a chance to clean up. Read it once, here.
//
// Without this the invitation flow silently half-works: the person is signed
// in for that one visit, never gets asked to choose a password, and can never
// sign in again.
const AUTH_LINK = (() => {
  if (typeof window === 'undefined') return { action:null, error:null };
  const raw = `${window.location.hash || ''}&${window.location.search || ''}`;
  const params = new URLSearchParams(raw.replace(/^[#?&]+/, '').replace(/#/g, '&'));
  const err = params.get('error_description') || params.get('error');
  const type = params.get('type');
  if (err) return { action:null, error:decodeURIComponent(err).replace(/\+/g, ' ') };
  if (type === 'invite' || type === 'recovery' || type === 'signup') return { action:'set_password', error:null };
  return { action:null, error:null };
})();

function SetPasswordScreen({ email, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const canSubmit = pw.length >= 8 && pw === pw2 && !busy;

  const submit = async e => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr('');
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setErr(error.message || 'Could not set the password.');
    else onDone();
  };

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center',
                  padding:'40px 24px', fontFamily:"system-ui,-apple-system,'Segoe UI',sans-serif" }}>
      <form onSubmit={submit} style={{ width:'100%', maxWidth:430, background:C.panel,
                   border:`1px solid ${C.border}`, borderRadius:14, padding:30 }}>
        <img src={LOGO_B64} alt="Demo Lab" style={{ height:32, marginBottom:20 }}/>
        <h2 style={{ color:C.t1, fontSize:19, fontWeight:700, margin:0 }}>Choose your password</h2>
        <p style={{ color:C.t3, fontSize:13.5, lineHeight:1.6, margin:'8px 0 22px' }}>
          {email ? <>You're signed in as <b style={{ color:C.t2 }}>{email}</b>. </> : null}
          Set a password now so you can sign in again next time.
        </p>

        <label htmlFor="np" style={{ color:C.t3, fontSize:12, fontWeight:600, textTransform:'uppercase',
                      letterSpacing:1.1, display:'block', marginBottom:6 }}>New password</label>
        <input id="np" type="password" autoComplete="new-password" autoFocus value={pw}
               onChange={e => setPw(e.target.value)}
               style={{ ...T.input, width:'100%', marginBottom:6, padding:'10px 12px', fontSize:14,
                        borderColor: tooShort ? C.bad : C.borderLt }}/>
        <p style={{ color: tooShort ? C.bad : C.t4, fontSize:12, marginBottom:14 }}>
          At least 8 characters.
        </p>

        <label htmlFor="np2" style={{ color:C.t3, fontSize:12, fontWeight:600, textTransform:'uppercase',
                      letterSpacing:1.1, display:'block', marginBottom:6 }}>Confirm password</label>
        <input id="np2" type="password" autoComplete="new-password" value={pw2}
               onChange={e => setPw2(e.target.value)}
               style={{ ...T.input, width:'100%', marginBottom:6, padding:'10px 12px', fontSize:14,
                        borderColor: mismatch ? C.bad : C.borderLt }}/>
        <p style={{ color: mismatch ? C.bad : 'transparent', fontSize:12, marginBottom:14 }}>
          The two passwords don't match.
        </p>

        {err && <p role="alert" style={{ color:C.bad, fontSize:12.5, marginBottom:14, lineHeight:1.5 }}>{err}</p>}

        <button type="submit" disabled={!canSubmit}
                style={{ width:'100%', background: canSubmit ? `linear-gradient(135deg,${C.accent},${C.accent2})` : '#1E3A4A',
                         color: canSubmit ? '#08121C' : C.t4, border:'none', borderRadius:8, padding:'11px',
                         fontWeight:800, fontSize:14, cursor: canSubmit ? 'pointer' : 'default', fontFamily:'inherit' }}>
          {busy ? 'Saving…' : 'Save password and continue →'}
        </button>
      </form>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// CHANGE PASSWORD (while signed in)
// ══════════════════════════════════════════════════════════════════════════
// Sends no email, so it is not affected by the mail rate limit that throttles
// invitations and reset links. This is what makes a temporary password
// workable: an administrator can create an account with a password they hand
// over, and the person changes it themselves on first sign in without waiting
// on an email that may be an hour away or sitting in a junk folder.
//
// The current password is verified before the new one is accepted. Supabase
// does not require that by default, which would mean anyone finding an
// unlocked laptop could lock the real owner out of their own account.
export function ChangePasswordModal({ email, onClose }) {
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const same = pw.length > 0 && pw === current;
  const canSubmit = current.length > 0 && pw.length >= 8 && pw === pw2 && !same && !busy;

  const submit = async e => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr('');
    // Re-check the current password by signing in with it.
    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password: current });
    if (authErr) {
      setBusy(false);
      setErr('That current password is not right. Check it and try again.');
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setErr(error.message || 'Could not change the password.');
    else { setDone(true); setTimeout(onClose, 1600); }
  };

  const field = (id, label, val, set, auto) => (
    <>
      <label htmlFor={id} style={{ color:C.t3, fontSize:12, fontWeight:600, textTransform:'uppercase',
                    letterSpacing:1.1, display:'block', marginBottom:6 }}>{label}</label>
      <input id={id} type="password" autoComplete={auto} value={val} onChange={e => set(e.target.value)}
             style={{ ...T.input, width:'100%', marginBottom:14, padding:'10px 12px', fontSize:14 }}/>
    </>
  );

  return (
    <div onClick={e => e.target === e.currentTarget && !busy && onClose()}
         style={{ position:'fixed', inset:0, background:'rgba(3,7,12,0.82)', zIndex:220,
                  display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <form onSubmit={submit} style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:14,
                   padding:28, width:'100%', maxWidth:430 }}>
        <div style={{ display:'flex', alignItems:'center', marginBottom:6 }}>
          <h3 style={{ color:C.t1, fontSize:17, fontWeight:700, flex:1, margin:0 }}>Change your password</h3>
          {!busy && (
            <button type="button" onClick={onClose}
                    style={{ background:'none', border:'none', color:C.t3, cursor:'pointer' }}>
              <Icon name="close" size={17}/>
            </button>
          )}
        </div>
        <p style={{ color:C.t3, fontSize:13, lineHeight:1.6, marginBottom:20 }}>
          Signed in as <b style={{ color:C.t2 }}>{email}</b>. No email is sent, so this works straight away.
        </p>

        {done ? (
          <div style={{ textAlign:'center', padding:'14px 0' }}>
            <Icon name="check" size={28} style={{ color:C.good }} strokeWidth={2.6}/>
            <p style={{ color:C.t1, fontSize:14, marginTop:10 }}>Password changed. Use it next time you sign in.</p>
          </div>
        ) : (
          <>
            {field('cur-pw', 'Current password', current, setCurrent, 'current-password')}
            {field('new-pw', 'New password', pw, setPw, 'new-password')}
            <p style={{ color: tooShort ? C.bad : C.t4, fontSize:12, marginTop:-8, marginBottom:12 }}>
              At least 8 characters.
            </p>
            {field('new-pw2', 'Confirm new password', pw2, setPw2, 'new-password')}
            {mismatch && <p style={{ color:C.bad, fontSize:12.5, marginBottom:12 }}>The two new passwords do not match.</p>}
            {same && <p style={{ color:C.bad, fontSize:12.5, marginBottom:12 }}>The new password must be different from the current one.</p>}
            {err && <p role="alert" style={{ color:C.bad, fontSize:12.5, marginBottom:12, lineHeight:1.5 }}>{err}</p>}
            <button type="submit" disabled={!canSubmit}
                    style={{ width:'100%', background: canSubmit ? `linear-gradient(135deg,${C.accent},${C.accent2})` : '#1E3A4A',
                             color: canSubmit ? '#08121C' : C.t4, border:'none', borderRadius:8, padding:'11px',
                             fontWeight:800, fontSize:14, cursor: canSubmit ? 'pointer' : 'default', fontFamily:'inherit' }}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LOGIN — real Supabase Auth
// ══════════════════════════════════════════════════════════════════════════
function LoginScreen({ onAuth }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentReset, setSentReset] = useState(false);

  const attempt = async e => {
    e?.preventDefault();
    if (!email || !pw || busy) return;
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    setBusy(false);
    if (error) {
      setErr(error.message === 'Invalid login credentials'
        ? 'Email or password not recognised. If you were invited but never chose a password, use “Forgot password” below.'
        : (error.message || 'Sign-in failed.'));
    } else {
      onAuth();
    }
  };

  // Self-service recovery. Without this, anyone whose invitation link expired
  // or who simply forgot has to go through an administrator, and the
  // administrator's only option is to set a password on their behalf — which
  // is exactly what per-person accounts are meant to avoid.
  const sendReset = async () => {
    if (!email) { setErr('Enter your email address first, then choose “Forgot password”.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    setBusy(false);
    if (error) setErr(error.message || 'Could not send the reset email.');
    else setSentReset(true);
  };

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center',
                  padding:'40px 24px', fontFamily:"system-ui,-apple-system,'Segoe UI',sans-serif" }}>
      <div style={{ width:'100%', maxWidth:960, display:'flex', gap:56, alignItems:'center',
                    flexWrap:'wrap', justifyContent:'center' }}>
        <div style={{ flex:'1 1 380px', minWidth:290, maxWidth:450 }}>
          <img src={LOGO_B64} alt="Demo Lab" style={{ height:38, marginBottom:26 }}/>
          <h1 style={{ color:C.t1, fontSize:38, fontWeight:800, lineHeight:1.12, margin:0, letterSpacing:-0.6 }}>
            Turnaround time,<br/><span style={{ color:C.accent }}>clearly seen.</span>
          </h1>
          <p style={{ color:C.t3, fontSize:14.5, lineHeight:1.7, marginTop:20, maxWidth:400 }}>
            See how every site, department and test is performing against its turnaround
            targets. Updated each week when the new data is uploaded.
          </p>
          <p style={{ color:C.t4, fontSize:12.5, lineHeight:1.6, marginTop:18, display:'flex', gap:8 }}>
            <Icon name="lock" size={13} style={{ marginTop:2 }}/>
            <span>Everyone has their own sign in. Use the account your administrator set up for
            you. Without it the data cannot be reached at all.</span>
          </p>
        </div>

        <form onSubmit={attempt} style={{ flex:'1 1 360px', minWidth:290, maxWidth:400,
                     background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, padding:30 }}>
          <h2 style={{ color:C.t1, fontSize:18, fontWeight:700, margin:0 }}>Secure access</h2>
          <p style={{ color:C.t3, fontSize:13, lineHeight:1.6, margin:'8px 0 22px' }}>
            This dashboard contains confidential operational data.
          </p>

          <label htmlFor="lt-email" style={{ color:C.t3, fontSize:12, fontWeight:600, textTransform:'uppercase',
                        letterSpacing:1.1, display:'block', marginBottom:6 }}>Email</label>
          <input id="lt-email" type="email" autoComplete="username" value={email}
                 onChange={e => setEmail(e.target.value)}
                 style={{ ...T.input, width:'100%', marginBottom:16, padding:'10px 12px', fontSize:14 }}/>

          <label htmlFor="lt-pw" style={{ color:C.t3, fontSize:12, fontWeight:600, textTransform:'uppercase',
                        letterSpacing:1.1, display:'block', marginBottom:6 }}>Password</label>
          <div style={{ position:'relative', marginBottom:18 }}>
            <input id="lt-pw" type={showPw ? 'text' : 'password'} autoComplete="current-password" value={pw}
                   onChange={e => setPw(e.target.value)}
                   style={{ ...T.input, width:'100%', padding:'10px 62px 10px 12px', fontSize:14 }}/>
            <button type="button" onClick={() => setShowPw(s => !s)}
                    style={{ position:'absolute', right:10, top:9, background:'none', border:'none',
                             color:C.t3, fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>

          {err && (
            <p role="alert" style={{ color:C.bad, fontSize:12.5, marginBottom:14, lineHeight:1.5 }}>{err}</p>
          )}
          {sentReset && (
            <p role="status" style={{ color:C.good, fontSize:12.5, marginBottom:14, lineHeight:1.5 }}>
              Check your inbox. We have sent a link to set a new password. It expires in one hour.
            </p>
          )}

          <button type="submit" disabled={busy || !email || !pw}
                  style={{ width:'100%', background: busy || !email || !pw ? '#1E3A4A' : `linear-gradient(135deg,${C.accent},${C.accent2})`,
                           color: busy || !email || !pw ? C.t4 : '#08121C', border:'none', borderRadius:8,
                           padding:'11px', fontWeight:800, fontSize:14, cursor: busy || !email || !pw ? 'default' : 'pointer',
                           fontFamily:'inherit' }}>
            {busy ? 'Signing in…' : 'Access dashboard →'}
          </button>

          <button type="button" onClick={sendReset} disabled={busy}
                  style={{ width:'100%', background:'none', border:'none', color:C.t3, marginTop:14,
                           fontSize:12.5, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline',
                           textUnderlineOffset:3 }}>
            Forgot password, or never set one?
          </button>
        </form>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════════════════════════════════════
// Every table a weekly upload writes to. A re-upload clears all of them for
// that week before saving, so it is a true replacement.
const UPLOAD_TABLES = ['weekly_kpi','weekly_site','weekly_dept','weekly_daily','weekly_daily_site',
  'weekly_daily_site_dept','weekly_daily_test','weekly_dept_site','weekly_routes','weekly_test_failures',
  'weekly_dq','weekly_referral','weekly_micro','weekly_hourly','weekly_hourly_site',
  'weekly_hourly_site_dept','weekly_shift_breakdown','weekly_top_tests','weekly_failures_detail',
  'weekly_failed_reqs'];

const fmtDay = d => {
  if (!d) return '';
  const x = new Date(`${d}T00:00:00Z`);
  return `${x.getUTCDate()} ${MO[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

function UploadModal({ onClose, onSuccess }) {
  const [file, setFile] = useState(null);
  // idle → checking → review → saving → done   (or error at any point)
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [data, setData] = useState(null);
  const [dateVerdict, setDateVerdict] = useState(null);
  const [existing, setExisting] = useState({ same:null, duplicates:[] });
  const [replaceDupes, setReplaceDupes] = useState(false);

  const diagnose = err => {
    const msg = String(err?.message || err || '');
    if (msg.toLowerCase().includes('failed to fetch')) return 'Cannot reach Supabase. Check the project is active.';
    if (msg.includes('42P01') || msg.includes('does not exist')) return 'A table or column is missing. Run the latest migration file, then try again.';
    if (msg.toLowerCase().includes('row-level security') || msg.includes('42501'))
      return 'This account is not allowed to upload. Uploading is limited to named accounts, '
           + 'so ask whoever administers the dashboard to add you, or sign in with the account '
           + 'that normally does the weekly upload.';
    return msg;
  };

  // Step 1: read and check the file. Nothing is saved here. The person sees
  // the week it covers, how many tests, whether any dates are broken, and
  // whether that week is already on the dashboard, and only then decides.
  const handleCheck = async () => {
    if (!file) return;
    setStage('checking'); setErrMsg(''); setReplaceDupes(false);
    try {
      setProgress('Reading the file…');
      const buf = await file.arrayBuffer();
      const { processExcelFile } = await import('./lib/processExcel');
      const { assessDates, classifyExisting } = await import('./lib/uploadChecks');
      const processed = processExcelFile(buf);
      setProgress('Checking what is already on the dashboard…');
      const { data: overlapping, error } = await supabase.from('weekly_kpi')
        .select('week_start,week_end,week_label,total_tests')
        .lte('week_start', processed.summary.week_end)
        .gte('week_end', processed.summary.week_start);
      if (error) throw error;
      // Also catch any stored week with impossible dates, wherever it sits,
      // since those are exactly the leftovers of a damaged upload.
      const { data: odd } = await supabase.from('weekly_kpi')
        .select('week_start,week_end,week_label,total_tests')
        .or('week_start.lt.2020-01-01,week_end.gt.2100-01-01');
      setData(processed);
      setDateVerdict(assessDates(processed.dateCheck));
      setExisting(classifyExisting(processed.summary, [...(overlapping || []), ...(odd || [])]));
      setStage('review');
    } catch (err) { setStage('error'); setErrMsg(diagnose(err)); }
  };

  // Step 2: save. Any week being replaced is cleared from every table first,
  // because saving only adds and updates rows, it never removes them. Without
  // the clear, a corrected re-upload would leave the old version's extra rows
  // behind and they would be counted alongside the new ones.
  const handleUpload = async () => {
    if (!data || dateVerdict?.level === 'block') return;
    setStage('saving'); setErrMsg('');
    try {
      const toClear = [data.summary.week_start,
        ...(replaceDupes ? existing.duplicates.map(d => d.week_start) : [])];
      for (const ws of [...new Set(toClear)]) {
        for (const t of UPLOAD_TABLES) {
          setProgress(`Clearing the previous copy of ${fmtDay(ws)}…`);
          const { error } = await supabase.from(t).delete().eq('week_start', ws);
          if (error) throw new Error(`[${t}] ${error.message}`);
        }
      }

      // weekly_kpi goes LAST. It is what puts a week into the week list, so
      // writing it last means a week only appears once all of its data is in.
      const upserts = [
        { t:'weekly_site',            p:data.sites,          c:'week_start,site' },
        { t:'weekly_dept',            p:data.departments,    c:'week_start,department' },
        { t:'weekly_daily',           p:data.daily,          c:'week_start,date' },
        { t:'weekly_daily_site',      p:data.dailySite,      c:'week_start,date,perf_site' },
        { t:'weekly_daily_site_dept', p:data.dailySiteDept,  c:'week_start,date,perf_site,department' },
        { t:'weekly_daily_test',      p:data.dailyTest,      c:'week_start,date,test_name,perf_site,department' },
        { t:'weekly_dept_site',       p:data.deptSite,       c:'week_start,perf_site,department' },
        { t:'weekly_routes',          p:data.routes,         c:'week_start,origin,destination' },
        { t:'weekly_test_failures',   p:data.testFailures,   c:'week_start,test_name,perf_site,department' },
        { t:'weekly_dq',              p:data.dataQuality,    c:'week_start' },
        { t:'weekly_referral',        p:data.referral,       c:'week_start,site' },
        { t:'weekly_micro',           p:data.microbiology,   c:'week_start,site' },
        { t:'weekly_hourly',          p:data.hourly,         c:'week_start,hour' },
        { t:'weekly_hourly_site',     p:data.hourlySite,     c:'week_start,perf_site,hour' },
        { t:'weekly_hourly_site_dept',p:data.hourlySiteDept, c:'week_start,perf_site,department,hour' },
        { t:'weekly_shift_breakdown', p:data.shiftBreakdown, c:'week_start,perf_site,department,shift' },
        { t:'weekly_top_tests',       p:data.topTests,       c:'week_start,test_name,perf_site,department' },
        { t:'weekly_failures_detail', p:data.failuresDetail, c:'week_start,req_number,test_name,perf_site,occurrence' },
        { t:'weekly_failed_reqs',     p:data.failedRequests, c:'week_start,req_number,department,perf_site' },
        { t:'weekly_kpi',             p:data.summary,        c:'week_start' },
      ];

      for (const u of upserts) {
        // weekly_kpi and weekly_dq are single objects, not arrays. `{...}.length`
        // is undefined, so a naive length check treats a real single-row payload
        // as "nothing to save" and skips it silently, with no error, because it
        // never even attempts the write.
        const rows = Array.isArray(u.p) ? u.p : (u.p ? [u.p] : []);
        if (!rows.length) continue;
        // A single request carrying several thousand rows risks a request-size
        // or statement-timeout limit, which would leave that one table empty
        // for the week while every smaller table succeeded — invisible until
        // someone notices a chart underperforming.
        const CHUNK = 500;
        const chunks = rows.length > CHUNK
          ? Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK))
          : [rows];
        for (let i = 0; i < chunks.length; i++) {
          setProgress(chunks.length > 1 ? `Saving ${u.t}… (${i + 1}/${chunks.length})` : `Saving ${u.t}…`);
          const { error } = await supabase.from(u.t).upsert(chunks[i], { onConflict:u.c });
          if (error) throw new Error(`[${u.t}] ${error.message}`);
        }
      }
      setStage('done');
      setProgress(`${data.summary.week_label}: ${data.summary.total_tests.toLocaleString()} tests uploaded.`);
      setTimeout(() => onSuccess(data.summary.week_start), 1500);
    } catch (err) {
      setStage('error');
      setErrMsg(`${diagnose(err)} The upload did not finish. Choose the same file and upload it again: `
              + 'it will clear the partial copy and save the full one, and no other week is affected.');
    }
  };

  const reset = () => { setStage('idle'); setData(null); setDateVerdict(null); setErrMsg(''); setReplaceDupes(false); };
  const blocked = dateVerdict?.level === 'block';
  const needsChoice = existing.duplicates.length > 0 && !replaceDupes;

  return (
    <div onClick={e => e.target === e.currentTarget && stage !== 'saving' && onClose()}
         style={{ position:'fixed', inset:0, background:'rgba(3,7,12,0.82)', zIndex:200,
                  display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, padding:28,
                    width:'100%', maxWidth: stage === 'review' ? 560 : 460, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', marginBottom:18 }}>
          <h3 style={{ color:C.t1, fontSize:17, fontWeight:700, flex:1, margin:0 }}>
            {stage === 'review' ? 'Check before uploading' : 'Upload weekly data'}
          </h3>
          {stage !== 'saving' && (
            <button onClick={onClose} style={{ background:'none', border:'none', color:C.t3, cursor:'pointer' }}>
              <Icon name="close" size={17}/>
            </button>
          )}
        </div>

        {stage === 'review' && data ? (() => {
          const s = data.summary;
          const days = Math.round((Date.parse(`${s.week_end}T00:00:00Z`) - Date.parse(`${s.week_start}T00:00:00Z`)) / 86400000) + 1;
          const tone = { ok:C.good, warn:C.warn, block:C.bad }[dateVerdict?.level || 'ok'];
          const row = (label, value, sub) => (
            <div style={{ display:'flex', gap:14, padding:'9px 0', borderBottom:`1px solid ${C.border}` }}>
              <span style={{ color:C.t3, fontSize:13, width:130, flexShrink:0 }}>{label}</span>
              <span style={{ color:C.t1, fontSize:13.5 }}>{value}{sub && <span style={{ display:'block', color:C.t4, fontSize:12, marginTop:2 }}>{sub}</span>}</span>
            </div>
          );
          return (
            <>
              <p style={{ color:C.t3, fontSize:13, lineHeight:1.6, marginBottom:12 }}>
                Nothing has been saved yet. Check these details match the file you meant to upload.
              </p>
              <div style={{ marginBottom:16 }}>
                {row('File', file?.name)}
                {row('Week covered', `${fmtDay(s.week_start)} to ${fmtDay(s.week_end)}`, `${days} day${days === 1 ? '' : 's'}`)}
                {row('Tests', fmtN(s.total_tests), `${fmtN(data.sites.length)} sites, ${fmtN(data.departments.length)} departments`)}
                {row('% Passed', s.compliance_pct != null ? `${s.compliance_pct}%` : 'N/A')}
              </div>

              <div style={{ background:`${tone}12`, border:`1px solid ${tone}44`, borderLeft:`3px solid ${tone}`,
                            borderRadius:7, padding:'11px 14px', marginBottom:12 }}>
                <p style={{ color:tone, fontSize:13.5, fontWeight:700, margin:'0 0 4px' }}>{dateVerdict?.title}</p>
                <p style={{ color:C.t2, fontSize:12.5, lineHeight:1.6, margin:0 }}>{dateVerdict?.detail}</p>
              </div>

              {existing.same && !blocked && (
                <div style={{ background:`${C.accent}10`, border:`1px solid ${C.accent}44`, borderLeft:`3px solid ${C.accent}`,
                              borderRadius:7, padding:'11px 14px', marginBottom:12 }}>
                  <p style={{ color:C.accent, fontSize:13.5, fontWeight:700, margin:'0 0 4px' }}>This week is already on the dashboard</p>
                  <p style={{ color:C.t2, fontSize:12.5, lineHeight:1.6, margin:0 }}>
                    It was uploaded as "{existing.same.week_label}" with {fmtN(existing.same.total_tests)} tests.
                    Uploading will replace it completely with this file.
                  </p>
                </div>
              )}

              {existing.duplicates.length > 0 && !blocked && (
                <div style={{ background:`${C.warn}12`, border:`1px solid ${C.warn}44`, borderLeft:`3px solid ${C.warn}`,
                              borderRadius:7, padding:'11px 14px', marginBottom:12 }}>
                  <p style={{ color:C.warn, fontSize:13.5, fontWeight:700, margin:'0 0 6px' }}>
                    These days are already covered by another upload
                  </p>
                  {existing.duplicates.map(d => (
                    <p key={d.week_start} style={{ color:C.t2, fontSize:12.5, lineHeight:1.6, margin:'0 0 4px' }}>
                      "{d.week_label}", {fmtN(d.total_tests)} tests
                    </p>
                  ))}
                  <p style={{ color:C.t3, fontSize:12.5, lineHeight:1.6, margin:'6px 0 10px' }}>
                    Keeping both would count the same tests twice. Tick below to remove the older copy
                    and keep this file instead.
                  </p>
                  <label style={{ display:'flex', alignItems:'center', gap:9, cursor:'pointer', color:C.t1, fontSize:13 }}>
                    <input type="checkbox" checked={replaceDupes} onChange={e => setReplaceDupes(e.target.checked)}/>
                    Replace {existing.duplicates.length === 1 ? 'that upload' : 'those uploads'} with this file
                  </label>
                </div>
              )}

              <div style={{ display:'flex', gap:10, marginTop:6 }}>
                <button onClick={reset}
                        style={{ ...T.input, flex:1, cursor:'pointer', padding:'11px', fontSize:13.5, fontWeight:600 }}>
                  Choose a different file
                </button>
                <button onClick={handleUpload} disabled={blocked || needsChoice}
                        title={blocked ? 'This file cannot be uploaded' : needsChoice ? 'Choose whether to replace the older copy first' : ''}
                        style={{ flex:1, background: blocked || needsChoice ? '#1B2735' : `linear-gradient(135deg,${C.accent},${C.accent2})`,
                                 color: blocked || needsChoice ? C.t4 : '#08121C', border:'none', borderRadius:8, padding:'11px',
                                 fontWeight:800, fontSize:14, cursor: blocked || needsChoice ? 'default' : 'pointer', fontFamily:'inherit' }}>
                  {blocked ? 'Cannot upload' : 'Upload'}
                </button>
              </div>
            </>
          );
        })() : stage === 'idle' || stage === 'error' ? (
          <>
            <label style={{ display:'block', border:`1.5px dashed ${file ? C.accent : C.borderLt}`, borderRadius:10,
                            padding:'26px 18px', textAlign:'center', cursor:'pointer', marginBottom:16 }}>
              <input type="file" accept=".xlsx,.xls" style={{ display:'none' }}
                     onChange={e => { setFile(e.target.files?.[0] || null); setStage('idle'); setErrMsg(''); }}/>
              <Icon name="download" size={22} style={{ color:file ? C.accent : C.t3, marginBottom:8 }}/>
              <div style={{ color: file ? C.t1 : C.t2, fontSize:13.5, wordBreak:'break-word' }}>
                {file ? file.name : 'Choose the weekly TAT Excel file'}
              </div>
              <div style={{ color:C.t4, fontSize:12, marginTop:5 }}>Must contain a sheet named “TAT Data”</div>
            </label>

            {errMsg && (
              <div style={{ background:`${C.bad}12`, border:`1px solid ${C.bad}44`, borderRadius:8,
                            padding:'11px 14px', marginBottom:14 }}>
                <p style={{ color:C.bad, fontSize:12.5, lineHeight:1.55, margin:0 }}>{errMsg}</p>
              </div>
            )}

            <button onClick={handleCheck} disabled={!file}
                    style={{ width:'100%', background: file ? `linear-gradient(135deg,${C.accent},${C.accent2})` : '#1B2735',
                             color: file ? '#08121C' : C.t4, border:'none', borderRadius:8, padding:'11px',
                             fontWeight:800, fontSize:14, cursor: file ? 'pointer' : 'default', fontFamily:'inherit' }}>
              Check file
            </button>
            <p style={{ color:C.t4, fontSize:12, textAlign:'center', marginTop:10 }}>
              Nothing is saved until you have seen the details and clicked Upload.
            </p>
          </>
        ) : stage === 'done' ? (
          <div style={{ textAlign:'center', padding:'18px 0' }}>
            <Icon name="check" size={30} style={{ color:C.good }} strokeWidth={2.6}/>
            <p style={{ color:C.t1, fontSize:14, marginTop:12 }}>{progress}</p>
          </div>
        ) : (
          <div style={{ textAlign:'center', padding:'18px 0' }}>
            <div style={{ width:26, height:26, border:`2.5px solid ${C.border}`, borderTopColor:C.accent,
                          borderRadius:'50%', animation:'spin .8s linear infinite', margin:'0 auto 14px' }}/>
            <p style={{ color:C.t2, fontSize:13.5 }}>{progress}</p>
            <p style={{ color:C.t4, fontSize:12, marginTop:8 }}>Do not close this window.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// OVERVIEW — "how did we do, and is it better than last period?"
// ══════════════════════════════════════════════════════════════════════════
// Three-way comparison of Overall, Local and Shipped. This replaces the three
// separate pie charts from the previous dashboard and answers the same
// question they were there to answer, but adds the counts behind each figure
// and states the conclusion in words rather than leaving the reader to compare
// three circles by eye.
function ComplianceCompare({ agg, impact, basis, onPick }) {
  if (!agg) return null;
  const cards = ['overall', 'local', 'shipped'].map(b => ({ key:b, ...basisView(agg, b) }));
  return (
    <div style={T.panel}>
      <SectionTitle sub="The same week measured three ways. If the local figure is much higher than the overall one, samples arriving from other sites are what is holding the overall result back.">
        Where the compliance figure comes from
      </SectionTitle>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(230px,1fr))', gap:14 }}>
        {cards.map(c => {
          const active = basis === c.key;
          return (
            <button key={c.key} onClick={() => onPick?.(c.key)}
                    title={`Show the whole dashboard on the ${c.label} basis`}
                    style={{ ...T.card, textAlign:'left', cursor:'pointer', fontFamily:'inherit',
                             borderColor: active ? C.accent : C.border,
                             background: active ? `${C.accent}0D` : C.panel,
                             display:'flex', flexDirection:'column', gap:9 }}>
              <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                <span style={{ color: active ? C.accent : C.t3, fontSize:12.5, fontWeight:700,
                               textTransform:'uppercase', letterSpacing:1.1 }}>{c.label}</span>
                {active && <span style={{ ...T.badge(C.accent), fontSize:10.5 }}>showing</span>}
              </div>
              <div style={{ fontSize:32, fontWeight:800, color:rag(c.compliance_pct), lineHeight:1,
                            fontVariantNumeric:'tabular-nums' }}>
                {c.compliance_pct == null ? 'N/A' : `${c.compliance_pct}%`}
              </div>
              <ProportionBar pct={c.compliance_pct} color={rag(c.compliance_pct)} height={8}/>
              <div style={{ color:C.t2, fontSize:13 }}>
                {fmtN(c.passed)} passed, <span style={{ color:C.bad }}>{fmtN(c.failed)} failed</span>
              </div>
              <div style={{ color:C.t4, fontSize:12, lineHeight:1.45 }}>
                out of {fmtN(c.measured)} tests we could measure. {c.note}
              </div>
            </button>
          );
        })}
      </div>
      {impact && (
        <div style={{ marginTop:14, background: impact.tone === 'bad' ? `${C.warn}12` : `${C.good}12`,
                      border:`1px solid ${impact.tone === 'bad' ? C.warn : C.good}44`,
                      borderLeft:`3px solid ${impact.tone === 'bad' ? C.warn : C.good}`,
                      borderRadius:7, padding:'12px 16px', color:C.t2, fontSize:13.5, lineHeight:1.6 }}>
          <b style={{ color:C.t1 }}>What this tells you: </b>{impact.text}
        </div>
      )}
    </div>
  );
}

export function PageOverview({ cur, prev, prevLabel, siteRows, deptRows, periodLabel,
                               excludeZeroTat, patients, onDrill, basis, setBasis }) {
  if (!cur) return <Empty msg="No data for the current selection."/>;

  // Every headline number below reads through basisView, so the Analysis basis
  // selector genuinely changes this page. Previously this screen ignored it
  // entirely while still appearing to be governed by it.
  const v = basisView(cur, basis);
  const pv = prev ? basisView(prev, basis) : null;
  const impact = shippingImpact(cur);
  // compare() needs objects carrying the fields it reads, so wrap the basis
  // view in the shape it expects rather than teaching it about bases.
  const cmpCur = v  ? { ...v, effective_measured: v.measured }  : null;
  const cmpPrev = pv ? { ...pv, effective_measured: pv.measured } : null;

  // "What needs attention" — the site×department cells whose compliance fell
  // most against the comparison period. This is the 30-second answer a
  // regional manager needs and the previous Overview could not give at all.
  const attention = useMemo(() => {
    if (!prev?.byCell) return [];
    return Object.entries(cur.byCell || {})
      .map(([k, a]) => {
        const p = prev.byCell[k];
        if (!p || !a) return null;
        const av = basisView(a, basis), pvv = basisView(p, basis);
        if (!av || !pvv) return null;
        if ((pvv.measured || 0) < MIN_COMPARISON_VOLUME) return null;
        if (av.compliance_pct == null || pvv.compliance_pct == null) return null;
        const [site, dept] = k.split('||');
        return { site, dept, now:av.compliance_pct, before:pvv.compliance_pct,
                 delta:+(av.compliance_pct - pvv.compliance_pct).toFixed(1), vol:av.measured };
      })
      .filter(Boolean).filter(x => x.delta < 0)
      .sort((a, b) => a.delta - b.delta).slice(0, 3);
  }, [cur, prev, basis]);

  const deptTable = useMemo(() => deptRows.map(d => {
    const dv = basisView(d, basis);
    return { _key:d.department, department:d.department, ...dv };
  }).filter(r => r.volume > 0), [deptRows, basis]);

  const siteTable = useMemo(() => siteRows.map(r => {
    const sv = basisView(r, basis);
    return { _key:r.site, site:r.site, ...sv,
             localPct:r.local_compliance_pct, shippedPct:r.shipped_compliance_pct };
  }).filter(r => r.volume > 0), [siteRows, basis]);

  return (
    <div>
      <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:18 }}>
        <KpiCard label={v.volumeLabel} value={fmtN(v.volume)}
                 sub={patients?.count != null && basis === 'overall'
                        ? `${fmtN(patients.count)} patients${patients.exact ? '' : ' (estimated)'}` : v.note}
                 cmp={compare(cmpCur, cmpPrev, 'volume', { unit:'%' })} cmpFmt={fmtN} periodLabel={prevLabel}/>
        <KpiCard label="% Passed" value={v.compliance_pct != null ? `${v.compliance_pct}%` : 'N/A'}
                 color={rag(v.compliance_pct)}
                 sub={`${fmtN(v.passed)} of ${fmtN(v.measured)} tests passed`}
                 cmp={compare(cmpCur, cmpPrev, 'compliance_pct')} cmpFmt={x => `${x}%`} periodLabel={prevLabel}
                 note={excludeZeroTat ? 'Tests recorded with no elapsed time have been left out' : null}/>
        <KpiCard label="Failed" value={fmtN(v.failed)} color={C.bad}
                 sub={v.measured ? `${(v.failed / v.measured * 100).toFixed(1)}% of tests failed` : null}
                 cmp={compare(cmpCur, cmpPrev, 'failed', { unit:'%', lowerIsBetter:true })} cmpFmt={fmtN} periodLabel={prevLabel}/>
        <KpiCard label="Average time taken" value={fmtH(v.avg_tat_hrs)}
                 sub={`Failed tests ran ${fmtH(cur.avg_overrun_hrs)} past target on average`}
                 cmp={compare(cmpCur, cmpPrev, 'avg_tat_hrs', { unit:'%', lowerIsBetter:true })} cmpFmt={fmtH} periodLabel={prevLabel}/>
        {basis !== 'local' && (
          <KpiCard label="Samples received in" value={fmtN(cur.shipped_rec_count)}
                   sub={cur.shipped_compliance_pct != null
                          ? `${cur.shipped_compliance_pct}% passed after arriving` : null}
                   color={C.purple}
                   note="Shipped in from another site. Timed from arrival, not from booking in."/>
        )}
      </div>

      <ComplianceCompare agg={cur} impact={impact} basis={basis} onPick={setBasis}/>

      {/* Needs attention */}
      <div style={T.panel}>
        <SectionTitle sub={`Site and department combinations whose compliance fell most against the ${prevLabel}. Combinations with fewer than ${MIN_COMPARISON_VOLUME} measurable tests are left out, because with so few tests the change is just noise.`}>
          What needs attention
        </SectionTitle>
        {attention.length === 0 ? (
          <Empty msg={prev ? 'No site or department declined materially against the previous period.' : 'No previous period available for comparison.'}/>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))', gap:14 }}>
            {attention.map(a => (
              <button key={`${a.site}-${a.dept}`} onClick={() => onDrill?.({ sites:[a.site], depts:[a.dept] })}
                      title="Filter the dashboard to this combination"
                      style={{ ...T.card, textAlign:'left', cursor:'pointer', fontFamily:'inherit',
                               borderColor:`${C.bad}55`, background:`${C.bad}0D` }}>
                <div style={{ color:C.t1, fontSize:14, fontWeight:700 }}>{a.site}</div>
                <div style={{ color:C.t3, fontSize:12.5, marginBottom:9 }}>{a.dept} · {fmtN(a.vol)} tests</div>
                <div style={{ display:'flex', alignItems:'baseline', gap:9 }}>
                  <span style={{ color:rag(a.now), fontSize:22, fontWeight:800, fontVariantNumeric:'tabular-nums' }}>{a.now}%</span>
                  <span style={{ color:C.bad, fontSize:13, fontWeight:700 }}>▼ {Math.abs(a.delta)} pp</span>
                </div>
                <div style={{ color:C.t4, fontSize:12, marginTop:3 }}>was {a.before}% in the {prevLabel}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Site league table */}
      <div style={T.panel}>
        <SectionTitle sub="Every performing site for the selected period. Click a row's site name to filter the dashboard to it.">
          Site performance, {periodLabel}
        </SectionTitle>
        <DataTable
          initialSort={{ key:'volume', dir:'desc' }}
          pageSize={30}
          cols={[
            { key:'site', label:'Site', render:r => (
                <button onClick={() => onDrill?.({ sites:[r.site] })}
                        title={`Show only ${r.site}`}
                        style={{ background:'none', border:'none', color:C.accent, cursor:'pointer',
                                 fontFamily:'inherit', fontSize:13, padding:0, textAlign:'left' }}>{r.site}</button>) },
            { key:'volume', label:'Tests done', align:'right', render:r => fmtN(r.volume) },
            { key:'passed', label:'Passed', align:'right', render:r => <span style={{ color:C.good }}>{fmtN(r.passed)}</span> },
            { key:'failed', label:'Failed', align:'right', render:r => <span style={{ color:C.bad }}>{fmtN(r.failed)}</span> },
            { key:'compliance_pct', label:'% Passed', align:'right', render:r => <RAGBadge v={r.compliance_pct}/> },
            { key:'avg_tat_hrs', label:'Average time', align:'right', render:r => fmtH(r.avg_tat_hrs) },
            { key:'localPct', label:'Local TAT', align:'right', render:r => <RAGBadge v={r.localPct}/> },
            { key:'shippedPct', label:'Shipped TAT', align:'right', render:r => <RAGBadge v={r.shippedPct}/> },
          ]}
          rows={siteTable}/>
        <p style={{ color:C.t4, fontSize:12, marginTop:10, lineHeight:1.55 }}>
          "Local TAT" is tests the site booked in and ran itself. "Shipped TAT" is samples that arrived
          from another site, measured from the moment they got here. A big gap between the two
          usually points at transport rather than the laboratory bench.
        </p>
      </div>

      {/* Department performance.
          This was a bar chart whose colours came out wrong. The <Cell> colours
          were generated from the UNSORTED list while the bars were drawn from
          the SORTED one, and Recharts pairs them by position, so every colour
          landed on the wrong bar: Haematology at 72% rendered green while
          Chemistry at 59% rendered red.
          A table removes the whole class of problem, because the number, the
          colour and the row are the same object. It also answers the question
          the chart could not: how many tests, how many passed, how many
          failed. */}
      <div style={T.panel}>
        <SectionTitle sub="Worst first. The coloured tag shows how each department is doing against its targets, and the counts show how much work sits behind that figure.">
          Department performance
        </SectionTitle>
        <DataTable
          initialSort={{ key:'compliance_pct', dir:'asc' }}
          pageSize={30}
          cols={[
            { key:'department', label:'Department', render:r => (
                <button onClick={() => onDrill?.({ depts:[r.department] })}
                        title={`Show only ${r.department}`}
                        style={{ background:'none', border:'none', color:C.accent, cursor:'pointer',
                                 fontFamily:'inherit', fontSize:13, padding:0, textAlign:'left' }}>{r.department}</button>) },
            { key:'volume', label:'Tests done', align:'right', render:r => fmtN(r.volume) },
            { key:'passed', label:'Passed', align:'right',
              render:r => <span style={{ color:C.good }}>{fmtN(r.passed)}</span> },
            { key:'failed', label:'Failed', align:'right',
              render:r => <span style={{ color:C.bad }}>{fmtN(r.failed)}</span> },
            { key:'compliance_pct', label:'% Passed', align:'right', render:r => <RAGBadge v={r.compliance_pct}/> },
            { key:'bar', label:'', sortable:false, render:r => (
                <div style={{ minWidth:110 }}>
                  <ProportionBar pct={r.compliance_pct} color={rag(r.compliance_pct)} height={7}/>
                </div>) },
            { key:'avg_tat_hrs', label:'Average time', align:'right', render:r => fmtH(r.avg_tat_hrs) },
          ]}
          rows={deptTable}/>
        <p style={{ color:C.t4, fontSize:12, marginTop:10, lineHeight:1.55 }}>
          Green means 90% or more passed, amber means 50% to 89%, red means under 50%.
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// PERFORMANCE — "where is it good and bad?"
// ══════════════════════════════════════════════════════════════════════════
export function PagePerformance({ dayRows, testRows, hourlyRows, shiftRows, basis, periodLabel, excludeZeroTat }) {
  // Top tests by volume. Restored from v2 and improved: it now aggregates the
  // per-day test grain, so it works for a MONTH as well as a week (v2's could
  // only ever describe one upload week), it is uncapped and sortable rather
  // than a fixed top 10, and it carries the failure-severity split.
  const topTests = useMemo(() => {
    const by = {};
    (testRows || []).forEach(r => { (by[`${r.test_name}||${r.department}`] ||= []).push(r); });
    return Object.entries(by).map(([k, rows]) => {
      const [test_name, department] = k.split('||');
      const a = aggregate(rows, { excludeZeroTat });
      const tv = basisView(a, basis);
      return { _key:k, test_name, department,
               volume:tv.volume, passed:tv.passed, failed:tv.failed,
               compliance_pct:tv.compliance_pct, avg_tat_hrs:tv.avg_tat_hrs,
               // Bands for the ACTIVE basis, so the four columns always add up
               // to the Late column next to them whichever basis is selected.
               fail_marginal: a[bandPrefix(basis) + 'marginal'] || 0,
               fail_moderate: a[bandPrefix(basis) + 'moderate'] || 0,
               fail_severe:   a[bandPrefix(basis) + 'severe']   || 0,
               fail_critical: a[bandPrefix(basis) + 'critical'] || 0,
               sites:new Set(rows.map(r => r.perf_site)).size };
    }).filter(r => r.volume > 0);
  }, [testRows, excludeZeroTat, basis]);

  const daily = useMemo(() => {
    const byDate = {};
    (dayRows || []).forEach(r => { (byDate[r.date] ||= []).push(r); });
    return Object.entries(byDate).map(([date, rows]) => {
      const a = aggregate(rows, { excludeZeroTat });
      const passed = basis === 'local' ? a.local_passed : basis === 'shipped' ? a.shipped_passed : a.effective_passed;
      const measured = basis === 'local' ? a.local_measured : basis === 'shipped' ? a.shipped_measured : a.effective_measured;
      const comp = basis === 'local' ? a.local_compliance_pct : basis === 'shipped' ? a.shipped_compliance_pct : a.compliance_pct;
      const tat = basis === 'local' ? a.local_avg_tat_hrs : basis === 'shipped' ? a.shipped_avg_tat_hrs : a.avg_tat_hrs;
      return { date, day: rows[0].day_name, dayShort:(rows[0].day_name || '').slice(0,3),
               // Passed + failed here are over the SAME population as `measured`,
               // so the stack always sums to the labelled total. In v2 the
               // shipped stack was counted over received samples while the
               // total came from all non-local tests, so the bars never added up.
               passed_n: passed, failed_n: Math.max(0, measured - passed),
               total: measured, compliance_pct: comp, avg_tat_hrs: tat };
    }).sort((a, b) => a.date.localeCompare(b.date));
    // NOTE: no .slice(0,7). Eight of fifteen upload weeks contain 8–9 days;
    // truncating to seven silently dropped up to 262 tests from the chart while
    // the KPI above it still counted them, so the bars didn't sum to the total.
  }, [dayRows, basis, excludeZeroTat]);

  const hourly = useMemo(() => {
    const byHour = {};
    (hourlyRows || []).forEach(r => {
      const v = basis === 'local' ? (r.local_count || 0) : basis === 'shipped' ? (r.shipped_count || 0) : (r.count || 0);
      byHour[r.hour] = (byHour[r.hour] || 0) + v;
    });
    return Object.entries(byHour).map(([h, count]) => ({ hour:+h, label:`${String(h).padStart(2,'0')}:00`, count }))
      .sort((a, b) => a.hour - b.hour);
  }, [hourlyRows, basis]);

  const shiftSite = useMemo(() => {
    const bucket = {};
    (shiftRows || []).forEach(r => { (bucket[`${r.perf_site}||${r.shift}`] ||= []).push(r); });
    const sites = [...new Set((shiftRows || []).map(r => r.perf_site))].sort();
    const shifts = [...new Set((shiftRows || []).map(r => r.shift))];
    const order = ['Morning (8am-2pm)','Handover (2pm-4pm)','Afternoon (4pm-8pm)','Night (8pm-8am)','Outside Hours'];
    return { bucket, sites, shifts: order.filter(s => shifts.includes(s)) };
  }, [shiftRows]);

  return (
    <div>
      <div style={T.panel}>
        <SectionTitle sub="Blue bars are passed and failed tests stacked to the measurable total; the amber line is compliance. Every day in the period is shown.">
          Daily volume and performance, {periodLabel}
        </SectionTitle>
        {daily.length === 0 ? <Empty msg="No daily data for the current filters."/> : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={daily} margin={{ top:20, right:60, left:10, bottom:6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#16202F"/>
              <XAxis dataKey="dayShort" tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
              <YAxis yAxisId="l" tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
              <YAxis yAxisId="r" orientation="right" domain={[0,100]} tick={{ fill:C.t3, fontSize:12 }}
                     tickFormatter={v => `${v}%`} axisLine={false} tickLine={false}/>
              <Tooltip content={<CT/>}/>
              <Legend wrapperStyle={{ fontSize:12.5, color:C.t3 }}/>
              <Bar yAxisId="l" dataKey="passed_n" name="Passed" stackId="a" fill={C.good} radius={[0,0,0,0]}/>
              <Bar yAxisId="l" dataKey="failed_n" name="Failed" stackId="a" fill={C.bad} radius={[4,4,0,0]}/>
              <Line yAxisId="r" type="monotone" dataKey="compliance_pct" name="Compliance %"
                    stroke={C.warn} strokeWidth={2.4} dot={{ r:3, fill:C.warn }}/>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(340px,1fr))', gap:18 }}>
        <div style={{ ...T.panel, marginBottom:0 }}>
          <SectionTitle sub="When samples are entered into the LIS. A large after-midnight block usually means backdated entry rather than genuine night work.">
            Entry time distribution
          </SectionTitle>
          {hourly.length === 0 ? <Empty msg="No hourly data for these filters."/> : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={hourly} margin={{ top:4, right:14, left:8, bottom:4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16202F" vertical={false}/>
                <XAxis dataKey="label" tick={{ fill:C.t3, fontSize:11 }} axisLine={false} tickLine={false} interval={2}/>
                <YAxis tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
                <Tooltip content={<CT/>}/>
                <Bar dataKey="count" name="Tests entered" radius={[4,4,0,0]}>
                  {hourly.map((h, i) => <Cell key={i} fill={h.hour < 6 ? C.purple : C.accent}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ ...T.panel, marginBottom:0 }}>
          <SectionTitle sub="How each site performed on each shift, with the number of tests behind every figure. Available in Weekly view only, because shifts are recorded per upload week.">
            Performance by site and shift
          </SectionTitle>
          {shiftSite.sites.length === 0 ? (
            <Empty msg="Shift data is available in Weekly view only."/>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <div style={{ display:'grid',
                            gridTemplateColumns:`120px repeat(${shiftSite.shifts.length}, minmax(74px,1fr))`, gap:4,
                            minWidth:120 + shiftSite.shifts.length * 78 }}>
                <div/>
                {shiftSite.shifts.map(s => (
                  <div key={s} title={s} style={{ color:C.t3, fontSize:11, textAlign:'center', fontWeight:600, paddingBottom:5 }}>
                    {s.split(' ')[0]}
                  </div>
                ))}
                {shiftSite.sites.map(site => (
                  <React.Fragment key={site}>
                    <div style={{ color:C.t2, fontSize:12.5, display:'flex', alignItems:'center',
                                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={site}>{site}</div>
                    {shiftSite.shifts.map(sh => {
                      const rows = shiftSite.bucket[`${site}||${sh}`];
                      if (!rows?.length) return <div key={sh} style={{ background:'#0A0F18', borderRadius:5, minHeight:46 }}/>;
                      // Reads through basisView so this grid answers to the
                      // Analysis basis selector like everything else.
                      const sv = basisView(aggregate(rows, { excludeZeroTat }), basis);
                      if (!sv || !sv.measured) return <div key={sh} style={{ background:'#0A0F18', borderRadius:5, minHeight:46 }}/>;
                      const val = sv.compliance_pct;
                      const col = rag(val);
                      return (
                        <div key={sh}
                             title={`${site}, ${sh}\n${fmtN(sv.passed)} on time and ${fmtN(sv.failed)} late, out of ${fmtN(sv.measured)} tests`}
                             style={{ background:`${col}26`, border:`1px solid ${col}55`, borderRadius:5, minHeight:46,
                                      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:1,
                                      color:col, fontVariantNumeric:'tabular-nums' }}>
                          <span style={{ fontSize:13, fontWeight:700 }}>{val == null ? 'N/A' : `${Math.round(val)}%`}</span>
                          {/* The count was previously only in the tooltip, so "50%" could
                              mean 1 test in 2 or 500 in 1,000. It now sits on the tile. */}
                          <span style={{ fontSize:10.5, color:C.t3 }}>{fmtN(sv.measured)} tests</span>
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...T.panel, marginTop:18 }}>
        <SectionTitle sub="Every test carried out in this period. The four columns on the right break the failures down by severity, and they always add up to the Failed column.">
          Tests carried out, and how they performed
        </SectionTitle>
        {topTests.length === 0 ? (
          <Empty msg="Test level figures load when you open this tab. If it stays empty, this week was uploaded before the test breakdown existed, so upload it again."/>
        ) : (
          <>
            <DataTable maxH={560} pageSize={25}
              initialSort={{ key:'volume', dir:'desc' }}
              cols={[
                { key:'test_name', label:'Test', wrap:true, maxW:'240px' },
                { key:'department', label:'Department' },
                { key:'sites', label:'Sites', align:'right' },
                { key:'volume', label:'Tests done', align:'right', render:r => fmtN(r.volume) },
                { key:'passed', label:'Passed', align:'right', render:r => <span style={{ color:C.good }}>{fmtN(r.passed)}</span> },
                { key:'failed', label:'Failed', align:'right', render:r => <span style={{ color:C.bad, fontWeight:700 }}>{fmtN(r.failed)}</span> },
                { key:'compliance_pct', label:'% Passed', align:'right', render:r => <RAGBadge v={r.compliance_pct}/> },
                { key:'avg_tat_hrs', label:'Average time', align:'right', render:r => fmtH(r.avg_tat_hrs) },
                // All FOUR bands are shown. Previously Moderate was left out,
                // so the columns could never reconcile with the Late total and
                // the table quietly looked wrong to anyone who added them up.
                { key:'fail_marginal', label:'Marginal', align:'right',
                  render:r => <span style={{ color:BAND_COLORS.marginal }}>{fmtN(r.fail_marginal)}</span> },
                { key:'fail_moderate', label:'Moderate', align:'right',
                  render:r => <span style={{ color:BAND_COLORS.moderate }}>{fmtN(r.fail_moderate)}</span> },
                { key:'fail_severe', label:'Severe', align:'right',
                  render:r => <span style={{ color:BAND_COLORS.severe }}>{fmtN(r.fail_severe)}</span> },
                { key:'fail_critical', label:'Critical', align:'right',
                  render:r => <span style={{ color:r.fail_critical ? BAND_COLORS.critical : C.t3,
                                             fontWeight:r.fail_critical ? 700 : 400 }}>{fmtN(r.fail_critical)}</span> },
              ]}
              rows={topTests}/>
            <p style={{ color:C.t4, fontSize:12, marginTop:10, lineHeight:1.6 }}>
              Marginal means within 30 minutes of target, or within 15% of it for tests with a long
              target. These four columns always add up to the Failed column, so you can see at a
              glance whether a test is missing its target narrowly or badly.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TRENDS — "are we improving?"
// ══════════════════════════════════════════════════════════════════════════
export function PageTrends({ dayRows, siteDayRows, allWeeks, excludeZeroTat, basis }) {
  const [grain, setGrain] = useState('weekly');

  // ── Site × month heatmap ────────────────────────────────────────────────
  const heatmap = useMemo(() => {
    const months = availableMonths(siteDayRows).slice().sort();
    const cells = {};
    const siteSet = new Set();
    months.forEach(m => {
      rowsInMonth(siteDayRows, m).forEach(r => {
        siteSet.add(r.perf_site);
        (cells[`${r.perf_site}||${m}`] ||= []).push(r);
      });
    });
    return {
      months,
      sites: [...siteSet].sort(),
      cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, aggregate(v, { excludeZeroTat })])),
    };
  }, [siteDayRows, excludeZeroTat]);

  // ── Daily compliance calendar ───────────────────────────────────────────
  const calMonths = useMemo(() => availableMonths(dayRows), [dayRows]);
  const [calMonth, setCalMonth] = useState(null);
  const activeCal = calMonth || calMonths[0] || null;
  useEffect(() => { if (!calMonth && calMonths.length) setCalMonth(calMonths[0]); }, [calMonths, calMonth]);

  const calDays = useMemo(() => {
    if (!activeCal) return [];
    const byDate = {};
    rowsInMonth(dayRows, activeCal).forEach(r => { (byDate[r.date] ||= []).push(r); });
    return Object.entries(byDate).map(([date, rows]) => {
      const a = aggregate(rows, { excludeZeroTat });
      const compliance = basis === 'local' ? a.local_compliance_pct
                       : basis === 'shipped' ? a.shipped_compliance_pct : a.compliance_pct;
      return { date, compliance, total:a.total_tests, failed:a.failed };
    }).sort((x, y) => x.date.localeCompare(y.date));
  }, [dayRows, activeCal, excludeZeroTat, basis]);

  // Blank cells before the first day so the grid lines up under Mon–Sun.
  const calLead = useMemo(() => {
    if (!calDays.length) return 0;
    const d = new Date(`${calDays[0].date}T00:00:00Z`).getUTCDay();  // 0=Sun
    return (d + 6) % 7;                                              // shift to Mon-first
  }, [calDays]);

  const series = useMemo(() => {
    const buckets = {};
    (dayRows || []).forEach(r => {
      const k = grain === 'weekly' ? r.week_start : (r.date || '').slice(0, 7);
      if (!k) return;
      (buckets[k] ||= []).push(r);
    });
    return Object.entries(buckets).map(([k, rows]) => {
      const a = aggregate(rows, { excludeZeroTat });
      return {
        key: k,
        label: grain === 'weekly' ? fmtWeek(k) : fmtMonthLbl(k),
        total: a.total_tests,
        compliance: basis === 'local' ? a.local_compliance_pct : basis === 'shipped' ? a.shipped_compliance_pct : a.compliance_pct,
        avg_tat: basis === 'local' ? a.local_avg_tat_hrs : basis === 'shipped' ? a.shipped_avg_tat_hrs : a.avg_tat_hrs,
        failed: a.failed,
        marginal: a.fail_marginal, moderate: a.fail_moderate, severe: a.fail_severe, critical: a.fail_critical,
      };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }, [dayRows, grain, excludeZeroTat, basis]);

  return (
    <div>
      <div style={T.panel}>
        <SectionTitle
          sub="Bars are test volume; the line is compliance, RAG-coloured at each point. Monthly buckets are built from each day's own date, and overlapping upload windows are de-duplicated."
          right={<Segmented value={grain} onChange={setGrain}
                            options={[['weekly','Weekly'],['monthly','Monthly']]}/>}>
          Volume and compliance over time
        </SectionTitle>
        {series.length === 0 ? <Empty msg="No trend data for the current filters."/> : (
          <ResponsiveContainer width="100%" height={330}>
            <ComposedChart data={series} margin={{ top:20, right:60, left:10, bottom:series.length > 8 ? 60 : 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#16202F"/>
              <XAxis dataKey="label" tick={{ fill:C.t3, fontSize:11.5 }} axisLine={false} tickLine={false}
                     angle={series.length > 8 ? -40 : 0} textAnchor={series.length > 8 ? 'end' : 'middle'}
                     height={series.length > 8 ? 70 : 30} interval={0}/>
              <YAxis yAxisId="l" tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
              <YAxis yAxisId="r" orientation="right" domain={[0,100]} tick={{ fill:C.t3, fontSize:12 }}
                     tickFormatter={v => `${v}%`} axisLine={false} tickLine={false}/>
              <Tooltip content={<CT/>}/>
              <Legend wrapperStyle={{ fontSize:12.5 }}/>
              <Bar yAxisId="l" dataKey="total" name="Tests" fill={`${C.accent}66`} radius={[4,4,0,0]}/>
              <Line yAxisId="r" type="monotone" dataKey="compliance" name="Compliance %" stroke={C.warn}
                    strokeWidth={2.4} dot={p => {
                      const { cx, cy, payload } = p;
                      if (cx == null || cy == null) return null;
                      return <circle key={payload.key} cx={cx} cy={cy} r={4} fill={rag(payload.compliance)} stroke="#0B1220" strokeWidth={1.5}/>;
                    }}/>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={T.panel}>
        <SectionTitle sub="Failures split by severity over time. A rising Critical band is a different problem from a rising Marginal band, and needs a different response.">
          Failure severity over time
        </SectionTitle>
        {series.length === 0 ? <Empty msg="No data."/> : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={series} margin={{ top:8, right:20, left:10, bottom:series.length > 8 ? 60 : 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#16202F" vertical={false}/>
              <XAxis dataKey="label" tick={{ fill:C.t3, fontSize:11.5 }} axisLine={false} tickLine={false}
                     angle={series.length > 8 ? -40 : 0} textAnchor={series.length > 8 ? 'end' : 'middle'}
                     height={series.length > 8 ? 70 : 30} interval={0}/>
              <YAxis tick={{ fill:C.t3, fontSize:12 }} axisLine={false} tickLine={false}/>
              <Tooltip content={<CT/>}/>
              <Legend wrapperStyle={{ fontSize:12.5 }}/>
              {BANDS.map(b => (
                <Bar key={b.key} dataKey={b.key} name={b.label} stackId="s" fill={BAND_COLORS[b.key]}/>
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Site × month heatmap — restored from v2. Cross-sectional comparison
          over time is the one thing a line chart per site does badly. */}
      <div style={T.panel}>
        <SectionTitle sub="Every site compared side by side across months. Green ≥90%, amber 50–89%, red <50%. Respects the current filters and analysis basis.">
          Site × month compliance
        </SectionTitle>
        {heatmap.months.length === 0 ? <Empty msg="No monthly data."/> : (
          <div style={{ overflowX:'auto' }}>
            <div style={{ display:'grid',
                          gridTemplateColumns:`minmax(130px,150px) repeat(${heatmap.months.length}, minmax(76px,1fr))`,
                          gap:4, minWidth:150 + heatmap.months.length * 80 }}>
              <div/>
              {heatmap.months.map(m => (
                <div key={m} style={{ color:C.t3, fontSize:11.5, textAlign:'center', fontWeight:600, paddingBottom:5 }}>
                  {fmtMonthLbl(m).replace(' 2026','')}
                </div>
              ))}
              {heatmap.sites.map(s => (
                <React.Fragment key={s}>
                  <div style={{ color:C.t2, fontSize:12.5, display:'flex', alignItems:'center',
                                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={s}>{s}</div>
                  {heatmap.months.map(m => {
                    const a = heatmap.cells[`${s}||${m}`];
                    if (!a) return <div key={m} style={{ background:'#0A0F18', borderRadius:5, minHeight:34 }}/>;
                    const v = basis === 'local' ? a.local_compliance_pct
                            : basis === 'shipped' ? a.shipped_compliance_pct : a.compliance_pct;
                    const col = rag(v);
                    return (
                      <div key={m} title={`${s} · ${fmtMonthLbl(m)}\n${v == null ? 'no measurable tests' : `${v}% compliance`} on ${fmtN(a.total_tests)} tests`}
                           style={{ background:`${col}26`, border:`1px solid ${col}55`, borderRadius:5, minHeight:34,
                                    display:'flex', alignItems:'center', justifyContent:'center',
                                    color:col, fontSize:12.5, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>
                        {v == null ? 'N/A' : `${Math.round(v)}%`}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Daily compliance calendar — restored from v2. Good for spotting a
          single bad day, and weekday patterns a monthly figure hides. */}
      <div style={T.panel}>
        <SectionTitle
          sub="Every uploaded day, coloured by compliance. Overlapping upload windows are de-duplicated, so a day appears once even when two extracts contain it."
          right={
            <select value={calMonth || ''} onChange={e => setCalMonth(e.target.value)} style={{ ...T.input, cursor:'pointer' }}>
              {calMonths.map(m => <option key={m} value={m}>{fmtMonthLbl(m)}</option>)}
            </select>
          }>
          Daily compliance calendar
        </SectionTitle>
        {calDays.length === 0 ? <Empty msg="No days in this month."/> : (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:6, maxWidth:560 }}>
              {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                <div key={d} style={{ color:C.t3, fontSize:11.5, textAlign:'center', fontWeight:600 }}>{d}</div>
              ))}
              {Array.from({ length:calLead }).map((_, i) => <div key={`b${i}`}/>)}
              {calDays.map(d => {
                const col = rag(d.compliance);
                return (
                  <div key={d.date}
                       title={`${d.date}\n${d.compliance == null ? 'no measurable tests' : `${d.compliance}% compliance`} · ${fmtN(d.total)} tests · ${fmtN(d.failed)} failed`}
                       style={{ background:`${col}22`, border:`1px solid ${col}55`, borderRadius:6, padding:'6px 4px',
                                minHeight:52, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2 }}>
                    <span style={{ color:C.t3, fontSize:11 }}>{+d.date.slice(8)}</span>
                    <span style={{ color:col, fontSize:12.5, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>
                      {d.compliance == null ? 'N/A' : `${Math.round(d.compliance)}%`}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display:'flex', gap:16, marginTop:12, flexWrap:'wrap', color:C.t3, fontSize:12 }}>
              {[['≥90%',C.good],['50–89%',C.warn],['<50%',C.bad]].map(([l,col]) => (
                <span key={l} style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <i style={{ width:11, height:11, borderRadius:3, background:`${col}40`, border:`1px solid ${col}`, display:'inline-block' }}/>{l}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={T.panel}>
        <SectionTitle sub="Every period under the current filters, newest first.">Period summary</SectionTitle>
        <DataTable
          initialSort={{ key:'key', dir:'desc' }}
          cols={[
            { key:'label', label: grain === 'weekly' ? 'Week' : 'Month' },
            { key:'total', label:'Tests', align:'right', render:r => fmtN(r.total) },
            { key:'compliance', label:'Compliance', align:'right', render:r => <RAGBadge v={r.compliance}/> },
            { key:'failed', label:'Failed', align:'right', render:r => <span style={{ color:C.bad }}>{fmtN(r.failed)}</span> },
            { key:'avg_tat', label:'Avg TAT', align:'right', render:r => fmtH(r.avg_tat) },
            { key:'marginal', label:'Marginal', align:'right', render:r => fmtN(r.marginal) },
            { key:'moderate', label:'Moderate', align:'right', render:r => fmtN(r.moderate) },
            { key:'severe', label:'Severe', align:'right', render:r => fmtN(r.severe) },
            { key:'critical', label:'Critical', align:'right', render:r => <span style={{ color:C.bad, fontWeight:700 }}>{fmtN(r.critical)}</span> },
          ]}
          rows={series.map(s => ({ ...s, _key:s.key }))}/>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LOGISTICS
// ══════════════════════════════════════════════════════════════════════════
export function PageLogistics({ routes, referral }) {
  const refSorted = [...(referral || [])].filter(r => r.total_originated > 0)
    .sort((a, b) => b.referral_rate_pct - a.referral_rate_pct);
  return (
    <div>
      <Note>Logistics is measured on originating and receiving sites, so the site and department
        filters do not apply here, because they would give a misleading picture of a route.</Note>

      <div style={T.panel}>
        <SectionTitle sub="Share of a site's own requisitions performed at another laboratory. Higher means more dependence on transport, and a longer end-to-end wait for the patient.">
          Referral rate by originating site
        </SectionTitle>
        {refSorted.length === 0 ? <Empty msg="No referral data for this week."/> : (
          <ResponsiveContainer width="100%" height={Math.max(240, refSorted.length * 32)}>
            <BarChart data={refSorted} layout="vertical" margin={{ top:4, right:56, left:8, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#16202F" horizontal={false}/>
              <XAxis type="number" domain={[0,100]} tick={{ fill:C.t3, fontSize:12 }}
                     tickFormatter={v => `${v}%`} axisLine={false} tickLine={false}/>
              <YAxis dataKey="site" type="category" tick={{ fill:C.t2, fontSize:12 }} width={130}
                     axisLine={false} tickLine={false} interval={0}/>
              <Tooltip content={<CT/>}/>
              <Bar dataKey="referral_rate_pct" name="Referral rate %" radius={[0,4,4,0]}>
                {refSorted.map((e, i) => <Cell key={i} fill={SITE_COLORS[i % SITE_COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={T.panel}>
        <SectionTitle sub="Transport and post-receipt analytical performance per route. Median transport is shown alongside the mean because a single stuck consignment badly skews the mean.">
          Shipment route performance
        </SectionTitle>
        <DataTable
          initialSort={{ key:'count', dir:'desc' }}
          cols={[
            { key:'origin', label:'Origin' },
            { key:'destination', label:'Destination' },
            { key:'count', label:'Samples', align:'right', render:r => fmtN(r.count) },
            { key:'avg_transport_hrs', label:'Mean transit', align:'right', render:r => fmtH(r.avg_transport_hrs) },
            { key:'median_transport_hrs', label:'Median transit', align:'right', render:r => fmtH(r.median_transport_hrs) },
            { key:'max_transport_hrs', label:'Worst transit', align:'right',
              render:r => <span style={{ color:r.max_transport_hrs > 48 ? C.bad : C.t2 }}>{fmtH(r.max_transport_hrs)}</span> },
            { key:'avg_analytical_tat_hrs', label:'Analytical TAT', align:'right', render:r => fmtH(r.avg_analytical_tat_hrs) },
            { key:'analytical_compliance_pct', label:'Compliance', align:'right', render:r => <RAGBadge v={r.analytical_compliance_pct}/> },
          ]}
          rows={(routes || []).map((r, i) => ({ ...r, _key:i }))}/>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// DATA QUALITY
// ══════════════════════════════════════════════════════════════════════════
export function PageQuality({ dq, agg, excludeZeroTat, setExcludeZeroTat }) {
  if (!dq) return <Empty msg="No data-quality record for this week."/>;
  const tiles = [
    { label:'Unmeasurable tests', v:dq.unmeasured_tests, tone: dq.unmeasured_tests > 0 ? 'warn' : 'ok',
      note:'Missing Ver-Ent or Target TAT. Excluded from compliance rather than scored as failures.' },
    { label:'Zero-TAT tests', v:dq.zero_tat_count, tone: dq.zero_tat_count > 0 ? 'warn' : 'ok',
      note:'Verified at the same instant as entry. Always score as passes, so they can only inflate compliance.' },
    { label:'Duplicate rows', v:dq.duplicate_rows, tone: dq.duplicate_rows > 0 ? 'warn' : 'ok',
      note:'Same test, same requisition, same entry instant. Counted but not removed, because only the laboratory can say which are genuine repeats.' },
    { label:'Extreme TAT outliers', v:dq.extreme_outliers_count, tone:'info',
      note:'Above the 99.5th percentile for the week.' },
    { label:'Transit over 24 h', v:dq.transport_over24h, tone: dq.transport_over24h > 0 ? 'warn' : 'ok' },
    { label:'Transit over 48 h', v:dq.transport_over48h, tone: dq.transport_over48h > 0 ? 'bad' : 'ok' },
    { label:'Negative transit', v:dq.transport_negative, tone: dq.transport_negative > 0 ? 'bad' : 'ok',
      note:'Received before it was booked in, which is impossible, so a clock or typing error.' },
    { label:'Unmapped sites', v:dq.unmapped_site_count, tone: dq.unmapped_site_count > 0 ? 'bad' : 'ok',
      note:'Performing-site codes with no entry in the site map. These now fall into a visible "Unmapped site" bucket instead of vanishing from site totals.' },
    { label:'Unknown req prefix', v:dq.unknown_origin_count, tone: dq.unknown_origin_count > 0 ? 'warn' : 'ok',
      note:'Requisition prefixes not in the origin map. These are treated as non-local, which affects the local/shipped split.' },
  ];
  const toneCol = t => t === 'bad' ? C.bad : t === 'warn' ? C.warn : t === 'ok' ? C.good : C.accent;

  return (
    <div>
      <div style={T.panel}>
        <SectionTitle sub="Compliance can be reported with or without zero-TAT records. Both are shown so the adjustment is a visible, defensible choice rather than a hidden assumption.">
          Compliance basis
        </SectionTitle>
        <div style={{ display:'flex', gap:22, flexWrap:'wrap', alignItems:'center' }}>
          <div>
            <div style={{ color:C.t3, fontSize:12.5 }}>Including zero-TAT records</div>
            <div style={{ color:rag(dq.compliance_incl_zero_pct), fontSize:26, fontWeight:800, fontVariantNumeric:'tabular-nums' }}>
              {dq.compliance_incl_zero_pct != null ? `${dq.compliance_incl_zero_pct}%` : 'N/A'}
            </div>
          </div>
          <div style={{ color:C.t4, fontSize:20 }}>→</div>
          <div>
            <div style={{ color:C.t3, fontSize:12.5 }}>Excluding zero-TAT records</div>
            <div style={{ color:rag(dq.compliance_excl_zero_pct), fontSize:26, fontWeight:800, fontVariantNumeric:'tabular-nums' }}>
              {dq.compliance_excl_zero_pct != null ? `${dq.compliance_excl_zero_pct}%` : 'N/A'}
            </div>
          </div>
          <div style={{ marginLeft:'auto' }}>
            <Segmented value={excludeZeroTat ? 'excl' : 'incl'}
                       onChange={v => setExcludeZeroTat(v === 'excl')}
                       options={[['incl','Include zero-TAT','Count zero-TAT records as passes (default)'],
                                 ['excl','Exclude zero-TAT','Remove them from both sides of the fraction']]}/>
          </div>
        </div>
      </div>

      <div style={T.panel}>
        <SectionTitle sub="Signals worth checking before quoting this week's figures externally.">
          Data quality signals
        </SectionTitle>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))', gap:14 }}>
          {tiles.map(t => (
            <div key={t.label} style={{ ...T.card }}>
              <div style={{ color:C.t3, fontSize:11.5, textTransform:'uppercase', letterSpacing:1.2, fontWeight:600 }}>{t.label}</div>
              <div style={{ color:toneCol(t.tone), fontSize:24, fontWeight:800, marginTop:5, fontVariantNumeric:'tabular-nums' }}>
                {t.v == null ? 'N/A' : fmtN(t.v)}
              </div>
              {t.note && <div style={{ color:C.t4, fontSize:11.5, marginTop:7, lineHeight:1.5 }}>{t.note}</div>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))', gap:18 }}>
        {[['Zero-TAT by site', dq.zero_tat_sites], ['Outlier tests', dq.extreme_outlier_tests],
          ['Slow transport routes', dq.transport_routes], ['Unmeasurable by site', dq.unmeasured_sites]].map(([label, list]) => (
          <div key={label} style={{ ...T.panel, marginBottom:0 }}>
            <SectionTitle>{label}</SectionTitle>
            {!list?.length ? <Empty msg="None recorded this week."/> : list.map(x => (
              <div key={x.name} style={{ display:'flex', justifyContent:'space-between', gap:12,
                                         padding:'7px 0', borderBottom:`1px solid ${C.border}`, fontSize:13 }}>
                <span style={{ color:C.t2, overflow:'hidden', textOverflow:'ellipsis' }}>{x.name}</span>
                <span style={{ color:C.warn, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{fmtN(x.count)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ ...T.panel, marginTop:18 }}>
        <SectionTitle>TAT distribution</SectionTitle>
        <div style={{ display:'flex', gap:26, flexWrap:'wrap' }}>
          {[['Median TAT', dq.median_tat_hrs], ['95th percentile', dq.p95_tat_hrs], ['Maximum', dq.max_tat_hrs]].map(([l, v]) => (
            <div key={l}>
              <div style={{ color:C.t3, fontSize:12.5 }}>{l}</div>
              <div style={{ color:C.t1, fontSize:22, fontWeight:800, fontVariantNumeric:'tabular-nums' }}>{fmtH(v)}</div>
            </div>
          ))}
        </div>
        <p style={{ color:C.t4, fontSize:12, marginTop:12, lineHeight:1.55 }}>
          These are computed over tests with a recorded Ver-Ent only. A previous version substituted
          zero for missing values, which pulled both the median and the percentile downward.
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// APP SHELL
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [activeTab, setActiveTab] = useState('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // ── Global filter state ────────────────────────────────────────────────
  const [selSites, setSelSites] = useState([]);     // [] means ALL, never NONE
  const [selDepts, setSelDepts] = useState([]);
  const [selTests, setSelTests] = useState([]);
  const [basis, setBasis] = useState('overall');    // was "View Mode" — renamed; it selects the TAT clock, not a view
  const [period, setPeriod] = useState('weekly');
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [selMonth, setSelMonth] = useState(null);
  const [excludeZeroTat, setExcludeZeroTat] = useState(false);

  const [allWeeks, setAllWeeks] = useState([]);
  const [history, setHistory] = useState({ daily:[], dailySite:[], dailySiteDept:[] });
  const [weekData, setWeekData] = useState({});
  const [periodFailures, setPeriodFailures] = useState(null);
  const [periodTests, setPeriodTests] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingFailures, setLoadingFailures] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [connStatus, setConnStatus] = useState('checking');
  const [fatalMsg, setFatalMsg] = useState(null);

  // ── Auth ───────────────────────────────────────────────────────────────
  // needsPassword is seeded from the URL the person arrived on (see AUTH_LINK),
  // because by the time React renders, supabase-js has already consumed and
  // removed the token from the address bar.
  const [needsPassword, setNeedsPassword] = useState(AUTH_LINK.action === 'set_password');
  const [linkError, setLinkError] = useState(AUTH_LINK.error);

  // Whether THIS account may upload. The real control is the database policy,
  // which only lets an account on the app_uploaders list write anything. This
  // flag exists so a viewer is not shown a button that would fail: it hides
  // the control, it does not grant the permission.
  const [canUpload, setCanUpload] = useState(false);
  useEffect(() => {
    if (!session) { setCanUpload(false); return; }
    supabase.from('app_uploaders').select('user_id').eq('user_id', session.user.id).maybeSingle()
      .then(({ data }) => setCanUpload(!!data));
  }, [session]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Fires when the person followed a recovery link. Belt and braces
      // alongside the URL check above — either one is enough on its own.
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      if (SUPABASE_URL.includes('YOUR_PROJECT')) { setConnStatus('config_error'); setLoading(false); return; }
      const { error } = await supabase.from('weekly_kpi').select('week_start').limit(1);
      if (!error) { setConnStatus('ok'); return; }
      setConnStatus('error');
      setFatalMsg(error.code === '42P01'
        ? 'The weekly_kpi table is missing. Run supabase_schema.sql and every migration up to supabase_migration19.sql.'
        : `Could not read from the database: ${error.message}`);
      setLoading(false);
    })();
  }, [session]);

  // ── Data loading ───────────────────────────────────────────────────────
  const loadCore = useCallback(async () => {
    const [weeks, daily, dailySite, dailySiteDept] = await Promise.all([
      supabase.from('weekly_kpi').select('week_start,week_label,week_end').order('week_start', { ascending:false }),
      fetchAllRows(() => supabase.from('weekly_daily').select('*').order('date')),
      fetchAllRows(() => supabase.from('weekly_daily_site').select('*').order('date').order('perf_site')),
      fetchAllRows(() => supabase.from('weekly_daily_site_dept').select('*').order('date').order('perf_site').order('department')),
    ]);
    if (weeks.error) { setFatalMsg(weeks.error.message); setLoading(false); return; }
    const w = weeks.data || [];
    setAllWeeks(w);
    setHistory({ daily:daily.data || [], dailySite:dailySite.data || [], dailySiteDept:dailySiteDept.data || [] });
    if (w.length && !selectedWeek) setSelectedWeek(w[0].week_start);
    if (!w.length) setLoading(false);
  }, [selectedWeek]);

  const loadWeek = useCallback(async ws => {
    if (!ws) return;
    setLoading(true);
    const [dq, routes, referral, hourly, hourlySite, hourlySiteDept, shift] = await Promise.all([
      supabase.from('weekly_dq').select('*').eq('week_start', ws).maybeSingle(),
      fetchAllRows(() => supabase.from('weekly_routes').select('*').eq('week_start', ws).order('origin').order('destination')),
      fetchAllRows(() => supabase.from('weekly_referral').select('*').eq('week_start', ws).order('site')),
      fetchAllRows(() => supabase.from('weekly_hourly').select('*').eq('week_start', ws).order('hour')),
      fetchAllRows(() => supabase.from('weekly_hourly_site').select('*').eq('week_start', ws).order('perf_site').order('hour')),
      fetchAllRows(() => supabase.from('weekly_hourly_site_dept').select('*').eq('week_start', ws).order('perf_site').order('department').order('hour')),
      fetchAllRows(() => supabase.from('weekly_shift_breakdown').select('*').eq('week_start', ws).order('perf_site').order('department').order('shift')),
    ]);
    setWeekData({
      dq: dq.data, routes: routes.data || [], referral: referral.data || [],
      hourly: hourly.data || [], hourlySite: hourlySite.data || [],
      hourlySiteDept: hourlySiteDept.data || [], shift: shift.data || [],
    });
    setLoading(false);
  }, []);

  // Failure detail is fetched for the ACTIVE PERIOD only. Across the full
  // history it is ~145,000 rows; pulling all of it into the browser to show
  // one week would be wasteful and slow. The date column (new in v7) makes a
  // server-side range filter possible.
  // Returns the server-side predicate for "the currently selected period",
  // shared by the failure register and the per-test grain so the two can never
  // describe different date ranges.
  const periodQuery = useCallback(table => {
    if (period === 'monthly' && selMonth) {
      const start = `${selMonth}-01`;
      const d = new Date(`${selMonth}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return () => supabase.from(table).select('*').gte('date', start).lt('date', d.toISOString().slice(0, 10));
    }
    if (selectedWeek) return () => supabase.from(table).select('*').eq('week_start', selectedWeek);
    return null;
  }, [period, selMonth, selectedWeek]);

  // Period-scoped fetches are cached for the session. Without this, every move
  // between tabs re-ran the same query over the network, so going Failures →
  // Overview → Failures cost two full round trips and the page sat empty each
  // time. The data for a given week or month cannot change while you are
  // looking at it, so fetching it twice buys nothing.
  const cacheRef = useRef(new Map());
  const periodKey = period === 'monthly' && selMonth ? `m:${selMonth}` : `w:${selectedWeek || ''}`;

  const loadFailures = useCallback(async () => {
    const key = `fail:${periodKey}`;
    if (cacheRef.current.has(key)) { setPeriodFailures(cacheRef.current.get(key)); return; }
    const q = periodQuery('weekly_failures_detail');
    if (!q) { setPeriodFailures([]); return; }
    setLoadingFailures(true);
    const { data, error } = await fetchAllRows(() => q().order('req_number'));
    const rows = error ? [] : (data || []);
    cacheRef.current.set(key, rows);
    setPeriodFailures(rows);
    setLoadingFailures(false);
  }, [periodQuery, periodKey]);

  const loadTests = useCallback(async () => {
    const key = `tests:${periodKey}`;
    if (cacheRef.current.has(key)) { setPeriodTests(cacheRef.current.get(key)); return; }
    const q = periodQuery('weekly_daily_test');
    if (!q) { setPeriodTests([]); return; }
    const { data, error } = await fetchAllRows(() => q().order('date').order('test_name'));
    const rows = error ? [] : (data || []);
    cacheRef.current.set(key, rows);
    setPeriodTests(rows);
  }, [periodQuery, periodKey]);

  useEffect(() => { if (connStatus === 'ok') loadCore(); }, [connStatus]);
  useEffect(() => { if (selectedWeek) loadWeek(selectedWeek); }, [selectedWeek, loadWeek]);
  // Both of these are period-scoped and only fetched for the tabs that need
  // them. The failure register alone is ~145,000 rows across the full history;
  // pulling all of it to show one week would be slow for no benefit.
  useEffect(() => { if (connStatus === 'ok' && activeTab === 'failures') loadFailures(); },
            [connStatus, activeTab, loadFailures]);
  useEffect(() => { if (connStatus === 'ok' && activeTab === 'performance') loadTests(); },
            [connStatus, activeTab, loadTests]);

  // ── Derived: period rows, filters, aggregates ──────────────────────────
  const months = useMemo(() => availableMonths(history.daily), [history.daily]);
  const activeMonth = selMonth || months[0] || null;
  useEffect(() => { if (!selMonth && months.length) setSelMonth(months[0]); }, [months, selMonth]);

  const siteNames = useMemo(() =>
    [...new Set(history.dailySiteDept.map(r => r.perf_site))].filter(Boolean).sort(), [history.dailySiteDept]);
  const deptNames = useMemo(() =>
    [...new Set(history.dailySiteDept.map(r => r.department))].filter(Boolean).sort(), [history.dailySiteDept]);
  const testNames = useMemo(() =>
    [...new Set((periodFailures || []).map(r => r.test_name))].filter(Boolean).sort(), [periodFailures]);

  const rowFilter = useMemo(() => makeRowFilter({ sites:selSites, depts:selDepts }), [selSites, selDepts]);

  // The de-duplication of overlapping upload windows happens inside
  // rowsInMonth, so no screen can accidentally skip it.
  const periodRows = useMemo(() => {
    if (period === 'monthly' && activeMonth) return rowsInMonth(history.dailySiteDept, activeMonth).filter(rowFilter);
    if (selectedWeek) return rowsInWeek(history.dailySiteDept, selectedWeek).filter(rowFilter);
    return [];
  }, [period, activeMonth, selectedWeek, history.dailySiteDept, rowFilter]);

  const prevPeriodRows = useMemo(() => {
    if (period === 'monthly') {
      const sorted = [...months].sort();
      const i = sorted.indexOf(activeMonth);
      if (i <= 0) return null;
      return rowsInMonth(history.dailySiteDept, sorted[i - 1]).filter(rowFilter);
    }
    const sorted = [...allWeeks].map(w => w.week_start).sort();
    const i = sorted.indexOf(selectedWeek);
    if (i <= 0) return null;
    return rowsInWeek(history.dailySiteDept, sorted[i - 1]).filter(rowFilter);
  }, [period, months, activeMonth, allWeeks, selectedWeek, history.dailySiteDept, rowFilter]);

  const byCell = rows => {
    const out = {};
    (rows || []).forEach(r => { (out[`${r.perf_site}||${r.department}`] ||= []).push(r); });
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, aggregate(v, { excludeZeroTat })]));
  };

  const cur = useMemo(() => {
    const a = aggregate(periodRows, { excludeZeroTat });
    return a ? { ...a, byCell: byCell(periodRows) } : null;
  }, [periodRows, excludeZeroTat]);

  const prev = useMemo(() => {
    const a = aggregate(prevPeriodRows, { excludeZeroTat });
    return a ? { ...a, byCell: byCell(prevPeriodRows) } : null;
  }, [prevPeriodRows, excludeZeroTat]);

  const patients = useMemo(() => {
    // Patient de-dup needs the network daily grain (it carries patient_ids);
    // the site×dept grain carries them too but a patient appears under several
    // cells, so the union must be taken over whichever grain is being shown.
    const src = period === 'monthly' && activeMonth
      ? rowsInMonth(history.daily, activeMonth)
      : rowsInWeek(history.daily, selectedWeek);
    if (selSites.length || selDepts.length) return uniquePatientAgg(periodRows);
    return uniquePatientAgg(src);
  }, [period, activeMonth, selectedWeek, history.daily, periodRows, selSites, selDepts]);

  const siteRows = useMemo(() => {
    const by = {};
    periodRows.forEach(r => { (by[r.perf_site] ||= []).push(r); });
    return Object.entries(by).map(([site, rows]) => ({ site, ...aggregate(rows, { excludeZeroTat }) }));
  }, [periodRows, excludeZeroTat]);

  const deptRows = useMemo(() => {
    const by = {};
    periodRows.forEach(r => { (by[r.department] ||= []).push(r); });
    return Object.entries(by).map(([department, rows]) => ({ department, ...aggregate(rows, { excludeZeroTat }) }));
  }, [periodRows, excludeZeroTat]);

  const filteredFailures = useMemo(() => (periodFailures || []).filter(r =>
    (!selSites.length || selSites.includes(r.perf_site)) &&
    (!selDepts.length || selDepts.includes(r.department)) &&
    (!selTests.length || selTests.includes(r.test_name))), [periodFailures, selSites, selDepts, selTests]);

  // The per-test grain is stored per (week, date, test, site, department), so
  // a month's rows must be de-duplicated across overlapping upload windows the
  // same way every other grain is.
  const filteredTests = useMemo(() => {
    const src = period === 'monthly' && activeMonth
      ? rowsInMonth(periodTests || [], activeMonth)
      : (periodTests || []);
    return src.filter(r =>
      (!selSites.length || selSites.includes(r.perf_site)) &&
      (!selDepts.length || selDepts.includes(r.department)) &&
      (!selTests.length || selTests.includes(r.test_name)));
  }, [periodTests, period, activeMonth, selSites, selDepts, selTests]);

  const hourlyRows = useMemo(() => {
    if (selSites.length || selDepts.length) {
      return (weekData.hourlySiteDept || []).filter(r =>
        (!selSites.length || selSites.includes(r.perf_site)) &&
        (!selDepts.length || selDepts.includes(r.department)));
    }
    return weekData.hourly || [];
  }, [weekData, selSites, selDepts]);

  // Trends reads the whole history, so these filters run over every row the
  // dashboard holds. They were being recomputed inline in the render, which
  // meant re-filtering thousands of rows on every keystroke and every hover.
  const trendDayRows = useMemo(() => history.dailySiteDept.filter(rowFilter),
                               [history.dailySiteDept, rowFilter]);
  const trendSiteRows = useMemo(() => history.dailySite.filter(r => !selSites.length || selSites.includes(r.perf_site)),
                                [history.dailySite, selSites]);

  const shiftRows = useMemo(() => (weekData.shift || []).filter(r =>
    (!selSites.length || selSites.includes(r.perf_site)) &&
    (!selDepts.length || selDepts.includes(r.department))), [weekData.shift, selSites, selDepts]);

  const periodLabel = period === 'monthly'
    ? fmtMonthLbl(activeMonth)
    : (allWeeks.find(w => w.week_start === selectedWeek)?.week_label || fmtWeek(selectedWeek));
  const prevLabel = period === 'monthly' ? 'previous month' : 'previous week';

  // Weeks uploaded before migration 19 have no count columns, so aggregate()
  // returns zeros. Say so plainly instead of rendering a confident 0%.
  const staleData = cur && cur.total_tests > 0 && cur.measured_tests === 0;

  const anyFilter = selSites.length > 0 || selDepts.length > 0 || selTests.length > 0;
  const clearFilters = () => startTransition(() => { setSelSites([]); setSelDepts([]); setSelTests([]); });

  // Filter changes are marked as transitions. Recomputing a month across every
  // site and department is real work, and doing it as an urgent update froze
  // the whole page until it finished, so a click felt like it had not
  // registered. As a transition, React paints the checkbox immediately, keeps
  // the previous numbers on screen while it recalculates, and swaps them in
  // when ready. The "Updating" pill below tells the user which state they are
  // looking at, so the old figures are never mistaken for the new ones.
  const pickSites = v => startTransition(() => setSelSites(v));
  const pickDepts = v => startTransition(() => setSelDepts(v));
  const pickTests = v => startTransition(() => setSelTests(v));
  const pickBasis = v => startTransition(() => setBasis(v));
  const drill = patch => {
    if (patch.sites) setSelSites(patch.sites);
    if (patch.depts) setSelDepts(patch.depts);
    setActiveTab(patch.tab || activeTab);
  };

  // ── Export ─────────────────────────────────────────────────────────────
  const handleExport = async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const fmt = (v, d = 1) => v == null ? '' : typeof v === 'number' ? parseFloat(v.toFixed(d)) : v;
    const filterCtx = [
      selSites.length ? selSites.join('; ') : 'All sites',
      selDepts.length ? selDepts.join('; ') : 'All departments',
      selTests.length ? selTests.join('; ') : 'All tests',
      basis === 'overall' ? 'Overall (Ver-Ent)' : basis === 'local' ? 'Local only (Ver-Ent)' : 'Shipped only (Ver-Rec)',
      excludeZeroTat ? 'Zero-TAT excluded' : 'Zero-TAT included',
    ].join(' | ');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Demo Lab TAT Analytics Export (synthetic data)'],
      ['Period', periodLabel],
      ['View', period === 'monthly' ? 'Monthly' : 'Weekly'],
      ['Filters', filterCtx],
      ['Generated', new Date().toLocaleString()],
      [],
      ['Metric', 'Value'],
      ['Total tests',              fmt(cur?.total_tests, 0)],
      ['Measurable tests',         fmt(cur?.effective_measured, 0)],
      ['Unmeasurable tests',       fmt(cur?.unmeasured_tests, 0)],
      ['Passed',                   fmt(cur?.effective_passed, 0)],
      ['Failed',                   fmt(cur?.failed, 0)],
      ['TAT compliance %',         fmt(cur?.compliance_pct)],
      ['Local compliance %',       fmt(cur?.local_compliance_pct)],
      ['Shipped compliance %',     fmt(cur?.shipped_compliance_pct)],
      ['Shipped measured (denominator)', fmt(cur?.shipped_measured, 0)],
      ['Average TAT (hrs)',        fmt(cur?.avg_tat_hrs, 2)],
      ['Average transport (hrs)',  fmt(cur?.avg_transport_hrs, 2)],
      ['Unique patients',          fmt(patients?.count, 0)],
      [],
      ['Failures marginal (under 30 min over)',      fmt(cur?.fail_marginal, 0)],
      ['Failures moderate (31 min to 3 hours over)',      fmt(cur?.fail_moderate, 0)],
      ['Failures severe (3 to 12 hours over)',        fmt(cur?.fail_severe, 0)],
      ['Failures critical (over 12 hours over)',      fmt(cur?.fail_critical, 0)],
    ]), 'KPI Summary');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Site','Tests','Measurable','Passed','Failed','Compliance %','Fail rate %','Avg TAT (hrs)',
       'Local compliance %','Shipped compliance %','Shipped measured','Marginal','Moderate','Severe','Critical'],
      ...siteRows.map(r => [r.site, r.total_tests, r.effective_measured, r.effective_passed, r.failed,
        fmt(r.compliance_pct), fmt(r.failure_rate_pct), fmt(r.avg_tat_hrs, 2),
        fmt(r.local_compliance_pct), fmt(r.shipped_compliance_pct), r.shipped_measured,
        r.fail_marginal, r.fail_moderate, r.fail_severe, r.fail_critical]),
    ]), 'Site Performance');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Department','Tests','Measurable','Passed','Failed','Compliance %','Fail rate %','Avg TAT (hrs)',
       'Local compliance %','Shipped compliance %','Marginal','Moderate','Severe','Critical'],
      ...deptRows.map(r => [r.department, r.total_tests, r.effective_measured, r.effective_passed, r.failed,
        fmt(r.compliance_pct), fmt(r.failure_rate_pct), fmt(r.avg_tat_hrs, 2),
        fmt(r.local_compliance_pct), fmt(r.shipped_compliance_pct),
        r.fail_marginal, r.fail_moderate, r.fail_severe, r.fail_critical]),
    ]), 'Department Performance');

    // Day × site × department — the finest grain the dashboard holds. This is
    // the sheet to pivot offline; it reconciles exactly with every figure on
    // screen, which a copy of the source workbook would not, since the raw
    // file bypasses every cleaning rule the ETL applies.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Date','Day','Site','Department','Tests','Measurable','Passed','Failed','Compliance %',
       'Avg TAT (hrs)','Local tests','Local passed','Shipped received','Shipped measured','Shipped passed',
       'Avg transport (hrs)','Zero-TAT','Marginal','Moderate','Severe','Critical'],
      ...[...periodRows].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(r => [
        r.date, r.day_name, r.perf_site, r.department, r.total_tests, r.measured_tests, r.passed, r.failed,
        fmt(r.compliance_pct), fmt(r.avg_tat_hrs, 2), r.local_tests, r.local_passed,
        r.shipped_rec_count, r.shipped_measured, r.shipped_passed, fmt(r.avg_transport_hrs, 2),
        r.zero_tat_tests, r.fail_marginal, r.fail_moderate, r.fail_severe, r.fail_critical]),
    ]), 'Daily Detail');

    // Complete failure register — every failure, no threshold. Fetched only
    // when the Failures tab has been opened, so say so rather than silently
    // exporting an empty sheet.
    const failSheet = periodFailures == null
      ? [['Open the Failures tab once before exporting to include the failure register.']]
      : [
          ['Date','Day','Req Number','Test','Department','Perf. Site','Origin','Type',
           'Target (hrs)','Ver-Ent (hrs)','Ver-Rec (hrs)','Overrun Ver-Ent (hrs)','Overrun Ver-Rec (hrs)',
           '% over target','Severity'],
          ...filteredFailures.map(r => [
            r.date, r.day_name, r.req_number, r.test_name, r.department, r.perf_site, r.originating_site,
            r.is_local ? 'Local' : 'Shipped', fmt(r.target_hrs, 2), fmt(r.ver_ent_hrs, 2), fmt(r.ver_rec_hrs, 2),
            fmt(r.overrun_ent_hrs, 2), fmt(r.overrun_rec_hrs, 2),
            fmt(basis === 'shipped' ? r.overrun_rec_pct : r.overrun_ent_pct),
            basis === 'shipped' ? r.band_rec : r.band_ent]),
        ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(failSheet), 'TAT Failures');

    const safe = periodLabel.replace(/[^a-z0-9]+/gi, '_');
    XLSX.writeFile(wb, `DemoLab_TAT_${safe}_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // Large-volume CSV path. Excel's in-browser writer struggles well before
  // this row count, and nobody pivots 140,000 rows in Excel's UI anyway.
  const handleExportCsv = () => {
    const rows = [...periodRows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const cols = ['date','day_name','perf_site','department','total_tests','measured_tests','unmeasured_tests',
      'passed','failed','zero_tat_tests','compliance_pct','avg_tat_hrs','local_tests','local_measured','local_passed',
      'shipped_tests','shipped_rec_count','shipped_measured','shipped_passed','avg_transport_hrs',
      'fail_marginal','fail_moderate','fail_severe','fail_critical'];
    const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
    const csv = [
      `# Demo Lab TAT export (synthetic data), ${periodLabel}`,
      `# Filters: ${selSites.length ? selSites.join(';') : 'All sites'} | ${selDepts.length ? selDepts.join(';') : 'All departments'}`,
      `# Generated: ${new Date().toISOString()}`,
      cols.join(','),
      ...rows.map(r => cols.map(c => esc(r[c])).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `DemoLab_TAT_source_${periodLabel.replace(/[^a-z0-9]+/gi,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Render ─────────────────────────────────────────────────────────────
  if (!authChecked) return <div style={{ minHeight:'100vh', background:C.bg }}><Loader msg="Checking access…"/></div>;
  // An expired or already-used invitation link. Say so plainly and point at the
  // way out, rather than dropping the person on a sign-in box for an account
  // they have no password for.
  if (linkError && !session) {
    return (
      <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center',
                    justifyContent:'center', padding:'40px 24px', fontFamily:"system-ui,sans-serif" }}>
        <div style={{ maxWidth:430, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, padding:30 }}>
          <img src={LOGO_B64} alt="Demo Lab" style={{ height:32, marginBottom:20 }}/>
          <h2 style={{ color:C.t1, fontSize:19, fontWeight:700, margin:'0 0 10px' }}>That link has expired</h2>
          <p style={{ color:C.t2, fontSize:13.5, lineHeight:1.65, marginBottom:8 }}>{linkError}</p>
          <p style={{ color:C.t3, fontSize:13, lineHeight:1.65, marginBottom:20 }}>
            Invitation and reset links are single-use and time-limited. Enter your email on the next
            screen and choose “Forgot password” to get a fresh one.
          </p>
          <button onClick={() => { setLinkError(null); window.location.hash = ''; }}
                  style={{ width:'100%', background:`linear-gradient(135deg,${C.accent},${C.accent2})`,
                           color:'#08121C', border:'none', borderRadius:8, padding:'11px',
                           fontWeight:800, fontSize:14, cursor:'pointer', fontFamily:'inherit' }}>
            Continue to sign in →
          </button>
        </div>
      </div>
    );
  }
  if (session && needsPassword) {
    return <SetPasswordScreen email={session.user?.email}
                              onDone={() => { setNeedsPassword(false); window.location.hash = ''; }}/>;
  }
  if (!session) return <LoginScreen onAuth={() => {}}/>;

  const TABS = [
    { id:'overview',    label:'Overview',     icon:'overview' },
    { id:'performance', label:'Performance',  icon:'calendar' },
    { id:'failures',    label:'Failures',     icon:'flame' },
    { id:'trends',      label:'Trends',       icon:'trending' },
    { id:'logistics',   label:'Logistics',    icon:'truck' },
    { id:'quality',     label:'Data Quality', icon:'alertTri' },
  ];
  const scopedTab = activeTab === 'logistics' || activeTab === 'quality';

  const filterTokens = [
    { key:'period', label:`${period === 'monthly' ? 'Month' : 'Week'}: ${periodLabel}`, tone:'accent', removable:'never' },
    { key:'basis', label:`Basis: ${basis === 'overall' ? 'Overall (Ver-Ent)' : basis === 'local' ? 'Local only (Ver-Ent)' : 'Shipped only (Ver-Rec)'}`,
      tone:'accent', removable: basis === 'overall' ? 'never' : undefined,
      onRemove: basis !== 'overall' ? () => setBasis('overall') : undefined },
    selSites.length ? { key:'sites', label:`${selSites.length === 1 ? selSites[0] : `${selSites.length} sites`}`,
      title:selSites.join(', '), onRemove:() => setSelSites([]) } : null,
    selDepts.length ? { key:'depts', label:`${selDepts.length === 1 ? selDepts[0] : `${selDepts.length} departments`}`,
      title:selDepts.join(', '), onRemove:() => setSelDepts([]) } : null,
    selTests.length ? { key:'tests', label:`${selTests.length === 1 ? selTests[0] : `${selTests.length} tests`}`,
      title:selTests.join(', '), onRemove:() => setSelTests([]) } : null,
    excludeZeroTat ? { key:'zt', label:'Zero-TAT excluded', onRemove:() => setExcludeZeroTat(false) } : null,
  ].filter(Boolean);

  return (
    <>
      <style>{`
@keyframes spin{to{transform:rotate(360deg)}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:${C.bg};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px}
button:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid ${C.accent};outline-offset:2px}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:${C.rail}}
::-webkit-scrollbar-thumb{background:#2D3F52;border-radius:6px}
::selection{background:rgba(56,189,248,0.28)}
.lt-shell{height:100vh;height:100dvh}
.lt-hamburger{display:none}
.lt-backdrop{display:none}
@media (max-width:900px){
  .lt-hamburger{display:flex !important}
  .lt-header{flex-wrap:wrap;row-gap:8px;padding:8px 12px !important}
  .lt-btn-label{display:none}
  .lt-sidebar{position:fixed !important;top:0;left:0;bottom:0;z-index:300;width:280px !important;max-width:86vw;
    transform:translateX(-100%) !important;transition:transform .25s ease;box-shadow:16px 0 40px rgba(0,0,0,.6)}
  .lt-sidebar-open{transform:translateX(0) !important}
  .lt-backdrop.on{display:block;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:290}
}
@media (max-width:520px){
  .lt-main{padding-left:12px !important;padding-right:12px !important}
  .lt-tabs button{padding:9px 11px !important;font-size:12px !important}
}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
      `}</style>

      {showPassword && session && (
        <ChangePasswordModal email={session.user.email} onClose={() => setShowPassword(false)}/>
      )}

      {showUpload && <UploadModal onClose={() => setShowUpload(false)}
                                  onSuccess={ws => { setShowUpload(false); loadCore(); setSelectedWeek(ws); loadFailures(); }}/>}

      <div className="lt-shell" style={{ display:'flex', flexDirection:'column', background:C.bg, color:C.t1 }}>
        {/* Header */}
        <div className="lt-header" style={{ background:'#0A0F1A', borderBottom:`1px solid ${C.border}`,
                      padding:'9px 20px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
          <button className="lt-hamburger" onClick={() => setMobileNavOpen(o => !o)} aria-label="Toggle filters"
                  style={{ background:C.panelAlt, border:`1px solid ${C.border}`, color:C.t3, borderRadius:7,
                           width:34, height:34, alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
            <Icon name="filter" size={15}/>
          </button>
          <img src={LOGO_B64} alt="Demo Lab" style={{ height:32, flexShrink:0 }}/>
          <div style={{ flex:1, minWidth:0 }}>
            <h1 style={{ color:C.t1, fontSize:13.5, fontWeight:800, margin:0, letterSpacing:0.3, whiteSpace:'nowrap',
                         overflow:'hidden', textOverflow:'ellipsis' }}>TAT Analytics</h1>
            <p style={{ color:C.t4, fontSize:11, margin:0, letterSpacing:1.2, textTransform:'uppercase' }}>
              Demo · synthetic data
            </p>
          </div>
          <button onClick={handleExport} title="Export the current view to Excel"
                  style={{ background:`${C.good}1F`, border:`1px solid ${C.good}66`, color:C.good, borderRadius:7,
                           padding:'7px 12px', fontWeight:700, fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
            <Icon name="download" size={13}/><span className="lt-btn-label"> Excel</span>
          </button>
          <button onClick={handleExportCsv} title="Download the underlying day-level data as CSV"
                  style={{ background:'none', border:`1px solid ${C.border}`, color:C.t2, borderRadius:7,
                           padding:'7px 12px', fontWeight:600, fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
            <span className="lt-btn-label">Source </span>CSV
          </button>
          {canUpload && (
            <button onClick={() => setShowUpload(true)}
                    title="Upload a weekly workbook"
                    style={{ background:`linear-gradient(135deg,${C.accent},${C.accent2})`, color:'#08121C', border:'none',
                             borderRadius:7, padding:'7px 13px', fontWeight:800, fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
              ＋<span className="lt-btn-label"> Upload</span>
            </button>
          )}
          <button hidden onClick={() => setShowPassword(true)} title="Change your password"
                  style={{ background:'none', border:`1px solid ${C.border}`, color:C.t2, borderRadius:7,
                           padding:'7px 11px', fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
            <Icon name="lock" size={12}/><span className="lt-btn-label"> Password</span>
          </button>
          <button hidden onClick={() => supabase.auth.signOut()} title="Sign out"
                  style={{ background:'none', border:`1px solid ${C.border}`, color:C.t3, borderRadius:7,
                           padding:'7px 11px', fontSize:12.5, cursor:'pointer', fontFamily:'inherit' }}>
            Sign out
          </button>
        </div>

        <div className={`lt-backdrop${mobileNavOpen ? ' on' : ''}`} onClick={() => setMobileNavOpen(false)}/>

        <div style={{ display:'flex', flex:1, overflow:'hidden', minHeight:0 }}>
          {/* Sidebar */}
          <aside className={`lt-sidebar${mobileNavOpen ? ' lt-sidebar-open' : ''}`}
                 style={{ flexShrink:0, width:250, background:C.rail, borderRight:`1px solid ${C.border}`,
                          display:'flex', flexDirection:'column', overflowY:'auto', padding:'16px 15px', gap:16 }}>

            <div>
              <p style={{ color:C.t3, fontSize:11.5, fontWeight:700, textTransform:'uppercase', letterSpacing:1.6, marginBottom:8 }}>
                Time period
              </p>
              <Segmented value={period} onChange={setPeriod}
                         options={[['weekly','Weekly'],['monthly','Monthly']]}/>
              <div style={{ marginTop:9 }}>
                {period === 'weekly' ? (
                  <select value={selectedWeek || ''} onChange={e => setSelectedWeek(e.target.value)}
                          style={{ ...T.input, width:'100%', cursor:'pointer' }}>
                    {allWeeks.map(w => <option key={w.week_start} value={w.week_start}>{w.week_label}</option>)}
                  </select>
                ) : (
                  <select value={activeMonth || ''} onChange={e => setSelMonth(e.target.value)}
                          style={{ ...T.input, width:'100%', cursor:'pointer' }}>
                    {months.map(m => <option key={m} value={m}>{fmtMonthLbl(m)}</option>)}
                  </select>
                )}
              </div>
            </div>

            <div style={{ height:1, background:C.border }}/>

            <div>
              <p style={{ color:C.t3, fontSize:11.5, fontWeight:700, textTransform:'uppercase', letterSpacing:1.6, marginBottom:8 }}>
                Filters
              </p>
              {scopedTab ? (
                <Note>Site and department filters do not apply to this section.</Note>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:11 }}>
                  <MultiSelect label="Site" icon="pin" options={siteNames} selected={selSites}
                               onChange={pickSites} allLabel="All sites"/>
                  <MultiSelect label="Department" icon="vial" options={deptNames} selected={selDepts}
                               onChange={pickDepts} allLabel="All departments"/>
                  {activeTab === 'failures' && testNames.length > 0 && (
                    <MultiSelect label="Test" icon="search" options={testNames} selected={selTests}
                                 onChange={pickTests} allLabel="All tests" searchAfter={6}/>
                  )}
                  {/* Clearing used to mean scrolling to the top of the page and
                      finding the bar there, or opening each dropdown in turn.
                      The reset belongs beside the controls it resets. */}
                  {anyFilter && (
                    <button onClick={clearFilters}
                            style={{ ...T.input, cursor:'pointer', color:C.bad, borderColor:`${C.bad}55`,
                                     fontWeight:600, textAlign:'center' }}>
                      Clear all filters
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{ height:1, background:C.border }}/>

            {/* Analysis basis — visible on EVERY tab it affects. In v2 this
                control rendered on two tabs but silently applied to a third. */}
            <div>
              <p style={{ color:C.t3, fontSize:11.5, fontWeight:700, textTransform:'uppercase', letterSpacing:1.6, marginBottom:4 }}>
                Analysis basis
              </p>
              <p style={{ color:C.t4, fontSize:11.5, marginBottom:9, lineHeight:1.5 }}>
                Which tests are counted, and which clock they are timed on.
              </p>
              {[['overall','Overall TAT','Every test, timed from booking in'],
                ['local','Local TAT','Tests the site booked in and ran itself'],
                ['shipped','Shipped TAT','Samples sent in, timed from arrival']].map(([v, l, hint]) => (
                <button key={v} onClick={() => pickBasis(v)}
                        style={{ background: basis === v ? `${C.accent}1F` : 'transparent',
                                 border:`1px solid ${basis === v ? C.accent : C.border}`,
                                 color: basis === v ? C.accent : C.t3, borderRadius:7, padding:'8px 11px',
                                 cursor:'pointer', textAlign:'left', width:'100%', marginBottom:6, fontFamily:'inherit' }}>
                  <div style={{ fontWeight:700, fontSize:12.5 }}>{l}</div>
                  <div style={{ fontSize:11.5, color: basis === v ? `${C.accent}CC` : C.t4, marginTop:1 }}>{hint}</div>
                </button>
              ))}
            </div>

            <div style={{ flex:1 }}/>
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12 }}>
              <p style={{ color:C.t4, fontSize:11.5, margin:0, lineHeight:1.6 }}>
                {allWeeks.length} week{allWeeks.length === 1 ? '' : 's'} stored<br/>
                {session?.user?.email}
              </p>
            </div>
          </aside>

          {/* Content */}
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
            <div className="lt-tabs" style={{ background:'#0A0F1A', borderBottom:`1px solid ${C.border}`,
                          padding:'0 20px', display:'flex', gap:2, overflowX:'auto', flexShrink:0 }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => { setActiveTab(t.id); setMobileNavOpen(false); }}
                        style={{ background:'none', border:'none', cursor:'pointer', padding:'11px 15px',
                                 color: activeTab === t.id ? C.accent : C.t3, fontSize:13,
                                 fontWeight: activeTab === t.id ? 700 : 500, whiteSpace:'nowrap',
                                 borderBottom:`2px solid ${activeTab === t.id ? C.accent : 'transparent'}`,
                                 fontFamily:'inherit', display:'flex', alignItems:'center', gap:7 }}>
                  <Icon name={t.icon} size={14}/> {t.label}
                </button>
              ))}
            </div>

            <div className="lt-main" style={{ flex:1, padding:'18px 20px 40px', overflowY:'auto' }}>
              {fatalMsg ? (
                <div style={{ ...T.panel, borderColor:`${C.bad}66`, maxWidth:640, margin:'40px auto' }}>
                  <SectionTitle>Cannot load data</SectionTitle>
                  <p style={{ color:C.t2, fontSize:13.5, lineHeight:1.65 }}>{fatalMsg}</p>
                </div>
              ) : loading && !cur ? (
                <Loader msg="Loading dashboard…"/>
              ) : allWeeks.length === 0 ? (
                <Empty msg="No data yet. Upload your first weekly Excel file to begin."/>
              ) : (
                <>
                  <FilterBar tokens={filterTokens} onClearAll={clearFilters} busy={isPending}/>

                  {staleData && (
                    <Note tone="warn">
                      This period was uploaded before the current data model and is missing the count
                      columns every figure is derived from. Re-upload <b>{periodLabel}</b> from the
                      Upload button to populate it. Figures show as "N/A" rather than as zeros,
                      because a confident 0% here would be wrong, not merely incomplete.
                    </Note>
                  )}

                  {activeTab === 'overview' && (
                    <PageOverview cur={cur} prev={prev} prevLabel={prevLabel} periodLabel={periodLabel}
                                  siteRows={siteRows} deptRows={deptRows} patients={patients}
                                  excludeZeroTat={excludeZeroTat} onDrill={drill}
                                  basis={basis} setBasis={setBasis}/>
                  )}
                  {activeTab === 'performance' && (
                    <PagePerformance dayRows={periodRows} testRows={filteredTests} hourlyRows={hourlyRows} shiftRows={shiftRows}
                                     basis={basis} periodLabel={periodLabel} excludeZeroTat={excludeZeroTat}/>
                  )}
                  {activeTab === 'failures' && (
                    loadingFailures && periodFailures == null
                      ? <Loader msg="Loading failure register…"/>
                      : <PageFailures failures={filteredFailures} grainRows={periodRows} shiftRows={shiftRows}
                                      basis={basis} periodLabel={periodLabel} excludeZeroTat={excludeZeroTat}
                                      onDrill={drill}/>
                  )}
                  {activeTab === 'trends' && (
                    <PageTrends dayRows={trendDayRows} siteDayRows={trendSiteRows} allWeeks={allWeeks}
                                excludeZeroTat={excludeZeroTat} basis={basis}/>
                  )}
                  {activeTab === 'logistics' && (
                    <PageLogistics routes={weekData.routes} referral={weekData.referral}/>
                  )}
                  {activeTab === 'quality' && (
                    <PageQuality dq={weekData.dq} agg={cur} excludeZeroTat={excludeZeroTat}
                                 setExcludeZeroTat={setExcludeZeroTat}/>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
