import { firebaseConfig as cfgFb } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, update, remove, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import * as E from './engine.js';

/* ---------- utilities ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('overlap:' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('overlap:' + k, JSON.stringify(v)); } catch { } }, del: k => { try { localStorage.removeItem('overlap:' + k); } catch { } } };
const friendly = e => /PERMISSION_DENIED/i.test(e?.message || e?.code || '') ? 'Permission denied. Is the session open and are the rules published?' : /network|offline/i.test(e?.message || '') ? 'Network problem — changes will sync when you are back online.' : (e?.message || 'Something went wrong');
const dayLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
function toast(m, t = 'ok') { const d = document.createElement('div'); d.className = 'toast ' + t; d.textContent = m; $('#toasts').append(d); setTimeout(() => d.remove(), 4000); }
function ask({ title, text = '', input, type = 'text', value = '', ok = 'OK', cancel = 'Cancel', danger }) {
  return new Promise(res => {
    const d = $('#dlg'); d.returnValue = '';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(text)}</p>${input ? `<label>${esc(input)}<input type="${type}" name="v" maxlength="40" required value="${esc(value)}"></label>` : ''}<div class="btns">${cancel ? `<button value="x" formnovalidate>${esc(cancel)}</button>` : ''}<button value="ok" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></form>`;
    d.onclose = () => res(d.returnValue === 'ok' ? (input ? $('input', d).value.trim() : true) : null);
    d.showModal(); $('input', d)?.focus();
  });
}

/* ---------- state ---------- */
const S = { user: null, sid: null, info: null, parts: {}, partsLoaded: false, tab: 'overview', draft: {}, dirty: false, ver: 0, status: 'saved', online: true, errs: {}, f: { sort: 'rank', pct: '', dur: '', day: '', full: false }, open: null, loading: false, missing: false, joinAsked: false, offs: [], booted: false };
let auth, db, raf, saveT;
const uid = () => S.user.uid;
const isOwner = () => S.info?.ownerUid === S.user?.uid;
const link = () => `${location.origin}${location.pathname}?session=${S.sid}`;
const dates = () => E.datesBetween(S.info.startDate, S.info.endDate);
const people = () => Object.entries(S.parts).map(([u, p]) => ({ uid: u, name: p.name || '?', updatedAt: p.updatedAt || 0, av: E.fromDb(p.availability) }));
const sref = p => ref(db, `sessions/${S.sid}/${p}`);
function cfg(o = {}) { const i = S.info; return { startTime: i.startTime, endTime: i.endTime, intervalMinutes: i.intervalMinutes, minimumDuration: i.minimumDuration, minimumAttendance: i.minimumAttendance, prefDays: (i.preferredDays || '').split(',').filter(Boolean).map(Number), prefStart: i.prefStart, prefEnd: i.prefEnd, ...o }; }

/* ---------- Firebase / session layer ---------- */
function fatal(t, m) { $('#view').innerHTML = `<div class="card"><h2>${esc(t)}</h2><p>${esc(m)}</p></div>`; }
function boot() {
  const c = cfgFb;
  if (!c || /YOUR_/.test(c.apiKey + c.databaseURL)) return fatal('Firebase is not configured', 'Open firebase-config.js and paste your Firebase web app settings (see README.md).');
  try { const app = initializeApp(c); auth = getAuth(app); db = getDatabase(app); } catch (e) { return fatal('Firebase failed to start', friendly(e)); }
  onValue(ref(db, '.info/connected'), s => { S.online = !!s.val(); conn(); updateStatus(); });
  onAuthStateChanged(auth, u => {
    if (u) { S.user = u; if (!S.booted) { S.booted = true; route(); } else render(); }
    else signInAnonymously(auth).catch(e => fatal('Sign-in failed', 'Enable Anonymous sign-in in Firebase Authentication. ' + friendly(e)));
  });
}
function route() { const q = new URLSearchParams(location.search).get('session') || ls.get('last', null); q ? openSession(q) : render(); }
function detach() { S.offs.forEach(f => f()); S.offs = []; }
function openSession(sid) {
  detach(); Object.assign(S, { sid, info: null, parts: {}, partsLoaded: false, loading: true, missing: false, joinAsked: false, dirty: false, draft: {}, errs: {}, status: 'saved', open: null });
  if (!/^[0-9a-f]{32}$/.test(sid)) { S.loading = false; S.missing = true; return render(); }
  S.offs = [
    onValue(sref('info'), s => { S.info = s.val(); S.loading = false; S.missing = !S.info; if (S.info) remember(); after(); }, fail),
    onValue(sref('participants'), s => { S.parts = s.val() || {}; S.partsLoaded = true; restoreDraft(); after(); }, fail)
  ];
  render();
}
function fail(e) { S.loading = false; toast(friendly(e), 'err'); S.missing = true; render(); }
function remember() { const l = ls.get('recent', []).filter(x => x.id !== S.sid); l.unshift({ id: S.sid, name: S.info.name }); ls.set('recent', l.slice(0, 8)); ls.set('last', S.sid); }
function after() { maybeJoin(); render(true); }
function restoreDraft() {
  if (S.dirty) return;
  const saved = ls.get('draft:' + S.sid, null);
  if (saved && S.parts[uid()]) { S.draft = saved; S.dirty = true; S.status = 'dirty'; checkAll(); clearTimeout(saveT); saveT = setTimeout(save, 500); }
  else S.draft = E.fromDb(S.parts[uid()]?.availability);
}
async function maybeJoin() {
  if (S.joinAsked || !S.info || !S.partsLoaded || S.parts[uid()] || S.info.status !== 'open') return;
  S.joinAsked = true;
  const n = await ask({ title: `Join “${S.info.name}”`, text: 'Enter the name others will see.', input: 'Your name', value: ls.get('name', ''), ok: 'Join', cancel: 'Not now' });
  if (!n) return render();
  ls.set('name', n);
  try { await set(sref('participants/' + uid()), { name: n, joinedAt: serverTimestamp(), updatedAt: serverTimestamp() }); toast('Joined'); }
  catch (e) { toast(friendly(e), 'err'); }
}
async function createSession(f) {
  const d = Object.fromEntries(new FormData(f)), st = E.parseT(d.st), et = E.parseT(d.et);
  const n = E.datesBetween(d.sd, d.ed, 63).length;
  if (!d.name.trim() || !n || n > 62 || !(et > st)) return toast('Check name, dates (max 62 days) and hours.', 'err');
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const info = { name: d.name.trim().slice(0, 60), ownerUid: uid(), createdAt: serverTimestamp(), startDate: d.sd, endDate: d.ed, startTime: st, endTime: et, intervalMinutes: +d.iv, minimumDuration: Math.max(15, +d.md || 60), minimumAttendance: +d.ma, status: 'open' };
  const pd = [...f.querySelectorAll('[name=pd]:checked')].map(x => x.value).join(','); if (pd) info.preferredDays = pd;
  const ps = E.parseT(d.ps), pe = E.parseT(d.pe); if (pe > ps) { info.prefStart = ps; info.prefEnd = pe; }
  try { await set(ref(db, `sessions/${id}/info`), info); history.replaceState(null, '', '?session=' + id); S.tab = 'overview'; openSession(id); }
  catch (e) { toast(friendly(e), 'err'); }
}
async function copyLink() {
  try { await navigator.clipboard.writeText(link()); toast('Invitation link copied'); }
  catch { ask({ title: 'Copy this link', text: link(), cancel: null }); }
}

/* ---------- availability editing ---------- */
function checkAll() { S.errs = {}; for (const d of dates()) { const r = E.normalize(S.draft[d], S.info.startTime, S.info.endTime, S.info.intervalMinutes); if (r.errors.length) S.errs[d] = r.errors; } return Object.keys(S.errs).length > 0; }
function touch(d) {
  S.dirty = true; S.ver++; ls.set('draft:' + S.sid, S.draft);
  const bad = checkAll(); S.status = bad ? 'fix' : 'dirty'; repaint(d); updateStatus();
  clearTimeout(saveT); if (!bad) saveT = setTimeout(save, 900);
}
async function save() {
  if (!S.parts[uid()] || checkAll()) return;
  const v = S.ver, av = {};
  for (const d of dates()) av[d] = E.normalize(S.draft[d], S.info.startTime, S.info.endTime, S.info.intervalMinutes).intervals;
  S.status = 'saving'; updateStatus();
  try {
    await update(sref('participants/' + uid()), { availability: E.toDb(av), updatedAt: serverTimestamp() });   // resolves only after server ack
    if (v === S.ver) { S.dirty = false; ls.del('draft:' + S.sid); S.status = 'saved'; } else S.status = 'dirty';
  } catch (e) { S.status = 'error'; toast(friendly(e), 'err'); }
  updateStatus();
}
function updateStatus() {
  const el = $('#sv'); if (!el) return;
  const m = { saved: ['Saved', 'ok'], saving: [S.online ? 'Saving…' : 'Offline — will sync', 'warn'], dirty: ['Unsaved changes', 'warn'], fix: ['Fix errors to save', 'err'], error: ['Save failed — retrying on next edit', 'err'] }[S.status];
  el.textContent = m[0]; el.className = 'pill ' + m[1];
}
function dayHtml(d) {
  const l = S.draft[d] || [], st = S.info.intervalMinutes * 60;
  return `<section class="card" data-date="${d}"><h3>${dayLabel(d)}</h3>${l.map((x, i) => `<div class="row" data-i="${i}"><input type="time" step="${st}" data-f="s" aria-label="Start time" value="${Number.isInteger(x.s) ? E.fmt(x.s) : ''}"><span>–</span><input type="time" step="${st}" data-f="e" aria-label="End time" value="${Number.isInteger(x.e) ? E.fmt(x.e) : ''}"><button data-act="del" aria-label="Delete interval">✕</button></div>`).join('') || '<small>No availability</small>'}
  ${(S.errs[d] || []).map(e => `<div class="err">${esc(e)}</div>`).join('')}
  <div class="btns"><button data-act="add">+ Add</button><button data-act="full">All day</button><button data-act="clear">Clear</button><button data-act="copy">Copy to…</button></div></section>`;
}
function repaint(d) { const el = $(`[data-date="${d}"]`); if (el) el.outerHTML = dayHtml(d); }

/* ---------- views ---------- */
function results() {
  const f = S.f, o = { minimumAttendance: f.full ? 100 : f.pct !== '' ? +f.pct : S.info.minimumAttendance };
  if (f.dur) o.minimumDuration = Math.max(15, +f.dur);
  const P = people(), c = cfg(o); let ds = dates(); if (f.day) ds = ds.filter(d => d === f.day);
  const opps = E.rank(E.find(P, ds, c), c);
  if (f.sort === 'dur') opps.sort((a, b) => b.duration - a.duration || b.n - a.n); else if (f.sort === 'att') opps.sort((a, b) => b.n - a.n || a.date.localeCompare(b.date) || a.s - b.s);
  return { P, c, opps, stats: E.stats(P, dates(), cfg()) };
}
const oppKey = o => o.date + o.s + o.e;
function oppHtml(o, i) {
  const on = S.open === oppKey(o), P = people();
  const row = p => `<li>${esc(p.name)} <small>${(p.av[o.date] || []).map(x => E.fmt(x.s) + '–' + E.fmt(x.e)).join(', ') || 'no times'}</small></li>`;
  return `<li><button class="opp ${on ? 'on' : ''}" data-act="opp" data-k="${oppKey(o)}" aria-expanded="${on}"><b>${i + 1}. ${dayLabel(o.date)} — ${E.fmt(o.s)}–${E.fmt(o.e)}</b><span>${o.n}/${o.total} people · ${E.dur(o.duration)} · ${o.pct}% attendance</span></button>${on ? `<div class="detail"><h4>Can attend</h4><ul>${P.filter(p => o.who.includes(p.uid)).map(row).join('')}</ul><h4>Cannot attend</h4><ul>${P.filter(p => !o.who.includes(p.uid)).map(row).join('') || '<li>Nobody — everyone can come</li>'}</ul></div>` : ''}</li>`;
}
function heat(P) {
  const i = S.info, N = P.length || 1, h0 = Math.floor(i.startTime / 60), h1 = Math.ceil(i.endTime / 60), hs = []; for (let h = h0; h < h1; h++) hs.push(h);
  return `<div class="heat"><table><thead><tr><th></th>${hs.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${dates().map(d => `<tr><th scope="row">${dayLabel(d)}</th>${hs.map(h => { const s = Math.max(h * 60, i.startTime), e = Math.min(h * 60 + 60, i.endTime), n = E.whoIn(P, d, s, e).length; return `<td class="cell" style="--a:${Math.round(n / N * 100)}%" title="${dayLabel(d)} ${E.fmt(s)}–${E.fmt(e)}: ${n}/${N}">${n || ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div><div class="legend">0 <i></i> all (${N}) · hour columns, count of people free</div>`;
}
const needJoin = () => !S.parts[uid()] ? `<div class="card"><p>${S.info.status === 'open' ? 'Join this session to enter your availability.' : 'This session is closed to new participants.'}</p>${S.info.status === 'open' ? '<button class="primary" data-act="join">Join session</button>' : ''}</div>` : '';

const V = {
  overview() {
    const i = S.info, P = people(), sub = P.filter(p => Object.values(p.av).some(l => l.length)).length, r = results(), b = r.opps[0], last = Math.max(0, ...P.map(p => p.updatedAt));
    return `<h2>${esc(i.name)} <span class="pill ${i.status === 'open' ? 'ok' : 'warn'}">${i.status}</span></h2>${needJoin()}
    <div class="grid"><div class="card"><small>Participants</small><div class="big">${P.length}</div></div><div class="card"><small>Schedules submitted</small><div class="big">${sub}</div></div></div>
    <div class="card"><h3>Best opportunity now</h3>${b ? `<div class="big">${dayLabel(b.date)} ${E.fmt(b.s)}–${E.fmt(b.e)}</div><p>${b.n}/${b.total} people · ${E.dur(b.duration)} · ${b.pct}%</p>` : '<p class="muted">No common time yet. Results appear as people submit availability.</p>'}
    ${last ? `<small>Last update: ${new Date(last).toLocaleString()}</small>` : ''}<div class="btns"><button class="primary" data-act="tab" data-k="avail">Edit my availability</button><button data-act="tab" data-k="best">See results</button><button data-act="copy-link">Copy session link</button></div></div>`;
  },
  avail() {
    const me = S.parts[uid()]; if (!me) return needJoin();
    return `<h2>My availability <span id="sv" class="pill ok">Saved</span></h2><p class="muted">Hours ${E.fmt(S.info.startTime)}–${E.fmt(S.info.endTime)}, ${S.info.intervalMinutes}-minute steps. Changes save automatically.</p>${dates().map(dayHtml).join('')}`;
  },
  people() {
    const P = people().sort((a, b) => a.name.localeCompare(b.name));
    return `<h2>Participants</h2>${P.map(p => { const ds = Object.entries(p.av).filter(([, l]) => l.length), mins = ds.reduce((a, [, l]) => a + l.reduce((x, i) => x + i.e - i.s, 0), 0); return `<div class="card"><b>${esc(p.name)}${p.uid === uid() ? ' (you)' : ''}</b> <span class="pill ${ds.length ? 'ok' : 'warn'}">${ds.length ? 'submitted' : 'no availability'}</span><p><small>${ds.length} days · ${E.dur(mins) || '0m'} total${p.updatedAt ? ' · updated ' + new Date(p.updatedAt).toLocaleString() : ''}</small></p><small>${ds.map(([d, l]) => `${dayLabel(d)}: ${l.map(i => E.fmt(i.s) + '–' + E.fmt(i.e)).join(', ')}`).join('<br>')}</small>${isOwner() && p.uid !== uid() ? `<div class="btns"><button class="danger" data-act="remove" data-u="${p.uid}">Remove</button></div>` : ''}</div>`; }).join('') || '<p class="muted">Nobody yet.</p>'}`;
  },
  best() {
    const r = results(), f = S.f, N = r.P.length;
    const longest = r.opps.reduce((m, o) => (!m || o.duration > m.duration ? o : m), null);
    let body;
    if (!N) body = '<p class="muted">No participants yet.</p>';
    else if (r.opps.length) body = `<ul>${r.opps.map(oppHtml).join('')}</ul>`;
    else { const alt = E.rank(E.find(r.P, dates(), cfg({ minimumAttendance: 0, minimumDuration: S.info.intervalMinutes })), cfg()).slice(0, 3);
      body = `<p>No window of ${E.dur(r.c.minimumDuration)} with ${r.c.minimumAttendance}% attendance. ${alt.length ? 'Closest alternatives (any attendance, shortest allowed length):' : 'Nobody has overlapping availability yet.'}</p><ul>${alt.map(oppHtml).join('')}</ul>`; }
    return `<h2>Best times</h2>${needJoin()}
    <div class="card filters"><label>Sort<select data-f="sort"><option value="rank">Best overall</option><option value="att" ${f.sort === 'att' ? 'selected' : ''}>Attendance</option><option value="dur" ${f.sort === 'dur' ? 'selected' : ''}>Duration</option></select></label>
    <label>Min attendance<select data-f="pct"><option value="">Session default (${S.info.minimumAttendance}%)</option>${[100, 90, 80, 60, 0].map(v => `<option value="${v}" ${String(f.pct) === String(v) ? 'selected' : ''}>${v ? v + '%' : 'Any'}</option>`).join('')}</select></label>
    <label>Min minutes<input type="number" data-f="dur" min="15" step="15" placeholder="${S.info.minimumDuration}" value="${esc(f.dur)}"></label>
    <label>Day<select data-f="day"><option value="">All days</option>${dates().map(d => `<option value="${d}" ${f.day === d ? 'selected' : ''}>${dayLabel(d)}</option>`).join('')}</select></label>
    <label><input type="checkbox" data-f="full" ${f.full ? 'checked' : ''} style="width:auto"> Full attendance only</label></div>
    <div class="card">${body}</div>
    ${N ? `<div class="card"><h3>Highlights</h3><small>${longest ? `Longest common period: ${dayLabel(longest.date)} ${E.fmt(longest.s)}–${E.fmt(longest.e)} (${E.dur(longest.duration)}, ${longest.n}/${N})<br>` : ''}${r.stats.bestH?.mins ? `Most available hours: ${dayLabel(r.stats.bestH.date)} (${E.dur(r.stats.bestH.mins)})<br>` : ''}${r.stats.bestA ? `Highest average availability: ${dayLabel(r.stats.bestA.date)} (${Math.round(r.stats.bestA.avg * 100)}%)` : ''}</small></div><div class="card"><h3>Heatmap</h3>${heat(r.P)}</div>` : ''}`;
  },
  settings() {
    const i = S.info, mine = S.parts[uid()];
    return `<h2>Settings</h2>
    ${mine ? `<form class="card" data-form="rename"><h3>Your name</h3><label>Display name<input name="n" maxlength="40" required value="${esc(mine.name)}"></label><div class="btns"><button class="primary">Save name</button><button type="button" class="danger" data-act="leave">Leave session</button></div></form>` : ''}
    <div class="card"><h3>Invitation</h3><p><small>${esc(link())}</small></p><p class="muted"><small>Anyone with this link can join while the session is open. Keep it private. People are identified by anonymous Firebase accounts, not by name.</small></p><button data-act="copy-link">Copy link</button></div>
    ${isOwner() ? `<form class="card" data-form="settings"><h3>Organizer</h3><label>Session name<input name="name" maxlength="60" required value="${esc(i.name)}"></label>
    <div class="two"><label>Min duration (min)<input type="number" name="md" min="15" step="15" value="${i.minimumDuration}"></label><label>Min attendance %<select name="ma">${[100, 90, 80, 60, 0].map(v => `<option value="${v}" ${v === i.minimumAttendance ? 'selected' : ''}>${v ? v + '%' : 'Any'}</option>`).join('')}</select></label></div>
    <div class="btns"><button class="primary">Save settings</button><button type="button" data-act="toggle">${i.status === 'open' ? 'Close to new participants' : 'Reopen session'}</button><button type="button" class="danger" data-act="delsession">Delete session</button></div></form>` : ''}`;
  }
};
function home() {
  const rec = ls.get('recent', []), t = new Date().toISOString().slice(0, 10), t2 = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
  return `<h2>Find the time that works for everyone</h2>
  <form class="card" data-form="join"><h3>Join a session</h3><label>Invitation link or ID<input name="l" required></label><button class="primary">Join</button></form>
  ${rec.length ? `<div class="card"><h3>Your sessions</h3>${rec.map(r => `<button class="opp" data-act="recent" data-id="${r.id}">${esc(r.name)}</button>`).join('')}</div>` : ''}
  <form class="card" data-form="create"><h3>Create a session</h3><label>Session name<input name="name" maxlength="60" required></label>
  <div class="two"><label>Start date<input type="date" name="sd" required value="${t}"></label><label>End date<input type="date" name="ed" required value="${t2}"></label>
  <label>Earliest time<input type="time" name="st" required value="08:00"></label><label>Latest time<input type="time" name="et" required value="22:00"></label>
  <label>Precision<select name="iv"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="60">60 min</option></select></label>
  <label>Min meeting (min)<input type="number" name="md" min="15" step="15" value="60"></label></div>
  <label>Min attendance<select name="ma"><option value="100">100%</option><option value="90">90%</option><option value="80">80%</option><option value="60">60%</option><option value="0" selected>Any</option></select></label>
  <fieldset style="border:1px solid var(--bd);border-radius:10px"><legend><small>Preferred days (optional)</small></legend>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `<label style="display:inline-block;margin-right:8px"><input type="checkbox" name="pd" value="${i}" style="width:auto"> ${n}</label>`).join('')}</fieldset>
  <div class="two"><label>Preferred from (optional)<input type="time" name="ps"></label><label>Preferred until<input type="time" name="pe"></label></div>
  <p class="muted"><small>Anyone with the invitation link can join. No emails or passwords are collected.</small></p><button class="primary">Create session</button></form>`;
}
function missingHtml() { return `<div class="card"><h2>Session not found</h2><p>The link may be wrong, or the organizer deleted the session.</p><button data-act="home">Back</button></div>`; }
function nav() {
  const TABS = [['overview', 'Overview'], ['avail', 'My Availability'], ['people', 'Participants'], ['best', 'Best Times'], ['settings', 'Settings']];
  $('#nav').innerHTML = S.sid && S.info ? TABS.map(([k, l]) => `<button data-act="tab" data-k="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('') : '';
}
function conn() { const c = $('#conn'); c.textContent = S.online ? 'Online' : 'Offline'; c.className = 'pill ' + (S.online ? 'ok' : 'warn'); }
function render(soft) {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const v = $('#view'); nav(); conn();
    if (soft && /INPUT|SELECT/.test(document.activeElement?.tagName) && v.contains(document.activeElement)) return;   // don't clobber typing
    if (!S.user) return;
    if (!S.sid) return v.innerHTML = home();
    if (S.loading) return v.innerHTML = '<p class="muted pad">Loading session…</p>';
    if (S.missing || !S.info) return v.innerHTML = missingHtml();
    if (S.tab === 'avail' && S.dirty && v.dataset.tab === 'avail') return updateStatus();
    v.dataset.tab = S.tab; v.innerHTML = V[S.tab](); updateStatus();
  });
}

/* ---------- events (delegated) ---------- */
const view = $('#view');
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, d = b.closest('[data-date]')?.dataset.date, i = +b.closest('[data-i]')?.dataset.i;
  try {
    if (a === 'tab') { S.tab = b.dataset.k; view.dataset.tab = ''; render(); }
    else if (a === 'home') { detach(); S.sid = null; S.info = null; history.replaceState(null, '', location.pathname); render(); }
    else if (a === 'recent') { history.replaceState(null, '', '?session=' + b.dataset.id); S.tab = 'overview'; openSession(b.dataset.id); }
    else if (a === 'copy-link') copyLink();
    else if (a === 'join') { S.joinAsked = false; maybeJoin(); }
    else if (a === 'opp') { S.open = S.open === b.dataset.k ? null : b.dataset.k; render(); }
    else if (a === 'add') { const l = S.draft[d] = S.draft[d] || [], s = l.length ? Math.max(...l.map(x => x.e || 0)) : S.info.startTime, en = Math.min(s + 60, S.info.endTime); if (s >= S.info.endTime) return toast('No room left on this day', 'err'); l.push({ s, e: en }); touch(d); }
    else if (a === 'del') { S.draft[d].splice(i, 1); touch(d); }
    else if (a === 'full') { S.draft[d] = [{ s: S.info.startTime, e: S.info.endTime }]; touch(d); }
    else if (a === 'clear') { S.draft[d] = []; touch(d); }
    else if (a === 'copy') { const t = await ask({ title: 'Copy ' + dayLabel(d), text: 'Copy these intervals to which date? (replaces that day)', input: 'Date', type: 'date', ok: 'Copy' }); if (!t) return; if (!dates().includes(t)) return toast('Date is outside the planning period', 'err'); S.draft[t] = (S.draft[d] || []).map(x => ({ ...x })); touch(t); }
    else if (a === 'remove') { if (await ask({ title: 'Remove participant?', text: 'Their availability will be deleted.', ok: 'Remove', danger: true })) await remove(sref('participants/' + b.dataset.u)); }
    else if (a === 'leave') { if (await ask({ title: 'Leave session?', text: 'Your availability will be deleted.', ok: 'Leave', danger: true })) { await remove(sref('participants/' + uid())); ls.del('draft:' + S.sid); S.dirty = false; S.joinAsked = true; toast('You left the session'); } }
    else if (a === 'toggle') { await update(sref('info'), { status: S.info.status === 'open' ? 'closed' : 'open' }); toast('Updated'); }
    else if (a === 'delsession') { if (await ask({ title: 'Delete session?', text: 'This removes the session and all availability for everyone.', ok: 'Delete', danger: true })) { await remove(ref(db, `sessions/${S.sid}`)); ls.set('recent', ls.get('recent', []).filter(x => x.id !== S.sid)); ls.del('last'); detach(); S.sid = null; history.replaceState(null, '', location.pathname); render(); } }
  } catch (err) { toast(friendly(err), 'err'); }
});
document.addEventListener('change', e => {
  const t = e.target, row = t.closest('.row'), card = t.closest('[data-date]');
  if (row && card) { const d = card.dataset.date, x = S.draft[d][+row.dataset.i]; x[t.dataset.f] = E.parseT(t.value); return touch(d); }
  if (t.dataset.f && S.f && t.closest('.filters')) { S.f[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value; render(); }
});
document.addEventListener('submit', async e => {
  const f = e.target, k = f.dataset.form; if (!k) return; e.preventDefault();
  try {
    if (k === 'create') await createSession(f);
    else if (k === 'join') { const m = /[0-9a-f]{32}/.exec(new FormData(f).get('l').toLowerCase()); if (!m) return toast('That does not look like an invitation link', 'err'); history.replaceState(null, '', '?session=' + m[0]); S.tab = 'overview'; openSession(m[0]); }
    else if (k === 'rename') { await update(sref('participants/' + uid()), { name: new FormData(f).get('n').trim() }); ls.set('name', new FormData(f).get('n').trim()); toast('Name saved'); }
    else if (k === 'settings') { const d = Object.fromEntries(new FormData(f)); await update(sref('info'), { name: d.name.trim(), minimumDuration: Math.max(15, +d.md || 60), minimumAttendance: +d.ma }); toast('Settings saved'); }
  } catch (err) { toast(friendly(err), 'err'); }
});
window.addEventListener('beforeunload', ev => { if (S.dirty && S.status !== 'saved') { ev.preventDefault(); } });
boot();
