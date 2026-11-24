// Pure availability engine: no Firebase, no DOM. Times are integer minutes.
export const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
export const parseT = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : NaN; };
export const dur = m => (m >= 60 ? Math.floor(m / 60) + 'h' : '') + (m % 60 ? (m >= 60 ? ' ' : '') + (m % 60) + 'm' : '');

export function normalize(list, min = 0, max = 1440, step = 1) {
  const errors = [], clean = [];
  for (const i of list || []) {
    const s = i?.s, e = i?.e;
    if (!Number.isInteger(s) || !Number.isInteger(e)) { errors.push('Enter a valid time'); continue; }
    if (e <= s) { errors.push('End must be after start'); continue; }
    if (s < min || e > max) { errors.push(`Stay within ${fmt(min)}–${fmt(max)}`); continue; }
    if ((s - min) % step || (e - min) % step) { errors.push(`Use ${step}-minute steps`); continue; }
    clean.push({ s, e });
  }
  clean.sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  for (const c of clean) {
    const l = out[out.length - 1];
    if (l && c.s < l.e) { errors.push('Intervals overlap'); l.e = Math.max(l.e, c.e); }
    else if (l && c.s === l.e) l.e = c.e;           // touching = continuous
    else out.push({ ...c });
  }
  return { intervals: out, errors: [...new Set(errors)] };
}
export const fromDb = a => { const o = {}; for (const [d, v] of Object.entries(a || {})) o[d] = normalize(Object.values(v || {}).map(x => ({ s: x?.start, e: x?.end }))).intervals; return o; };
export const toDb = av => { const o = {}; for (const [d, l] of Object.entries(av)) if (l.length) { o[d] = {}; l.forEach((x, i) => o[d]['i' + i] = { start: x.s, end: x.e }); } return o; };
export function datesBetween(a, b, max = 62) {
  const out = []; let d = new Date(a + 'T00:00:00Z'); const e = new Date(b + 'T00:00:00Z');
  if (isNaN(d) || isNaN(e)) return out;
  while (d <= e && out.length < max) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
  return out;
}
const covers = (l, s, e) => l.some(i => i.s <= s && i.e >= e);
export const whoIn = (P, d, s, e) => P.filter(p => covers(p.av[d] || [], s, e)).map(p => p.uid);
const needOf = (N, c) => Math.max(1, Math.ceil(N * (c.minimumAttendance || 0) / 100 - 1e-9));

export function daySlots(P, d, c) {
  const out = [], st = c.intervalMinutes;
  for (let t = c.startTime; t + st <= c.endTime; t += st) out.push({ s: t, e: t + st, who: whoIn(P, d, t, t + st) });
  return out;
}
// Maximal runs of consecutive slots where >= k people are free; attendees = people free for the WHOLE run.
export function find(P, dates, c) {
  const N = P.length, need = needOf(N, c), res = new Map();
  if (!N) return [];
  for (const date of dates) {
    const slots = daySlots(P, date, c);
    for (let k = N; k >= need; k--) {
      let run = [];
      const flush = () => {
        if (run.length) {
          const s = run[0].s, e = run[run.length - 1].e;
          let who = run[0].who; for (const r of run) who = who.filter(u => r.who.includes(u));
          const key = date + s + '-' + e;
          if (e - s >= c.minimumDuration && who.length >= need && !res.has(key))
            res.set(key, { date, s, e, duration: e - s, who, n: who.length, total: N, pct: Math.round(who.length / N * 100) });
        }
        run = [];
      };
      for (const sl of slots) sl.who.length >= k ? run.push(sl) : flush();
      flush();
    }
  }
  return [...res.values()];
}
export function rank(opps, c) {
  const pd = c.prefDays || [];
  const score = o => (pd.includes(new Date(o.date + 'T00:00:00Z').getUTCDay()) ? 2 : 0) +
    (c.prefEnd > c.prefStart && Math.min(o.e, c.prefEnd) - Math.max(o.s, c.prefStart) > 0 ? 1 : 0);
  return opps.sort((a, b) => b.n - a.n || b.duration - a.duration || score(b) - score(a) || a.date.localeCompare(b.date) || a.s - b.s);
}
export function stats(P, dates, c) {
  const N = P.length; if (!N) return {};
  const need = needOf(N, c); let bestH = null, bestA = null;
  for (const d of dates) {
    const sl = daySlots(P, d, c);
    const mins = sl.filter(x => x.who.length >= need).length * c.intervalMinutes;
    const avg = sl.length ? sl.reduce((a, x) => a + x.who.length, 0) / sl.length / N : 0;
    if (!bestH || mins > bestH.mins) bestH = { date: d, mins };
    if (!bestA || avg > bestA.avg) bestA = { date: d, avg };
  }
  return { bestH, bestA };
}
