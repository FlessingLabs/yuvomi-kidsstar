import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createYuvomiClient } from '../src/yuvomi.js';
import { createImageStore } from '../src/images.js';
import { createApp, PREFIX } from '../src/server.js';

const quiet = { info() {}, error() {} };

// --- Ein nachgebautes Yuvomi: /auth/me, /family/members, /preferences -------
const USERS = {
  'sid-admin': { user: { id: 1, display_name: 'Mama', family_role: 'mom' }, permissions: { admin: true, modules: { 'ext:kidsstar': 'write' } } },
  'sid-dad': { user: { id: 2, display_name: 'Papa', family_role: 'dad' }, permissions: { admin: false, modules: { 'ext:kidsstar': 'write' } } },
  'sid-anna': { user: { id: 10, display_name: 'Anna', family_role: 'child' }, permissions: { admin: false, modules: { 'ext:kidsstar': 'write' } } },
  'sid-ben': { user: { id: 11, display_name: 'Ben', family_role: 'child' }, permissions: { admin: false, modules: { 'ext:kidsstar': 'read' } } },
  // KidsStar in Yuvomi abgeschaltet: der Schluessel fehlt im Rechtekatalog.
  'sid-off': { user: { id: 12, display_name: 'Clara', family_role: 'child' }, permissions: { admin: false, modules: {} } },
  'sid-none': { user: { id: 13, display_name: 'Dora', family_role: 'child' }, permissions: { admin: false, modules: { 'ext:kidsstar': 'none' } } },
};
const MEMBERS = [
  { id: 1, display_name: 'Mama', family_role: 'mom', avatar_color: '#FF0000' },
  { id: 2, display_name: 'Papa', family_role: 'dad', avatar_color: 'red;evil' },
  { id: 10, display_name: 'Anna', family_role: 'child', avatar_color: '#00FF00' },
  { id: 11, display_name: 'Ben', family_role: 'child' },
];
let yuvomiDown = false;
let meCalls = 0;

const fakeYuvomi = http.createServer((req, res) => {
  if (yuvomiDown) { res.writeHead(503); return res.end(); }
  const sid = /yuvomi\.sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const me = USERS[sid];
  if (!me) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/api/v1/auth/me') { meCalls += 1; return res.end(JSON.stringify(me)); }
  if (req.url === '/api/v1/family/members') return res.end(JSON.stringify({ data: MEMBERS }));
  if (req.url === '/api/v1/preferences') return res.end(JSON.stringify({ data: { timezone_effective: 'Europe/Berlin' } }));
  res.end('{}');
});

let server;
let base;
let tmp;

before(async () => {
  await new Promise((r) => fakeYuvomi.listen(0, '127.0.0.1', r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kidsstar-test-'));
  const db = openDatabase(':memory:', { log: quiet });
  const service = createService(db);
  const yuvomi = createYuvomiClient({ yuvomiUrl: `http://127.0.0.1:${fakeYuvomi.address().port}`, cacheMs: 0, householdCacheMs: 0 });
  const images = createImageStore(path.join(tmp, 'images'));
  server = http.createServer(createApp({ db, service, yuvomi, images, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fakeYuvomi.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Kleiner Client mit Cookie und CSRF-Paar ----------------------------------
function client(sid) {
  let csrf = null;
  async function call(method, p, body, { raw, headers = {}, noCsrf } = {}) {
    if (method !== 'GET' && !csrf && !noCsrf) {
      const r = await fetch(`${base}${PREFIX}/csrf`, { headers: { cookie: `yuvomi.sid=${sid}` } });
      csrf = (await r.json()).data.token;
    }
    const h = { cookie: `yuvomi.sid=${sid}${csrf ? `; kidsstar-csrf=${csrf}` : ''}`, origin: base, ...headers };
    if (method !== 'GET' && csrf && !noCsrf) h['x-kidsstar-csrf'] = csrf;
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    const res = await fetch(`${base}${PREFIX}${p}`, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
  };
}
const admin = client('sid-admin');
const dad = client('sid-dad');
const anna = client('sid-anna');
const ben = client('sid-ben');
let n = 0;
const rid = () => `http-${String(++n).padStart(8, '0')}`;

test('health ohne Anmeldung', async () => {
  const r = await fetch(`${base}${PREFIX}/health`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.data.ok, true);
  assert.equal(body.data.schema, 2);
});

test('ohne Sitzung 401, ausserhalb des Pfads 404', async () => {
  assert.equal((await fetch(`${base}${PREFIX}/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/tasks`)).status, 404);
});

test('abgeschaltetes Modul (kein ext:kidsstar) und Recht "none" sperren den Dienst', async () => {
  const off = await client('sid-off').get('/me');
  assert.equal(off.status, 403);
  assert.equal(off.body.reason, 'module_forbidden');
  assert.equal((await client('sid-none').get('/today')).status, 403);
  assert.equal((await client('sid-off').get('/csrf')).status, 403);
});

test('/me nennt Rolle, Tag und Zeitzone aus Yuvomi', async () => {
  const me = await admin.get('/me');
  assert.equal(me.body.data.role, 'parent');
  assert.equal(me.body.data.timezone, 'Europe/Berlin');
  assert.match(me.body.data.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await dad.get('/me')).body.data.role, 'parent');
  assert.equal((await anna.get('/me')).body.data.role, 'child');
  const kids = await admin.get('/children');
  assert.deepEqual(kids.body.data.map((c) => c.id), [10, 11]);
  assert.equal(kids.body.data[0].avatar_color, '#00FF00');
  assert.equal(kids.body.data[1].avatar_color, null);
  assert.equal((await anna.get('/children')).status, 403);
});

test('schreiben ohne CSRF-Paar oder mit fremdem Origin wird abgewiesen', async () => {
  const noToken = await admin.post('/actions', { title: 'x', stars: 1, child_ids: [10] }, { noCsrf: true });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.reason, 'csrf_invalid');
  const evil = await admin.post('/actions', { title: 'x', stars: 1, child_ids: [10] }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.reason, 'origin_mismatch');
});

test('Benutzer-Id aus dem Koerper wird ignoriert', async () => {
  const r = await admin.post('/actions', { title: 'Tisch decken', stars: 3, child_ids: [10, 11], requires_approval: false });
  assert.equal(r.status, 201);
  // Anna gibt sich als Ben aus - gebucht wird bei Anna.
  const c = await anna.post('/completions', { action_id: r.body.data.id, request_id: rid(), child_id: 11, user_id: 11 });
  assert.equal(c.status, 201);
  assert.equal(c.body.data.completion.child_id, 10);
  assert.equal((await admin.get('/ledger?child=11')).body.data.entries.length, 0);
});

test('Leserecht: Ben kann lesen, aber nicht melden', async () => {
  assert.equal((await ben.get('/today')).status, 200);
  const r = await ben.post('/wishes', { title: 'x', request_id: rid() });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'read_only');
});

test('Kind liest keine fremden Daten', async () => {
  assert.equal((await anna.get('/ledger?child=11')).status, 404);
  assert.equal((await anna.get('/overview')).status, 403);
  assert.equal((await anna.get('/actions')).status, 403);
});

test('parallele Erledigungen von mehreren Geraeten: genau so viele wie erlaubt', async () => {
  const a = await admin.post('/actions', { title: 'Müll', stars: 5, per_day: 2, child_ids: [10], requires_approval: false });
  const before = (await anna.get('/ledger')).body.data.balance.available;
  const results = await Promise.all(Array.from({ length: 12 }, () => anna.post('/completions', { action_id: a.body.data.id, request_id: rid() })));
  const ok = results.filter((r) => r.status === 201).length;
  const refused = results.filter((r) => r.status === 409 && r.body.reason === 'limit_reached').length;
  assert.equal(ok, 2);
  assert.equal(refused, 10);
  assert.equal((await anna.get('/ledger')).body.data.balance.available, before + 10);
});

test('parallele Einloesungen ueberziehen nie, gleiche Anfrage nur einmal', async () => {
  await admin.post('/ledger/bonus', { child_id: 10, stars: 25, reason: 'Start', request_id: rid() });
  const bal = (await anna.get('/ledger')).body.data.balance.available;
  const rewards = [];
  for (let i = 0; i < 5; i += 1) {
    rewards.push((await admin.post('/rewards', { title: `R${i}`, stars: 10 })).body.data.id);
  }
  const results = await Promise.all(rewards.map((id) => anna.post('/redemptions', { reward_id: id, request_id: rid() })));
  const ok = results.filter((r) => r.status === 201).length;
  assert.equal(ok, Math.floor(bal / 10));
  const after = (await anna.get('/ledger')).body.data.balance;
  assert.ok(after.available >= 0);
  assert.equal(after.available + after.reserved, bal);
  // Dieselbe Anfrage-Id fuenfmal parallel: eine Anfrage.
  await admin.post('/ledger/bonus', { child_id: 10, stars: 10, reason: 'Noch', request_id: rid() });
  const r = (await admin.post('/rewards', { title: 'Einmal', stars: 10 })).body.data.id;
  const same = rid();
  const rep = await Promise.all(Array.from({ length: 5 }, () => anna.post('/redemptions', { reward_id: r, request_id: same })));
  assert.ok(rep.every((x) => x.status === 201));
  assert.equal(new Set(rep.map((x) => x.body.data.redemption.id)).size, 1);
});

test('Bilder: nur echte PNG/JPEG/WebP, Sicht nach Freigabe', async () => {
  const reward = (await admin.post('/rewards', { title: 'Nur Anna', stars: 5, all_children: false, child_ids: [10] })).body.data;
  const svg = await admin.put(`/rewards/${reward.id}/image`, undefined, { raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), headers: { 'content-type': 'image/png' } });
  assert.equal(svg.status, 415);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const up = await admin.put(`/rewards/${reward.id}/image`, undefined, { raw: png, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 200);
  const name = up.body.data.image;
  assert.match(name, /^[0-9a-f]{32}\.png$/);
  const view = await anna.get(`/images/${name}`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('content-type'), 'image/png');
  assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await ben.get(`/images/${name}`)).status, 404);
  assert.equal((await anna.get('/images/..%2F..%2Fkidsstar.db')).status, 404);
  const childUpload = await anna.put(`/rewards/${reward.id}/image`, undefined, { raw: png, headers: { 'content-type': 'image/png' } });
  assert.equal(childUpload.status, 403);
  const del = await admin.del(`/rewards/${reward.id}/image`);
  assert.equal(del.body.data.image, null);
  assert.equal((await admin.get(`/images/${name}`)).status, 404);
});

test('zu grosser Koerper, falscher Content-Type, kaputtes JSON', async () => {
  const big = await admin.post('/wishes', { title: 'x'.repeat(40000) });
  assert.equal(big.status, 413);
  const bad = await admin.post('/ledger/bonus', undefined, { raw: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const form = await admin.post('/ledger/bonus', undefined, { raw: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
});

test('Yuvomi nicht erreichbar: 502 mit Grund, nie Zugriff', async () => {
  yuvomiDown = true;
  try {
    const r = await anna.get('/today');
    assert.equal(r.status, 502);
    assert.equal(r.body.reason, 'yuvomi_unavailable');
  } finally {
    yuvomiDown = false;
  }
});

test('/auth/me wird je Sitzung zwischengespeichert', async () => {
  const yuvomi = createYuvomiClient({ yuvomiUrl: `http://127.0.0.1:${fakeYuvomi.address().port}`, cacheMs: 60000 });
  const req = { headers: { cookie: 'yuvomi.sid=sid-anna' } };
  const start = meCalls;
  await yuvomi.identify(req);
  await yuvomi.identify(req);
  await yuvomi.identify(req);
  assert.equal(meCalls - start, 1);
  assert.equal(await yuvomi.identify({ headers: { cookie: 'yuvomi.sid=unknown' } }), null);
});
