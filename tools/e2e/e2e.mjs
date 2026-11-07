// Abnahmelauf gegen ein ECHTES Yuvomi mit dem KidsStar-Dienst davor.
//
//   node tools/e2e/e2e.mjs <port> setup   <tokenFile>   Admin, Kinder, API-Token anlegen (nur Yuvomi noetig)
//   node tools/e2e/e2e.mjs <port> flow    <stateFile>   ganzer Ablauf ueber den Dienst
//   node tools/e2e/e2e.mjs <port> disable <stateFile>   KidsStar in Yuvomi aus -> Dienst und Tablet gesperrt, wieder an
//   node tools/e2e/e2e.mjs <port> persist <stateFile>   nach Neustart/Wiederherstellung: Staende wie gespeichert
//
// <port> ist der Port, auf dem der Browser Yuvomi erreicht (bei "setup" Yuvomi
// selbst, sonst der KidsStar-Dienst, der alles andere an Yuvomi weiterreicht).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const [, , port, phase, file] = process.argv;
const ORIGIN = `http://127.0.0.1:${port}`;
const KS = '/api/extensions/kidsstar';
const PW = 'kidsstar-e2e-password';
const log = (...a) => console.log(`[${phase}]`, ...a);

function browser() {
  const jar = new Map();
  let ksCsrf = '';
  let tabCsrf = '';
  async function raw(url, init = {}) {
    const headers = { ...(init.headers || {}), origin: ORIGIN };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(ORIGIN + url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      if (attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()))) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  async function json(method, url, body, extra = {}) {
    const headers = { accept: 'application/json', ...extra };
    if (body !== undefined && !(body instanceof Uint8Array)) headers['content-type'] = 'application/json';
    const res = await raw(url, { method, headers, body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, body: data?.data };
  }
  // Yuvomi /api/v1 wie /api.js
  const yv = (method, p, body) => json(method, `/api/v1${p}`, body, method === 'GET' ? {} : { 'x-csrf-token': jar.get('csrf-token') ?? '' });
  // KidsStar-Dienst wie module/lib/api.js
  async function ks(method, p, body, extra = {}) {
    if (method !== 'GET' && !ksCsrf) ksCsrf = (await json('GET', `${KS}/csrf`)).body?.token ?? '';
    return json(method, KS + p, body, method === 'GET' ? extra : { 'x-kidsstar-csrf': ksCsrf, ...extra });
  }
  // Tablet-Seite wie sidecar/public/tablet/app.js
  async function tab(method, p, body) {
    if (method !== 'GET' && p !== '/pair' && !tabCsrf) tabCsrf = (await json('GET', `${KS}/tablet/api/csrf`)).body?.token ?? '';
    return json(method, `${KS}/tablet/api${p}`, body, method === 'GET' || p === '/pair' ? {} : { 'x-kidsstar-csrf': tabCsrf });
  }
  async function login(username) {
    const r = await raw('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
    assert.equal(r.status, 200, `login ${username}: ${await r.text()}`);
    await yv('GET', '/auth/me');
  }
  return { jar, raw, yv, ks, tab, login };
}

let n = 0;
const rid = () => `e2e-${Date.now().toString(36)}-${String(++n).padStart(4, '0')}`;
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

if (phase === 'setup') {
  const admin = browser();
  const s = await admin.raw('/api/v1/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mama', display_name: 'Mama', password: PW, language: 'de' }),
  });
  log('setup', s.status);
  await admin.login('mama');
  for (const [username, display_name, family_role] of [['ian', 'Ian', 'child'], ['mia', 'Mia', 'child'], ['papa', 'Papa', 'dad'], ['oma', 'Oma', 'grandparent']]) {
    const r = await admin.yv('POST', '/auth/users', { username, display_name, password: PW, family_role });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  }
  // Admin-Familienrolle setzen (Ersteinrichtung legt "other" an).
  const mods = await admin.yv('GET', '/modules?admin=1');
  const mine = mods.data.data.find((m) => m.id === 'kidsstar');
  assert.ok(mine, 'module listed');
  assert.equal(mine.status, 'enabled', JSON.stringify(mine));
  assert.ok(!mine.error, mine.error);
  log('module', mine.id, mine.version, mine.status);
  const tok = await admin.yv('POST', '/auth/api-tokens', { name: 'KidsStar-Dienst', scopes: ['ext:kidsstar:read', 'family:read'] });
  assert.equal(tok.status, 201, JSON.stringify(tok.data));
  fs.writeFileSync(file, tok.data.token);
  log('api token created with scopes', tok.data.data.scopes);
  process.exit(0);
}

const mama = browser();
const ian = browser();
const mia = browser();
const papa = browser();
const oma = browser();
await mama.login('mama');
await ian.login('ian');
await mia.login('mia');
await papa.login('papa');
await oma.login('oma');

if (phase === 'flow') {
  // --- Yuvomi kennt das Modul: Navigation, Rechte, Widget, Einstellungen ---
  const meY = (await mama.yv('GET', '/auth/me')).data;
  assert.equal(meY.permissions.modules['ext:kidsstar'], 'write');
  const modules = (await ian.yv('GET', '/modules')).data.data;
  const ksMod = modules.find((m) => m.id === 'kidsstar');
  assert.ok(ksMod.menu.show);
  log('navigation entry:', ksMod.menu.label, ksMod.menu.icon, '| widget:', ksMod.capabilities?.widgets?.map((w) => w.id).join(','));
  const asset = await ian.raw('/api/v1/modules/assets/kidsstar/index.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const settingsAsset = await mama.raw('/api/v1/modules/assets/kidsstar/settings.js');
  assert.equal(settingsAsset.status, 200);
  log('module assets served (index.js, settings.js)');

  // --- Rollen ---
  assert.equal((await mama.ks('GET', '/me')).body.role, 'parent');
  assert.equal((await papa.ks('GET', '/me')).body.role, 'parent');
  assert.equal((await ian.ks('GET', '/me')).body.role, 'child');
  assert.equal((await oma.ks('GET', '/me')).body.role, 'other');
  const kids = (await mama.ks('GET', '/children')).body;
  const IAN = kids.find((k) => k.name === 'Ian').id;
  const MIA = kids.find((k) => k.name === 'Mia').id;
  log('children', kids.map((k) => `${k.name}#${k.id}`).join(', '));
  assert.equal(kids.length, 2);

  // --- Aktionen ---
  const teeth = (await mama.ks('POST', '/actions', { title: 'Zähne putzen', icon: '🪥', stars: 2, per_day: 2, requires_approval: false, child_ids: [IAN, MIA] })).body;
  const room = (await mama.ks('POST', '/actions', { title: 'Zimmer aufräumen', icon: '🧸', stars: 5, requires_approval: true, child_ids: [IAN] })).body;
  assert.equal((await ian.ks('POST', '/actions', { title: 'x', stars: 99, child_ids: [IAN] })).data.reason, 'parent_required');

  // Ohne Bestaetigung: sofort gutgeschrieben, Doppelklick mit derselben Id zaehlt einmal
  const same = rid();
  const a1 = await ian.ks('POST', '/completions', { action_id: teeth.id, request_id: same });
  const a2 = await ian.ks('POST', '/completions', { action_id: teeth.id, request_id: same });
  assert.equal(a1.body.completion.status, 'approved');
  assert.equal(a2.body.replayed, true);
  // Parallel von "mehreren Geraeten": nur noch ein Platz frei (per_day 2)
  const par = await Promise.all(Array.from({ length: 8 }, () => ian.ks('POST', '/completions', { action_id: teeth.id, request_id: rid() })));
  assert.equal(par.filter((r) => r.status === 201).length, 1, JSON.stringify(par.map((r) => r.status)));
  assert.equal((await ian.ks('GET', '/ledger')).body.balance.available, 4);
  log('direct credit + duplicate/parallel protection ok (4 stars)');

  // Mit Bestaetigung: wartet, Ablehnung ohne Sterne, Freigabe mit Sternen
  const r1 = (await ian.ks('POST', '/completions', { action_id: room.id, request_id: rid() })).body.completion;
  assert.equal(r1.status, 'pending');
  assert.equal((await ian.ks('GET', '/today')).body.pending.length, 1);
  assert.equal((await ian.ks('POST', `/completions/${r1.id}/approve`, {})).data.reason, 'parent_required');
  await mama.ks('POST', `/completions/${r1.id}/reject`, { feedback: 'Unter dem Bett liegt noch was' });
  assert.equal((await ian.ks('GET', '/ledger')).body.balance.available, 4);
  const r2 = (await ian.ks('POST', '/completions', { action_id: room.id, request_id: rid() })).body.completion;
  await papa.ks('POST', `/completions/${r2.id}/approve`, {});
  assert.equal((await ian.ks('GET', '/ledger')).body.balance.available, 9);
  log('approval flow ok (reject = 0, approve = +5)');

  // Fremde Kinderdaten
  assert.equal((await mia.ks('GET', `/ledger?child=${IAN}`)).status, 404);
  assert.equal((await mia.ks('POST', `/completions/${r2.id}/cancel`, {})).status, 404);
  assert.equal((await oma.ks('GET', `/ledger?child=${IAN}`)).status, 403);

  // --- Wunsch -> Shop -> Sparziel -> Einloesen ---
  const wish = (await ian.ks('POST', '/wishes', { title: 'Lego Feuerwehr', url: 'https://example.com/lego', request_id: rid() })).body;
  const appr = (await mama.ks('POST', `/wishes/${wish.id}/approve`, { stars: 40, feedback: 'Gute Idee!' })).body;
  const lego = appr.reward;
  assert.deepEqual(lego.child_ids, [IAN]);
  assert.equal((await mia.ks('GET', '/rewards')).body.some((r) => r.id === lego.id), false);
  await mama.ks('POST', '/ledger/bonus', { child_id: IAN, stars: 15, reason: 'Oma geholfen', request_id: rid() });
  const goal = (await ian.ks('PUT', '/goal', { reward_id: lego.id })).body;
  log(`goal: Du hast ${goal.have} von ${goal.stars} Sternen. Es fehlen noch ${goal.missing}.`);
  assert.equal(goal.have, 24);
  assert.equal(goal.missing, 16);
  const tooPoor = await ian.ks('POST', '/redemptions', { reward_id: lego.id, request_id: rid(), expected_stars: 40 });
  assert.equal(tooPoor.data.reason, 'insufficient_stars');

  const book = (await mama.ks('POST', '/rewards', { title: 'Buch', icon: '📚', stars: 10 })).body;
  const kino = (await mama.ks('POST', '/rewards', { title: 'Kino', icon: '🎬', stars: 20 })).body;
  const up = await mama.ks('PUT', `/rewards/${book.id}/image`, PNG, { 'content-type': 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  // Parallel: Buch (10) + Kino (20) bei 24 Sternen -> nur eins geht durch
  const both = await Promise.all([
    ian.ks('POST', '/redemptions', { reward_id: book.id, request_id: rid(), expected_stars: 10 }),
    ian.ks('POST', '/redemptions', { reward_id: kino.id, request_id: rid(), expected_stars: 20 }),
  ]);
  assert.equal(both.filter((r) => r.status === 201).length, 1);
  const bal = (await ian.ks('GET', '/ledger')).body.balance;
  assert.ok(bal.available >= 0);
  assert.equal(bal.available + bal.reserved, 24);
  log('parallel redemptions ok:', JSON.stringify(bal));
  const red = both.find((r) => r.status === 201).body.redemption;
  // Ablehnen gibt die Reservierung frei
  await mama.ks('POST', `/redemptions/${red.id}/reject`, { feedback: 'Heute nicht' });
  assert.deepEqual((await ian.ks('GET', '/ledger')).body.balance, { available: 24, reserved: 0, earned: 24 });
  // Preisaenderung nach der Anfrage aendert die Anfrage nicht
  const red2 = (await ian.ks('POST', '/redemptions', { reward_id: book.id, request_id: rid(), expected_stars: 10 })).body.redemption;
  await mama.ks('PATCH', `/rewards/${book.id}`, { stars: 12, title: 'Dickes Buch' });
  const stale = await ian.ks('POST', '/redemptions', { reward_id: kino.id, request_id: rid(), expected_stars: 15 });
  assert.equal(stale.data.reason, 'price_changed');
  await mama.ks('POST', `/redemptions/${red2.id}/approve`, {});
  await mama.ks('POST', `/redemptions/${red2.id}/fulfill`, {});
  const reds = (await ian.ks('GET', '/redemptions')).body;
  const done = reds.find((r) => r.id === red2.id);
  assert.equal(done.status, 'fulfilled');
  assert.equal(done.stars, 10);
  assert.equal(done.title, 'Buch');
  assert.equal((await ian.ks('GET', '/ledger')).body.balance.available, 14);
  const img = await ian.raw(`${KS}/images/${done.image}`);
  assert.equal(img.status, 200);
  assert.equal((await oma.raw(`${KS}/images/${done.image}`)).status, 404);
  log('redemption snapshot + fulfil ok, balance 14');

  // Korrektur: Bonus gegenbuchen, sichtbar
  const entries = (await mama.ks('GET', `/ledger?child=${IAN}`)).body.entries;
  const bonus = entries.find((e) => e.kind === 'bonus');
  await mama.ks('POST', '/ledger/correction', { child_id: IAN, reverses_id: bonus.id, reason: 'Doppelt vergeben', request_id: rid() }).then((r) => {
    // 15 Bonus bei 14 verfuegbar: wuerde negativ -> abgelehnt
    assert.equal(r.data.reason, 'insufficient_stars');
  });
  await mama.ks('POST', '/ledger/correction', { child_id: IAN, stars: -4, reason: 'Fehlbuchung', request_id: rid() });
  assert.equal((await ian.ks('GET', '/ledger')).body.balance.available, 10);

  // Widget-Daten
  const sum = (await ian.ks('GET', '/summary')).body;
  assert.equal(sum.role, 'child');
  const psum = (await mama.ks('GET', '/summary')).body;
  assert.equal(psum.children.length, 2);
  log('summary ok');

  // --- Flurtablet ---
  const dev = (await mama.ks('POST', '/devices', { name: 'Flur', child_ids: [IAN, MIA], idle_seconds: 60 })).body;
  assert.equal((await mama.ks('PUT', `/profiles/${IAN}/image`, PNG, { 'content-type': 'image/png' })).status, 200);
  await mama.ks('PATCH', `/profiles/${MIA}`, { symbol: '🦄', color: '#EC4899', code: [0, 1, 2, 3] });
  const tablet = browser();
  const page = await tablet.raw(`${KS}/tablet/`);
  assert.equal(page.status, 200);
  assert.equal((await tablet.tab('POST', '/pair', { code: dev.pairing_code })).status, 201);
  assert.ok(!tablet.jar.has('yuvomi.sid'), 'no Yuvomi session on the tablet');
  const st = (await tablet.tab('GET', '/state')).body;
  assert.deepEqual(st.profiles.map((p) => p.name), ['Ian', 'Mia']);
  assert.equal((await tablet.raw(`${KS}/tablet/api/profile-images/${st.profiles[0].image}`)).status, 200);
  await tablet.tab('POST', '/session', { child_id: IAN });
  assert.equal((await tablet.tab('GET', '/today')).body.child_id, IAN);
  // Tablet-Sitzung ist keine Yuvomi-Sitzung
  assert.equal((await tablet.yv('GET', '/auth/me')).status, 401);
  await tablet.tab('DELETE', '/session');
  assert.equal((await tablet.tab('POST', '/session', { child_id: MIA })).data.reason, 'code_required');
  assert.equal((await tablet.tab('POST', '/session', { child_id: MIA, code: [3, 2, 1, 0] })).data.reason, 'code_wrong');
  assert.equal((await tablet.tab('POST', '/session', { child_id: MIA, code: [0, 1, 2, 3] })).status, 201);
  const miaLedger = (await tablet.tab('GET', '/ledger')).body;
  assert.equal(miaLedger.child_id, MIA);
  assert.ok(!miaLedger.entries.some((e) => e.reason === 'Oma geholfen'));
  log('tablet pairing, picture tiles, code and switch ok');

  fs.writeFileSync(file, JSON.stringify({ IAN, MIA, device: dev.device.id, tabletJar: [...tablet.jar], ian: 10 }));
  process.exit(0);
}

const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

if (phase === 'disable') {
  const tablet = browser();
  for (const [k, v] of saved.tabletJar) tablet.jar.set(k, v);
  const off = await mama.yv('PATCH', '/modules/kidsstar', { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  await new Promise((r) => setTimeout(r, 6000)); // Cache des Dienstes (5 s)
  const r = await ian.ks('GET', '/today');
  assert.equal(r.status, 403);
  assert.equal(r.data.reason, 'module_forbidden');
  assert.equal((await mama.ks('POST', '/ledger/bonus', { child_id: saved.IAN, stars: 1, reason: 'x', request_id: rid() })).status, 403);
  assert.equal((await tablet.tab('GET', '/state')).data.reason, 'module_forbidden');
  assert.equal((await ian.raw('/api/v1/modules/assets/kidsstar/index.js')).status, 404);
  log('disabled: service 403 for sessions and tablet, module assets 404');
  const on = await mama.yv('PATCH', '/modules/kidsstar', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  await new Promise((r2) => setTimeout(r2, 6000));
  assert.equal((await ian.ks('GET', '/today')).status, 200);
  // Widerruf
  await mama.ks('DELETE', `/devices/${saved.device}`);
  assert.equal((await tablet.tab('GET', '/today')).data.reason, 'device_unpaired');
  log('re-enabled ok; revoked tablet has no access');
  process.exit(0);
}

if (phase === 'persist') {
  const expect = Number(process.argv[5] ?? 10);
  const bal = (await ian.ks('GET', '/ledger')).body.balance;
  log('Ian balance after restart:', JSON.stringify(bal));
  assert.equal(bal.available, expect);
  assert.equal((await mama.ks('GET', '/actions')).body.length, 2);
  process.exit(0);
}

if (phase === 'spend') {
  // Fuer den Wiederherstellungstest: nach der Sicherung etwas aendern.
  await mama.ks('POST', '/ledger/bonus', { child_id: saved.IAN, stars: 7, reason: 'nach der Sicherung', request_id: rid() });
  log('balance now', (await ian.ks('GET', '/ledger')).body.balance.available);
  process.exit(0);
}
