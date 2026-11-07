import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createTablet, MAX_CODE_FAILURES } from '../src/tablet.js';
import { createYuvomiClient } from '../src/yuvomi.js';
import { createImageStore } from '../src/images.js';
import { createApp, PREFIX } from '../src/server.js';

const quiet = { info() {}, error() {} };
const T = `${PREFIX}/tablet`;

// --- Nachgebautes Yuvomi mit Sitzungen und einem API-Token -------------------
let moduleOn = true;
let members = [
  { id: 1, display_name: 'Mama', family_role: 'mom' },
  { id: 10, display_name: 'Ian', family_role: 'child', avatar_color: '#22AA44' },
  { id: 11, display_name: 'Mia', family_role: 'child' },
  { id: 12, display_name: 'Leo', family_role: 'child' },
];
const perms = () => ({ admin: true, modules: moduleOn ? { 'ext:kidsstar': 'write' } : {} });
const SESSIONS = {
  'sid-admin': () => ({ user: { id: 1, display_name: 'Mama', family_role: 'mom' }, permissions: perms() }),
  'sid-ian': () => ({ user: { id: 10, display_name: 'Ian', family_role: 'child' }, permissions: { admin: false, modules: moduleOn ? { 'ext:kidsstar': 'write' } : {} } }),
};
const yv = http.createServer((req, res) => {
  const sid = /yuvomi\.sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const me = SESSIONS[sid]?.();
  // Wie Yuvomi: ein gescoptes Token erreicht /auth nie; /extensions/kidsstar
  // antwortet 404, solange das Modul (und damit sein Scope) existiert, sonst 403.
  if (!me && token === 'tok-ok') {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/api/v1/auth')) return json(403, { error: 'Token scope does not permit this operation.' });
    if (req.url === '/api/v1/family/members') return json(200, { data: members });
    if (req.url.startsWith('/api/v1/extensions/kidsstar/')) return moduleOn ? json(404, { error: 'Not found.' }) : json(403, { error: 'Token scope does not permit this operation.' });
    return json(403, { error: 'Token scope does not permit this operation.' });
  }
  if (!me) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/api/v1/auth/me') return res.end(JSON.stringify(me));
  if (req.url === '/api/v1/family/members') return res.end(JSON.stringify({ data: members }));
  if (req.url === '/api/v1/preferences') return res.end(JSON.stringify({ data: { timezone_effective: 'Europe/Berlin' } }));
  return res.end('{}');
});

let clockMs = Date.parse('2026-11-02T08:00:00Z');
const servers = [];
let base;
let baseNoToken;
let tmp;

async function start(apiToken) {
  const db = openDatabase(':memory:', { log: quiet });
  const service = createService(db);
  const tablet = createTablet(db, { now: () => clockMs });
  const yuvomi = createYuvomiClient({ yuvomiUrl: `http://127.0.0.1:${yv.address().port}`, cacheMs: 0, householdCacheMs: 0, serviceCacheMs: 0, apiToken });
  const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
  const app = createApp({
    db, service, tablet, yuvomi, log: quiet, clock: () => new Date(clockMs),
    images: createImageStore(path.join(dir, 'images')), profileImages: createImageStore(path.join(dir, 'profile-images')),
  });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { url: `http://127.0.0.1:${s.address().port}`, dir };
}

let dataDir;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kidsstar-tablet-'));
  await new Promise((r) => yv.listen(0, '127.0.0.1', r));
  const a = await start('tok-ok');
  base = a.url;
  dataDir = a.dir;
  baseNoToken = (await start('')).url;
});
after(() => {
  for (const s of servers) s.close();
  yv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Clients ------------------------------------------------------------------
/** Browser mit Cookie-Glas: fuer die Elternsitzung und fuer das Tablet. */
function browser(root = () => base, initial = {}) {
  const jar = new Map(Object.entries(initial));
  let csrf = null;
  async function call(method, p, body, { raw, headers = {}, csrfPath } = {}) {
    if (method !== 'GET' && !csrf && csrfPath) {
      const r = await call('GET', csrfPath);
      csrf = r.body?.data?.token;
    }
    const h = { origin: root(), ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && csrf) h['x-kidsstar-csrf'] = csrf;
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    const res = await fetch(`${root()}${p}`, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return { jar, call, resetCsrf: () => { csrf = null; } };
}

function parent() {
  const b = browser(() => base, { 'yuvomi.sid': 'sid-admin' });
  const o = { csrfPath: `${PREFIX}/csrf` };
  return {
    get: (p) => b.call('GET', PREFIX + p),
    post: (p, body) => b.call('POST', PREFIX + p, body ?? {}, o),
    patch: (p, body) => b.call('PATCH', PREFIX + p, body, o),
    put: (p, raw) => b.call('PUT', PREFIX + p, undefined, { ...o, raw, headers: { 'content-type': 'image/png' } }),
    del: (p) => b.call('DELETE', PREFIX + p, undefined, o),
  };
}
function tabletClient(root = () => base) {
  const b = browser(root);
  const o = { csrfPath: `${T}/api/csrf` };
  return {
    jar: b.jar,
    resetCsrf: b.resetCsrf,
    page: (p = '/') => b.call('GET', T + p),
    get: (p) => b.call('GET', `${T}/api${p}`),
    post: (p, body) => b.call('POST', `${T}/api${p}`, body ?? {}, o),
    put: (p, body) => b.call('PUT', `${T}/api${p}`, body, o),
    del: (p) => b.call('DELETE', `${T}/api${p}`, undefined, o),
    pair: (code) => b.call('POST', `${T}/api/pair`, { code }),
  };
}

const mama = parent();
let n = 0;
const rid = () => `tab-${String(++n).padStart(8, '0')}`;
const PNG = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, seed)]);

async function pairedTablet(childIds = [10, 11], name = 'Flur') {
  const d = await mama.post('/devices', { name, child_ids: childIds });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const t = tabletClient();
  const p = await t.pair(d.body.data.pairing_code);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return { t, device: d.body.data.device, code: d.body.data.pairing_code };
}

// --- Tests --------------------------------------------------------------------
test('Seite kommt vom Dienst, mit eigener CSP, ohne Yuvomi-Sitzung', async () => {
  const t = tabletClient();
  const r = await t.page('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(r.body.toString(), /app\.js/);
  assert.equal((await t.page('/app.js')).status, 200);
  const redirect = await t.page('');
  assert.equal(redirect.status, 308);
  const st = await t.get('/state');
  assert.deepEqual(st.body.data, { paired: false });
});

test('Kopplung: falscher Code, richtiger Code einmalig, Ablauf', async () => {
  const t = tabletClient();
  assert.equal((await t.pair('AAAA-BBBB')).body.reason, 'pairing_invalid');
  const d = await mama.post('/devices', { name: 'Flur', child_ids: [10] });
  assert.match(d.body.data.pairing_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(d.body.data.device.pairing_open, true);
  assert.equal((await t.pair(d.body.data.pairing_code.toLowerCase().replace('-', ' '))).status, 201);
  // Ein zweites Geraet mit demselben Code: abgelehnt.
  assert.equal((await tabletClient().pair(d.body.data.pairing_code)).body.reason, 'pairing_invalid');
  const st = await t.get('/state');
  assert.equal(st.body.data.paired, true);
  // Abgelaufener Code
  const d2 = await mama.post('/devices', { name: 'Kueche', child_ids: [10] });
  clockMs += 16 * 60 * 1000;
  assert.equal((await tabletClient().pair(d2.body.data.pairing_code)).body.reason, 'pairing_invalid');
  // Das Geraetegeheimnis steht nicht im Klartext in der Antwort an die Eltern.
  const list = await mama.get('/devices');
  assert.ok(!JSON.stringify(list.body).includes(t.jar.get('kidsstar-device')));
});

test('Nur Kinder koppeln, nur Eltern verwalten', async () => {
  assert.equal((await mama.post('/devices', { name: 'x', child_ids: [1] })).body.reason, 'not_a_child');
  const ian = browser(() => base, { 'yuvomi.sid': 'sid-ian' });
  const r = await ian.call('POST', `${PREFIX}/devices`, { name: 'x', child_ids: [10] }, { csrfPath: `${PREFIX}/csrf` });
  assert.equal(r.body.reason, 'parent_required');
  assert.equal((await ian.call('GET', `${PREFIX}/devices`)).status, 403);
});

test('Tablet zeigt und oeffnet nur freigegebene Profile', async () => {
  const { t } = await pairedTablet([10, 11]);
  const st = (await t.get('/state')).body.data;
  assert.deepEqual(st.profiles.map((p) => p.child_id), [10, 11]);
  assert.equal(st.profiles[0].color, '#22AA44');
  const leo = await t.post('/session', { child_id: 12 });
  assert.equal(leo.status, 404);
  assert.equal(leo.body.reason, 'profile_not_found');
  const mamaAsKid = await t.post('/session', { child_id: 1 });
  assert.equal(mamaAsKid.status, 404);
  // Ohne Kindersitzung keine Daten.
  assert.equal((await t.get('/today')).body.reason, 'kid_session_required');
});

test('Kind am Tablet: melden, Sterne, Verlauf, Wunsch, Einloesung - aber keine Elternrechte', async () => {
  const { t } = await pairedTablet([10]);
  const a = await mama.post('/actions', { title: 'Zähne', icon: '🪥', stars: 3, child_ids: [10], requires_approval: false });
  const r = await mama.post('/rewards', { title: 'Eis', stars: 3 });
  assert.equal((await t.post('/session', { child_id: 10 })).status, 201);
  const today = (await t.get('/today')).body.data;
  assert.equal(today.child_id, 10);
  assert.ok(today.actions.some((x) => x.id === a.body.data.id));
  const done = await t.post('/completions', { action_id: a.body.data.id, request_id: rid() });
  assert.equal(done.body.data.completion.status, 'approved');
  assert.equal((await t.get('/ledger')).body.data.balance.available, 3);
  assert.equal((await t.post('/wishes', { title: 'Bagger', request_id: rid() })).status, 201);
  const red = await t.post('/redemptions', { reward_id: r.body.data.id, request_id: rid(), expected_stars: 3 });
  assert.equal(red.body.data.redemption.status, 'pending');
  // Elternfunktionen gibt es auf dem Tablet nicht.
  assert.equal((await t.post('/ledger/bonus', { child_id: 10, stars: 100, reason: 'x', request_id: rid() })).status, 404);
  assert.equal((await t.post(`/redemptions/${red.body.data.redemption.id}/approve`, {})).status, 404);
  assert.equal((await t.post(`/completions/${done.body.data.completion.id}/approve`, {})).status, 404);
  // Und keine Yuvomi-Sitzung: das Tablet hat nur KidsStar-Cookies.
  assert.deepEqual([...t.jar.keys()].sort(), ['kidsstar-device', 'kidsstar-kid', 'kidsstar-tablet-csrf']);
  const asSession = await fetch(`${base}${PREFIX}/me`, { headers: { cookie: [...t.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(asSession.status, 401);
  // Die Ids im Koerper aendern das aktive Kind nicht.
  const fake = await t.post('/wishes', { title: 'Als Mia', request_id: rid(), child_id: 11, user_id: 11 });
  assert.equal(fake.body.data.child_id, 10);
});

test('Profilwechsel: alte Sitzung ungueltig, keine Daten des vorherigen Kindes', async () => {
  const { t } = await pairedTablet([10, 11]);
  await mama.post('/ledger/bonus', { child_id: 10, stars: 7, reason: 'Nur Ian', request_id: rid() });
  await t.post('/session', { child_id: 10 });
  const ianCookie = t.jar.get('kidsstar-kid');
  assert.equal((await t.get('/ledger')).body.data.child_id, 10);
  // Wechseln
  await t.del('/session');
  assert.equal(t.jar.has('kidsstar-kid'), false);
  assert.equal((await t.get('/ledger')).body.reason, 'kid_session_required');
  await t.post('/session', { child_id: 11 });
  const mia = (await t.get('/ledger')).body.data;
  assert.equal(mia.child_id, 11);
  assert.ok(!mia.entries.some((e) => e.reason === 'Nur Ian'));
  // Ians altes Cookie ist tot, auch wenn jemand es wieder einsetzt.
  t.jar.set('kidsstar-kid', ianCookie);
  assert.equal((await t.get('/ledger')).body.reason, 'kid_session_required');
});

test('Neues Profil oeffnen beendet das vorherige auch ohne Abmelden', async () => {
  const { t } = await pairedTablet([10, 11]);
  await t.post('/session', { child_id: 10 });
  const old = t.jar.get('kidsstar-kid');
  await t.post('/session', { child_id: 11 });
  t.jar.set('kidsstar-kid', old);
  assert.equal((await t.get('/today')).status, 401);
});

test('Kindersitzung gilt nur auf ihrem eigenen Tablet', async () => {
  const a = await pairedTablet([10]);
  const b = await pairedTablet([10]);
  await a.t.post('/session', { child_id: 10 });
  b.t.jar.set('kidsstar-kid', a.t.jar.get('kidsstar-kid'));
  assert.equal((await b.t.get('/today')).body.reason, 'kid_session_required');
});

test('Leerlauf beendet die Kindersitzung auf dem Server', async () => {
  const { t, device } = await pairedTablet([10]);
  await mama.patch(`/devices/${device.id}`, { idle_seconds: 60 });
  await t.post('/session', { child_id: 10 });
  clockMs += 50 * 1000;
  assert.equal((await t.get('/today')).status, 200); // beruehrt die Sitzung
  clockMs += 50 * 1000;
  assert.equal((await t.get('/today')).status, 200);
  clockMs += 61 * 1000;
  assert.equal((await t.get('/today')).body.reason, 'kid_session_required');
  assert.equal((await t.get('/state')).body.data.active, null);
});

test('Bildcode: ohne, falsch, Sperre nach Fehlversuchen, richtig', async () => {
  const { t } = await pairedTablet([10, 11]);
  assert.equal((await mama.patch('/profiles/11', { code: [1, 2] })).body.reason, 'invalid_code');
  assert.equal((await mama.patch('/profiles/11', { code: [1, 2, 3, 9] })).body.reason, 'out_of_range');
  const p = await mama.patch('/profiles/11', { code: [3, 3, 1, 8] });
  assert.equal(p.body.data.has_code, true);
  assert.ok(!JSON.stringify(p.body).includes('code_hash'));
  const st = (await t.get('/state')).body.data;
  assert.equal(st.profiles.find((x) => x.child_id === 11).has_code, true);
  assert.equal((await t.post('/session', { child_id: 11 })).body.reason, 'code_required');
  for (let i = 1; i < MAX_CODE_FAILURES; i += 1) {
    const r = await t.post('/session', { child_id: 11, code: [0, 0, 0, 0] });
    assert.equal(r.body.reason, 'code_wrong');
    assert.equal(r.body.remaining, MAX_CODE_FAILURES - i);
  }
  const locked = await t.post('/session', { child_id: 11, code: [0, 0, 0, 0] });
  assert.equal(locked.status, 429);
  // Auch der richtige Code hilft waehrend der Sperre nicht.
  assert.equal((await t.post('/session', { child_id: 11, code: [3, 3, 1, 8] })).status, 429);
  // Kinder ohne Code sind davon nicht betroffen.
  assert.equal((await t.post('/session', { child_id: 10 })).status, 201);
  clockMs += 5 * 60 * 1000 + 1000;
  assert.equal((await t.post('/session', { child_id: 11, code: [3, 3, 1, 8] })).status, 201);
  assert.equal((await t.get('/today')).body.data.child_id, 11);
  // Code entfernen
  await mama.patch('/profiles/11', { code: null });
  await t.del('/session');
  assert.equal((await t.post('/session', { child_id: 11 })).status, 201);
});

test('Freigabe entziehen beendet die laufende Sitzung des Kindes', async () => {
  const { t, device } = await pairedTablet([10, 11]);
  await t.post('/session', { child_id: 11 });
  await mama.patch(`/devices/${device.id}`, { child_ids: [10] });
  assert.equal((await t.get('/today')).body.reason, 'kid_session_required');
  assert.deepEqual((await t.get('/state')).body.data.profiles.map((p) => p.child_id), [10]);
});

test('Kind ist in Yuvomi kein Kind mehr: Kachel und Sitzung verschwinden', async () => {
  const { t } = await pairedTablet([10, 12]);
  await t.post('/session', { child_id: 12 });
  const saved = members;
  members = members.filter((m) => m.id !== 12);
  try {
    assert.equal((await t.get('/today')).status, 401);
    assert.deepEqual((await t.get('/state')).body.data.profiles.map((p) => p.child_id), [10]);
  } finally {
    members = saved;
  }
});

test('Widerruf: Tablet verliert jeden Zugriff', async () => {
  const { t, device } = await pairedTablet([10]);
  await t.post('/session', { child_id: 10 });
  assert.equal((await mama.del(`/devices/${device.id}`)).body.data.revoked, true);
  assert.equal((await t.get('/today')).body.reason, 'device_unpaired');
  assert.deepEqual((await t.get('/state')).body.data, { paired: false });
  assert.equal((await t.post('/session', { child_id: 10 })).status, 401);
  assert.ok(!(await mama.get('/devices')).body.data.some((d) => d.id === device.id));
});

test('Neu koppeln ersetzt die alte Kopplung', async () => {
  const { t, device } = await pairedTablet([10]);
  const again = await mama.post(`/devices/${device.id}/pairing`, {});
  const t2 = tabletClient();
  assert.equal((await t2.pair(again.body.data.pairing_code)).status, 201);
  assert.equal((await t.get('/state')).body.data.paired, false);
  assert.equal((await t2.get('/state')).body.data.paired, true);
});

test('KidsStar in Yuvomi abgeschaltet: Tablet gesperrt, Kopplung unmoeglich', async () => {
  const { t } = await pairedTablet([10]);
  const d = await mama.post('/devices', { name: 'Neu', child_ids: [10] });
  moduleOn = false;
  try {
    assert.equal((await t.get('/state')).body.reason, 'module_forbidden');
    assert.equal((await t.post('/session', { child_id: 10 })).status, 403);
    assert.equal((await tabletClient().pair(d.body.data.pairing_code)).body.reason, 'module_forbidden');
  } finally {
    moduleOn = true;
  }
  assert.equal((await t.get('/state')).status, 200);
});

test('Ohne API-Token gibt es keinen Tablet-Modus', async () => {
  const t = tabletClient(() => baseNoToken);
  const r = await t.pair('ABCD-EFGH');
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'tablet_not_configured');
  const admin = browser(() => baseNoToken, { 'yuvomi.sid': 'sid-admin' });
  const st = await admin.call('GET', `${PREFIX}/tablet-status`);
  assert.equal(st.body.data.configured, false);
  const ok = await mama.get('/tablet-status');
  assert.deepEqual(ok.body.data, { configured: true, ok: true, reason: null, children: 3 });
});

test('Profilbild: hochladen, austauschen, entfernen; nur Eltern und gekoppelte Tablets', async () => {
  const { t } = await pairedTablet([10]);
  const other = await pairedTablet([11]);
  const up = await mama.put('/profiles/10/image', PNG(1));
  assert.equal(up.status, 200);
  const first = up.body.data.image;
  assert.match(first, /^[0-9a-f]{32}\.png$/);
  assert.equal((await mama.get(`/profile-images/${first}`)).status, 200);
  assert.equal((await t.get(`/profile-images/${first}`)).status, 200);
  assert.equal((await other.t.get(`/profile-images/${first}`)).status, 404);
  const ian = browser(() => base, { 'yuvomi.sid': 'sid-ian' });
  assert.equal((await ian.call('GET', `${PREFIX}/profile-images/${first}`)).status, 404);
  assert.equal((await fetch(`${base}${T}/api/profile-images/${first}`)).status, 401);
  // Austauschen: altes Bild ist weg, auch von der Platte.
  const swap = await mama.put('/profiles/10/image', PNG(2));
  const second = swap.body.data.image;
  assert.notEqual(second, first);
  assert.equal((await mama.get(`/profile-images/${first}`)).status, 404);
  assert.equal(fs.existsSync(path.join(dataDir, 'profile-images', first)), false);
  assert.equal((await t.get('/state')).body.data.profiles[0].image, second);
  // Kein SVG
  const svg = await mama.put('/profiles/10/image', Buffer.from('<svg/>'));
  assert.equal(svg.status, 415);
  // Symbol statt Bild
  await mama.patch('/profiles/10', { symbol: '🦊', color: '#FF8800' });
  const removed = await mama.del('/profiles/10/image');
  assert.equal(removed.body.data.image, null);
  assert.equal(removed.body.data.symbol, '🦊');
  assert.equal(fs.existsSync(path.join(dataDir, 'profile-images', second)), false);
  const tile = (await t.get('/state')).body.data.profiles[0];
  assert.deepEqual([tile.image, tile.symbol, tile.color], [null, '🦊', '#FF8800']);
  assert.equal((await mama.patch('/profiles/10', { color: 'red;x' })).status, 400);
});

test('Tablet-Schreibzugriffe brauchen Origin und CSRF', async () => {
  const { t } = await pairedTablet([10]);
  const cookie = [...t.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const noCsrf = await fetch(`${base}${T}/api/session`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{"child_id":10}' });
  assert.equal(noCsrf.status, 403);
  const evil = await fetch(`${base}${T}/api/pair`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"code":"AAAABBBB"}' });
  assert.equal(evil.status, 403);
});

// Muss der letzte Test sein: danach ist diese Adresse fuer zehn Minuten gesperrt.
test('Kopplungsversuche sind begrenzt', async () => {
  const t = tabletClient();
  let last;
  for (let i = 0; i < 12; i += 1) last = await t.pair('ZZZZ-ZZZZ');
  assert.equal(last.status, 429);
  assert.equal(last.body.reason, 'rate_limited');
});
