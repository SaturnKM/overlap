// Run: node engine.test.js
import assert from 'node:assert/strict';
import * as E from './engine.js';
const c = { startTime: 480, endTime: 1320, intervalMinutes: 30, minimumDuration: 60, minimumAttendance: 100 };
const P = (...a) => a.map((av, i) => ({ uid: 'u' + i, name: 'P' + i, av }));
const D = '2026-01-05', iv = (a, b) => ({ s: a * 60, e: b * 60 });
const t = (n, f) => { f(); console.log('ok -', n); };
t('identical availability', () => { const r = E.find(P({ [D]: [iv(14, 16)] }, { [D]: [iv(14, 16)] }), [D], c); assert.equal(r.length, 1); assert.equal(r[0].duration, 120); });
t('no overlap -> none at 100%', () => assert.equal(E.find(P({ [D]: [iv(8, 10)] }, { [D]: [iv(12, 14)] }), [D], c).length, 0));
t('separated intervals are not merged', () => { const r = E.find(P({ [D]: [iv(14, 15), iv(16, 18)] }, { [D]: [iv(14, 18)] }), [D], c); assert.deepEqual(r.map(x => x.duration), [60, 120]); });
t('touching intervals merge', () => assert.deepEqual(E.normalize([iv(14, 15), iv(15, 16)]).intervals, [iv(14, 16)]));
t('overlap rejected', () => assert.ok(E.normalize([iv(14, 16), iv(15, 17)]).errors.length));
t('shorter than minimum filtered', () => assert.equal(E.find(P({ [D]: [iv(14, 14.5)] }, { [D]: [iv(14, 14.5)] }), [D], c).length, 0));
t('partial attendance', () => { const r = E.find(P({ [D]: [iv(9, 12)] }, { [D]: [iv(9, 12)] }, {}), [D], { ...c, minimumAttendance: 60 }); assert.equal(r[0].n, 2); assert.equal(r[0].pct, 67); });
t('empty participant, full-day participant', () => { const r = E.find(P({ [D]: [iv(8, 22)] }, {}), [D], { ...c, minimumAttendance: 0 }); assert.equal(r[0].duration, 840); });
t('ranking: attendance first, then duration', () => { const r = E.rank(E.find(P({ [D]: [iv(9, 13)] }, { [D]: [iv(11, 13)] }), [D], { ...c, minimumAttendance: 0 }), c); assert.equal(r[0].n, 2); });
t('multiple windows same day', () => assert.equal(E.find(P({ [D]: [iv(9, 11), iv(15, 17)] }), [D], c).length, 2));
t('invalid imported data dropped', () => assert.deepEqual(E.fromDb({ [D]: { a: { start: 'x', end: 5 }, b: { start: 600, end: 540 } } })[D], []));
t('toDb/fromDb roundtrip', () => { const a = { [D]: [iv(9, 11)] }; assert.deepEqual(E.fromDb(E.toDb(a)), a); });
