/**
 * uploadChecks.js — decisions the upload screen makes before saving anything.
 *
 * Kept separate from the screen so they can be tested on their own. Both exist
 * because of the October 2026 incident, when a damaged copy of the 7–13 Sept
 * workbook was saved as a phantom week labelled "16 May 2000 – 15 Aug 2102":
 *
 *   assessDates     would have refused that file (5.5% of its dates were
 *                   impossible), and said why in words.
 *   classifyExisting would have recognised it as a second copy of a week
 *                   already on the dashboard and asked before saving it.
 */
import { MAX_BAD_DATE_SHARE_PCT } from './processExcel.js';

const fmtN = n => Number(n).toLocaleString();

/**
 * How healthy is the file's date column?
 * Returns { level: 'ok' | 'warn' | 'block', title, detail }.
 */
export function assessDates(dateCheck) {
  if (!dateCheck) return { level: 'ok', title: 'Dates look correct', detail: '' };
  const { invalid, rowsInFile, share, samples = [] } = dateCheck;
  if (!invalid) {
    return { level: 'ok', title: 'All dates look correct',
             detail: `Every one of the ${fmtN(rowsInFile)} rows has an entry date that fits this week.` };
  }
  const examples = samples.slice(0, 3)
    .map(s => `row ${s.excelRow} (reads as ${s.readAs})`).join(', ');
  if (share > MAX_BAD_DATE_SHARE_PCT) {
    return {
      level: 'block',
      title: 'This file cannot be uploaded',
      detail: `${fmtN(invalid)} rows (${share}%) have entry dates that cannot belong to this week, for example ${examples}. `
            + 'This usually means the file was opened and saved again in a way that changed the date column. '
            + 'Please export the file again from the LIS and upload the fresh copy.',
    };
  }
  return {
    level: 'warn',
    title: `${fmtN(invalid)} row${invalid === 1 ? '' : 's'} will be left out`,
    detail: `${invalid === 1 ? 'This row has an entry date' : 'These rows have entry dates'} that cannot belong to this week, `
          + `for example ${examples}. That is ${share}% of the file, so the upload can go ahead, `
          + 'but you may want to check those rows in the LIS.',
  };
}

const DAY_MS = 86400000;
const toMs = d => Date.parse(`${d}T00:00:00Z`);

/**
 * Compare the new upload against weeks already on the dashboard.
 *
 * Consecutive weekly extracts legitimately share a day or two at their edges,
 * so a small overlap is normal and ignored. An overlap of four days or more
 * (more than half a week) means the same week's data is already there.
 *
 * Returns { same, duplicates }:
 *   same        the existing week with the identical start date, if any. Its
 *               rows will be replaced.
 *   duplicates  other weeks covering mostly the same days. The person must
 *               choose to replace them, or the week would be counted twice.
 */
export function classifyExisting(newWeek, existing = []) {
  const ns = toMs(newWeek.week_start), ne = toMs(newWeek.week_end || newWeek.week_start);
  let same = null;
  const duplicates = [];
  for (const w of existing) {
    if (!w || !w.week_start) continue;
    if (w.week_start === newWeek.week_start) { same = w; continue; }
    const ws = toMs(w.week_start), we = toMs(w.week_end || w.week_start);
    const overlapDays = Math.floor((Math.min(ne, we) - Math.max(ns, ws)) / DAY_MS) + 1;
    // A stored week whose own dates are impossible (the 2000–2102 kind) is
    // always worth surfacing if it touches this upload at all.
    const implausible = we - ws > 60 * DAY_MS;
    if (overlapDays >= 4 || (implausible && overlapDays > 0)) duplicates.push({ ...w, overlapDays });
  }
  return { same, duplicates };
}
