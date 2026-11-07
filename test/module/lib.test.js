import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskFromDays, daysFromMask, starRow, progress, ACTION_TEMPLATES, CODE_SYMBOLS, PROFILE_SYMBOLS, PROFILE_COLORS,
  defaultLook, sameCode, fitSize, ALL_DAYS, SCHOOL_DAYS,
} from '../../module/lib/kidsstar.js';
import { createClient, KidsStarError, requestId } from '../../module/lib/api.js';

test('Wochentage als Bitmaske', () => {
  assert.equal(maskFromDays([1, 2, 3, 4, 5]), SCHOOL_DAYS);
  assert.equal(maskFromDays([1, 2, 3, 4, 5, 6, 7]), ALL_DAYS);
  assert.deepEqual(daysFromMask(0b1100000), [6, 7]);
  assert.equal(maskFromDays([0, 8]), 0);
});

test('Sterne und Fortschritt', () => {
  assert.equal(starRow(3), '⭐⭐⭐');
  assert.equal(starRow(12), '⭐ × 12');
  assert.deepEqual(progress(24, 40), { have: 24, missing: 16, pct: 60 });
  assert.deepEqual(progress(50, 40), { have: 40, missing: 0, pct: 100 });
  assert.deepEqual(progress(-3, 10), { have: 0, missing: 13, pct: 0 });
});

test('Vorlagen sind gueltige Startwerte', () => {
  assert.equal(ACTION_TEMPLATES.length, 6);
  for (const t of ACTION_TEMPLATES) {
    assert.ok(t.stars >= 1 && Number.isInteger(t.stars));
    assert.ok(t.weekdays >= 1 && t.weekdays <= 127);
    assert.ok(t.per_day >= 1 && t.per_day <= 10);
  }
});

test('Bildcode-Symbole: neun, verschieden, gleich wie auf dem Tablet', async () => {
  assert.equal(CODE_SYMBOLS.length, 9);
  assert.equal(new Set(CODE_SYMBOLS).size, 9);
  const fs = await import('node:fs');
  const tablet = fs.readFileSync(new URL('../../sidecar/public/tablet/app.js', import.meta.url), 'utf8');
  const m = tablet.match(/const CODE_SYMBOLS = (\[[^\]]+\])/);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), CODE_SYMBOLS);
  assert.ok(sameCode([1, 2, 3, 4], [1, 2, 3, 4]));
  assert.ok(!sameCode([1, 2, 3, 4], [1, 2, 4, 3]));
});

test('Standardaussehen unterscheidet Geschwister', () => {
  assert.equal(new Set(PROFILE_SYMBOLS).size, PROFILE_SYMBOLS.length);
  assert.notDeepEqual(defaultLook(0), defaultLook(1));
  for (const c of PROFILE_COLORS) assert.match(c, /^#[0-9A-F]{6}$/);
});

test('Bild verkleinern: laengste Kante', () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 800, height: 600 });
  assert.deepEqual(fitSize(600, 1200), { width: 400, height: 800 });
  assert.deepEqual(fitSize(300, 200), { width: 300, height: 200 });
});

test('Client: CSRF-Paar, einmal neu holen, Fehlergruende', async () => {
  assert.match(requestId(), /^[0-9a-f]{32}$/);
  const calls = [];
  let csrfRound = 0;
  const fake = async (url, init) => {
    calls.push([init.method, url, init.headers['X-KidsStar-CSRF']]);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/csrf')) return json(200, { data: { token: `tok${++csrfRound}` } });
    if (url.endsWith('/actions') && init.method === 'POST' && init.headers['X-KidsStar-CSRF'] === 'tok1') {
      return json(403, { reason: 'csrf_invalid' });
    }
    if (url.endsWith('/actions')) return json(201, { data: { id: 7 } });
    if (url.endsWith('/broken')) return { ok: false, status: 502, json: async () => { throw new Error('html'); } };
    if (url.endsWith('/yuvomi404')) return json(404, { error: 'Not found.', code: 404 });
    return json(409, { error: 'x', reason: 'insufficient_stars', available: 3 });
  };
  const c = createClient({ fetchImpl: fake });
  assert.deepEqual(await c.post('/actions', { a: 1 }), { id: 7 });
  assert.deepEqual(calls.map((x) => x[2]).filter(Boolean), ['tok1', 'tok2']);
  await assert.rejects(c.get('/broken'), (e) => e instanceof KidsStarError && e.reason === 'unreachable');
  await assert.rejects(c.get('/yuvomi404'), (e) => e.reason === 'unreachable');
  await assert.rejects(c.post('/redemptions', {}), (e) => e.reason === 'insufficient_stars' && e.body.available === 3);
  const offline = createClient({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.get('/me'), (e) => e.reason === 'unreachable');
});
