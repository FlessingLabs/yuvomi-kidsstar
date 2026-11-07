import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { householdDay } from '../src/time.js';

const quiet = { info() {} };
const PARENT = { userId: 1, name: 'Mama', role: 'parent', access: 'write', admin: true };
const ANNA = { userId: 10, name: 'Anna', role: 'child', access: 'write' };
const BEN = { userId: 11, name: 'Ben', role: 'child', access: 'write' };
const CHILDREN = [{ id: 10, name: 'Anna', avatar_color: null }, { id: 11, name: 'Ben', avatar_color: null }];

// Montag, 2. November 2026
const MONDAY = { day: '2026-11-02', weekday: 1, children: CHILDREN };
const TUESDAY = { day: '2026-11-03', weekday: 2, children: CHILDREN };
const SATURDAY = { day: '2026-11-07', weekday: 6, children: CHILDREN };

let n = 0;
const rid = () => `req-${String(++n).padStart(8, '0')}`;

function setup() {
  const db = openDatabase(':memory:', { log: quiet });
  const s = createService(db);
  return { db, s };
}

function action(s, over = {}) {
  return s.createAction(PARENT, MONDAY, {
    title: 'Zähne putzen', icon: '🪥', stars: 2, repeats: true, weekdays: 127, per_day: 1,
    requires_approval: false, child_ids: [10], ...over,
  });
}

function earn(s, stars, child = 10) {
  return s.bonus(PARENT, MONDAY, { child_id: child, stars, reason: 'Start', request_id: rid() });
}

test('Aktion ohne Bestaetigung schreibt sofort gut', () => {
  const { s } = setup();
  const a = action(s);
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.equal(r.completion.status, 'approved');
  assert.deepEqual(s.balance(10), { available: 2, reserved: 0, earned: 2 });
});

test('Aktion mit Bestaetigung: erst wartend, nach Freigabe gutgeschrieben', () => {
  const { s } = setup();
  const a = action(s, { requires_approval: true });
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.equal(r.completion.status, 'pending');
  assert.equal(s.balance(10).available, 0);
  assert.equal(s.today(ANNA, MONDAY).pending.length, 1);
  const d = s.decideCompletion(PARENT, MONDAY, r.completion.id, 'approve');
  assert.equal(d.completion.status, 'approved');
  assert.equal(s.balance(10).available, 2);
  // Zweite Freigabe derselben Meldung bucht nicht noch einmal.
  const again = s.decideCompletion(PARENT, MONDAY, r.completion.id, 'approve');
  assert.equal(again.replayed, true);
  assert.equal(s.balance(10).available, 2);
});

test('Ablehnung schreibt nichts gut und gibt den Platz wieder frei', () => {
  const { s } = setup();
  const a = action(s, { requires_approval: true });
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  const d = s.decideCompletion(PARENT, MONDAY, r.completion.id, 'reject', { feedback: 'Bitte noch mal' });
  assert.equal(d.completion.status, 'rejected');
  assert.equal(d.completion.feedback, 'Bitte noch mal');
  assert.equal(s.balance(10).available, 0);
  assert.throws(() => s.decideCompletion(PARENT, MONDAY, r.completion.id, 'approve'), { reason: 'already_decided' });
  // Das Kind kann es erneut melden.
  const r2 = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.equal(r2.completion.status, 'pending');
});

test('Doppelte Anfrage (gleiche request_id) ist eine Erledigung', () => {
  const { s, db } = setup();
  const a = action(s);
  const id = rid();
  const r1 = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: id });
  const r2 = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: id });
  assert.equal(r2.replayed, true);
  assert.equal(r1.completion.id, r2.completion.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
  assert.equal(s.balance(10).available, 2);
});

test('Mehrfachklick mit verschiedenen Ids: Tagesgrenze haelt', () => {
  const { s } = setup();
  const a = action(s, { per_day: 2 });
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.throws(() => s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() }), { reason: 'limit_reached' });
  assert.equal(s.balance(10).available, 4);
});

test('Paralleles Geraet: der eindeutige Platz weist die zweite Meldung ab', () => {
  // Zwei Dienste auf derselben Datei sind nicht vorgesehen; hier wird das
  // Netz darunter geprueft - ein zweiter Eintrag in denselben Platz.
  const { s, db } = setup();
  const a = action(s, { requires_approval: true });
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.throws(() => db.prepare(`
    INSERT INTO completions (action_id, child_id, period, day, slot, title, stars, status, request_id, created_by, created_at)
    VALUES (?, 10, ?, ?, 1, 'x', 2, 'pending', 'other-device-1', 10, 'now')
  `).run(a.id, MONDAY.day, MONDAY.day), /UNIQUE/);
  assert.equal(r.completion.status, 'pending');
});

test('Wiederkehrende Aktion: neuer Tag, neue Moeglichkeit; Wochentage zaehlen', () => {
  const { s } = setup();
  const a = action(s, { weekdays: 0b0011111 }); // Mo-Fr
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.throws(() => s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() }), { reason: 'limit_reached' });
  assert.equal(s.today(ANNA, MONDAY).actions[0].remaining, 0);
  assert.equal(s.today(ANNA, TUESDAY).actions[0].remaining, 1);
  s.reportCompletion(ANNA, TUESDAY, { action_id: a.id, request_id: rid() });
  assert.equal(s.today(ANNA, SATURDAY).actions.length, 0);
  assert.throws(() => s.reportCompletion(ANNA, SATURDAY, { action_id: a.id, request_id: rid() }), { reason: 'not_due_today' });
  assert.equal(s.balance(10).available, 4);
});

test('Tagesgrenze folgt der Haushaltszeitzone', () => {
  // 23:30 in Berlin am 2.11. ist in UTC schon 22:30 - und 00:30 Berlin am 3.11.
  // ist in UTC noch der 2.11.
  const late = new Date('2026-11-02T22:30:00Z');
  assert.deepEqual(householdDay(late, 'Europe/Berlin'), { day: '2026-11-02', weekday: 1 });
  const afterMidnight = new Date('2026-11-02T23:30:00Z');
  assert.deepEqual(householdDay(afterMidnight, 'Europe/Berlin'), { day: '2026-11-03', weekday: 2 });
  assert.deepEqual(householdDay(afterMidnight, 'UTC'), { day: '2026-11-02', weekday: 1 });
  assert.deepEqual(householdDay(new Date('2026-11-02T10:00:00Z'), 'Pacific/Kiritimati'), { day: '2026-11-03', weekday: 2 });
});

test('Einmalige Aktion zaehlt einmal insgesamt', () => {
  const { s } = setup();
  const a = action(s, { repeats: false, title: 'Fahrrad putzen', stars: 5 });
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.throws(() => s.reportCompletion(ANNA, TUESDAY, { action_id: a.id, request_id: rid() }), { reason: 'limit_reached' });
  assert.equal(s.today(ANNA, TUESDAY).actions.length, 0);
});

test('Pausierte oder fremde Aktion kann nicht gemeldet werden', () => {
  const { s } = setup();
  const a = action(s);
  assert.throws(() => s.reportCompletion(BEN, MONDAY, { action_id: a.id, request_id: rid() }), { reason: 'action_not_found' });
  s.updateAction(PARENT, MONDAY, a.id, { status: 'paused' });
  assert.throws(() => s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() }), { reason: 'action_inactive' });
  assert.equal(s.today(ANNA, MONDAY).actions.length, 0);
});

test('Wertaenderung einer Aktion aendert keine gemeldete Erledigung', () => {
  const { s } = setup();
  const a = action(s, { requires_approval: true, stars: 2 });
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  s.updateAction(PARENT, MONDAY, a.id, { stars: 10, title: 'Neu' });
  s.decideCompletion(PARENT, MONDAY, r.completion.id, 'approve');
  assert.equal(s.balance(10).available, 2);
  assert.equal(s.ledgerList(PARENT, MONDAY, { child: 10 }).entries[0].reason, 'Zähne putzen');
});

test('Kinder duerfen keine Sterne festlegen, nichts freigeben, keine Aktionen anlegen', () => {
  const { s } = setup();
  const a = action(s, { requires_approval: true });
  const r = s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  assert.throws(() => s.decideCompletion(ANNA, MONDAY, r.completion.id, 'approve'), { reason: 'parent_required' });
  assert.throws(() => s.bonus(ANNA, MONDAY, { child_id: 10, stars: 100, reason: 'x', request_id: rid() }), { reason: 'parent_required' });
  assert.throws(() => s.createAction(ANNA, MONDAY, { title: 'x', stars: 99, child_ids: [10] }), { reason: 'parent_required' });
  assert.throws(() => s.createReward(ANNA, MONDAY, { title: 'x', stars: 1 }), { reason: 'parent_required' });
});

test('Kinder sehen nur eigene Daten', () => {
  const { s } = setup();
  earn(s, 5, 11);
  assert.throws(() => s.ledgerList(ANNA, MONDAY, { child: 11 }), { reason: 'child_not_found' });
  assert.throws(() => s.today(ANNA, MONDAY, { child: 11 }), { reason: 'child_not_found' });
  assert.equal(s.ledgerList(ANNA, MONDAY, {}).entries.length, 0);
  assert.equal(s.listRedemptions(ANNA, MONDAY).length, 0);
  const w = s.proposeWish(BEN, { title: 'Lego', request_id: rid() });
  assert.equal(s.listWishes(ANNA, MONDAY).length, 0);
  assert.throws(() => s.withdrawWish(ANNA, w.id), { reason: 'wish_not_found' });
});

test('Mitglied ohne Eltern- oder Kindrolle sieht nichts', () => {
  const { s } = setup();
  const OMA = { userId: 5, role: 'other', access: 'write' };
  assert.throws(() => s.ledgerList(OMA, MONDAY, { child: 10 }), { reason: 'no_role' });
  assert.throws(() => s.listRewards(OMA, MONDAY), { reason: 'no_role' });
  assert.deepEqual(s.summary(OMA, MONDAY), { role: 'other' });
});

test('Leserecht: Kind kann lesen, aber nicht melden', () => {
  const { s } = setup();
  const a = action(s);
  const reader = { ...ANNA, access: 'read' };
  assert.equal(s.today(reader, MONDAY).actions.length, 1);
  assert.throws(() => s.reportCompletion(reader, MONDAY, { action_id: a.id, request_id: rid() }), { reason: 'read_only' });
});

test('Rollen: Admin, Elternrolle mit Schreibrecht, Kind, andere', () => {
  const { s } = setup();
  assert.equal(s.roleOf({ admin: true, familyRole: 'child', access: 'write' }), 'parent');
  assert.equal(s.roleOf({ admin: false, familyRole: 'mom', access: 'write' }), 'parent');
  assert.equal(s.roleOf({ admin: false, familyRole: 'dad', access: 'read' }), 'other');
  assert.equal(s.roleOf({ admin: false, familyRole: 'child', access: 'write' }), 'child');
  assert.equal(s.roleOf({ admin: false, familyRole: 'grandparent', access: 'write' }), 'other');
  assert.throws(() => s.updateSettings({ ...PARENT, admin: false }, { parent_roles: false }, { admin: false }), { reason: 'admin_required' });
  s.updateSettings(PARENT, { parent_roles: false }, { admin: true });
  assert.equal(s.roleOf({ admin: false, familyRole: 'mom', access: 'write' }), 'other');
});

test('Bonus braucht Begruendung und bekanntes Kind; Wiederholung bucht einmal', () => {
  const { s } = setup();
  assert.throws(() => s.bonus(PARENT, MONDAY, { child_id: 10, stars: 3, reason: '', request_id: rid() }), { reason: 'required' });
  assert.throws(() => s.bonus(PARENT, MONDAY, { child_id: 99, stars: 3, reason: 'x', request_id: rid() }), { reason: 'not_a_child' });
  assert.throws(() => s.bonus(PARENT, MONDAY, { child_id: 10, stars: 0, reason: 'x', request_id: rid() }), { reason: 'out_of_range' });
  assert.throws(() => s.bonus(PARENT, MONDAY, { child_id: 10, stars: 2.5, reason: 'x', request_id: rid() }), { reason: 'out_of_range' });
  const id = rid();
  s.bonus(PARENT, MONDAY, { child_id: 10, stars: 3, reason: 'Geholfen', request_id: id });
  s.bonus(PARENT, MONDAY, { child_id: 10, stars: 3, reason: 'Geholfen', request_id: id });
  assert.equal(s.balance(10).available, 3);
});

test('Korrektur: Gegenbuchung nachvollziehbar, einmalig, nie unter null', () => {
  const { s, db } = setup();
  const a = action(s, { stars: 4 });
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  const entry = s.ledgerList(PARENT, MONDAY, { child: 10 }).entries[0];
  const c = s.correction(PARENT, MONDAY, { child_id: 10, reverses_id: entry.id, reason: 'Versehentlich', request_id: rid() });
  assert.equal(c.balance.available, 0);
  const list = s.ledgerList(PARENT, MONDAY, { child: 10 }).entries;
  assert.equal(list[0].kind, 'correction');
  assert.equal(list[0].delta, -4);
  assert.equal(list[1].reversed, true);
  assert.throws(() => s.correction(PARENT, MONDAY, { child_id: 10, reverses_id: entry.id, reason: 'x', request_id: rid() }), { reason: 'already_reversed' });
  assert.throws(() => s.correction(PARENT, MONDAY, { child_id: 10, stars: -1, reason: 'x', request_id: rid() }), { reason: 'insufficient_stars' });
  // Journal ist unveraenderlich.
  assert.throws(() => db.prepare('UPDATE ledger SET delta = 100').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM ledger').run(), /append-only/);
});

function reward(s, over = {}) {
  return s.createReward(PARENT, MONDAY, { title: 'Buch', icon: '📚', stars: 10, ...over });
}

test('Einloesung mit ausreichendem Guthaben: reservieren, genehmigen, uebergeben', () => {
  const { s } = setup();
  earn(s, 24);
  const r = reward(s);
  const red = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid(), expected_stars: 10 });
  assert.equal(red.redemption.status, 'pending');
  assert.deepEqual(s.balance(10), { available: 14, reserved: 10, earned: 24 });
  const ok = s.decideRedemption(PARENT, MONDAY, red.redemption.id, 'approve');
  assert.equal(ok.redemption.status, 'approved');
  assert.deepEqual(s.balance(10), { available: 14, reserved: 0, earned: 24 });
  const done = s.decideRedemption(PARENT, MONDAY, red.redemption.id, 'fulfill');
  assert.equal(done.redemption.status, 'fulfilled');
  assert.equal(s.balance(10).available, 14);
  const kinds = s.ledgerList(PARENT, MONDAY, { child: 10 }).entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['redeem', 'reserve', 'bonus']);
});

test('Einloesung mit zu wenig Guthaben wird abgewiesen, nichts gebucht', () => {
  const { s, db } = setup();
  earn(s, 5);
  const r = reward(s);
  assert.throws(() => s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() }), { reason: 'insufficient_stars' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 0);
  assert.equal(s.balance(10).available, 5);
});

test('Parallele Einloesungen ueberziehen nie', () => {
  const { s } = setup();
  earn(s, 15);
  const a = reward(s, { title: 'A' });
  const b = reward(s, { title: 'B' });
  s.requestRedemption(ANNA, { reward_id: a.id, request_id: rid() });
  assert.throws(() => s.requestRedemption(ANNA, { reward_id: b.id, request_id: rid() }), { reason: 'insufficient_stars' });
  // Dieselbe Belohnung zweimal mit zwei Ids: eine offene Anfrage.
  earn(s, 100);
  assert.throws(() => s.requestRedemption(ANNA, { reward_id: a.id, request_id: rid() }), { reason: 'already_requested' });
  assert.equal(s.balance(10).reserved, 10);
});

test('Wiederholte Einloesungsanfrage: keine doppelte Anfrage, keine doppelte Abbuchung', () => {
  const { s, db } = setup();
  earn(s, 30);
  const r = reward(s);
  const id = rid();
  const one = s.requestRedemption(ANNA, { reward_id: r.id, request_id: id });
  const two = s.requestRedemption(ANNA, { reward_id: r.id, request_id: id });
  assert.equal(two.replayed, true);
  assert.equal(one.redemption.id, two.redemption.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 1);
  assert.equal(s.balance(10).available, 20);
  s.decideRedemption(PARENT, MONDAY, one.redemption.id, 'approve');
  s.decideRedemption(PARENT, MONDAY, one.redemption.id, 'approve');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'redeem'").get().n, 1);
});

test('Ablehnung und Stornierung geben die Reservierung vollstaendig frei', () => {
  const { s } = setup();
  earn(s, 20);
  const r = reward(s);
  const x = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() });
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'reject', { feedback: 'Erst nach den Ferien' });
  assert.deepEqual(s.balance(10), { available: 20, reserved: 0, earned: 20 });
  const y = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() });
  s.decideRedemption(ANNA, MONDAY, y.redemption.id, 'cancel');
  assert.deepEqual(s.balance(10), { available: 20, reserved: 0, earned: 20 });
  assert.throws(() => s.decideRedemption(ANNA, MONDAY, y.redemption.id, 'approve'), { reason: 'parent_required' });
  // Ein Kind kann keine fremde Anfrage zurueckziehen.
  const z = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() });
  assert.throws(() => s.decideRedemption(BEN, MONDAY, z.redemption.id, 'cancel'), { reason: 'redemption_not_found' });
});

test('Genehmigung zuruecknehmen bucht die Sterne zurueck', () => {
  const { s } = setup();
  earn(s, 10);
  const r = reward(s);
  const x = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() });
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'approve');
  assert.equal(s.balance(10).available, 0);
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'revoke', { feedback: 'Ausverkauft' });
  assert.equal(s.balance(10).available, 10);
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'revoke');
  assert.equal(s.balance(10).available, 10);
});

test('Preisaenderung veraendert keine bestehende Anfrage; alter Preis wird abgelehnt', () => {
  const { s } = setup();
  earn(s, 50);
  const r = reward(s, { stars: 10 });
  const x = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid(), expected_stars: 10 });
  s.updateReward(PARENT, MONDAY, r.id, { stars: 30, title: 'Teures Buch' });
  const list = s.listRedemptions(PARENT, MONDAY);
  assert.equal(list[0].stars, 10);
  assert.equal(list[0].title, 'Buch');
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'approve');
  assert.equal(s.balance(10).available, 40);
  // Das Kind hat noch den alten Preis gesehen: nichts buchen, neuen Preis nennen.
  assert.throws(() => s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid(), expected_stars: 10 }),
    (err) => err.reason === 'price_changed' && err.extra.stars === 30);
});

test('Belohnung nur fuer bestimmte Kinder, Verfuegbarkeit', () => {
  const { s } = setup();
  earn(s, 50, 11);
  const r = reward(s, { all_children: false, child_ids: [10] });
  assert.equal(s.listRewards(BEN, MONDAY).length, 0);
  assert.throws(() => s.requestRedemption(BEN, { reward_id: r.id, request_id: rid() }), { reason: 'reward_not_found' });
  assert.equal(s.listRewards(ANNA, MONDAY).length, 1);
  assert.equal(s.listRewards(ANNA, MONDAY)[0].child_ids, undefined);
  s.updateReward(PARENT, MONDAY, r.id, { available: false });
  earn(s, 50, 10);
  assert.equal(s.listRewards(ANNA, MONDAY).length, 0);
  assert.throws(() => s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() }), { reason: 'reward_unavailable' });
  assert.throws(() => reward(s, { all_children: false, child_ids: [] }), { reason: 'no_children' });
});

test('Wunsch vorschlagen, freigeben mit Preis, als Ziel sparen', () => {
  const { s } = setup();
  const w = s.proposeWish(ANNA, { title: 'Lego Feuerwehr', url: 'https://example.com/lego', request_id: rid() });
  assert.equal(w.status, 'proposed');
  assert.throws(() => s.proposeWish(ANNA, { title: 'x', url: 'javascript:alert(1)', request_id: rid() }), { reason: 'invalid_url' });
  const { reward: r, wish } = s.approveWish(PARENT, MONDAY, w.id, { stars: 40 });
  assert.equal(wish.status, 'approved');
  assert.equal(r.stars, 40);
  assert.deepEqual(r.child_ids, [10]);
  assert.equal(r.url, 'https://example.com/lego');
  assert.equal(s.listRewards(BEN, MONDAY).length, 0);
  earn(s, 24);
  const goal = s.setGoal(ANNA, MONDAY, { reward_id: r.id });
  assert.equal(goal.have, 24);
  assert.equal(goal.missing, 16);
  assert.throws(() => s.setGoal(BEN, MONDAY, { reward_id: r.id }), { reason: 'reward_not_found' });
  // Genehmigte Einloesung erreicht das Ziel.
  earn(s, 16);
  const x = s.requestRedemption(ANNA, { reward_id: r.id, request_id: rid() });
  s.decideRedemption(PARENT, MONDAY, x.redemption.id, 'approve');
  assert.equal(s.goalOf(10), null);
});

test('Wunsch ablehnen braucht eine Rueckmeldung', () => {
  const { s } = setup();
  const w = s.proposeWish(ANNA, { title: 'Handy', request_id: rid() });
  assert.throws(() => s.rejectWish(PARENT, MONDAY, w.id, {}), { reason: 'required' });
  const r = s.rejectWish(PARENT, MONDAY, w.id, { feedback: 'Dafür bist du noch zu jung' });
  assert.equal(r.status, 'rejected');
  assert.equal(s.listWishes(ANNA, MONDAY)[0].feedback, 'Dafür bist du noch zu jung');
  assert.throws(() => s.approveWish(PARENT, MONDAY, w.id, { stars: 10 }), { reason: 'already_decided' });
});

test('Wuensche lassen sich abschalten', () => {
  const { s } = setup();
  s.updateSettings(PARENT, { wishes_enabled: false }, { admin: true });
  assert.throws(() => s.proposeWish(ANNA, { title: 'x', request_id: rid() }), { reason: 'wishes_disabled' });
});

test('Uebersicht und Kachel', () => {
  const { s } = setup();
  const a = action(s, { requires_approval: true, child_ids: [10, 11] });
  s.reportCompletion(ANNA, MONDAY, { action_id: a.id, request_id: rid() });
  const o = s.overview(PARENT, MONDAY);
  assert.equal(o.counts.completions, 1);
  assert.equal(o.children.find((c) => c.id === 10).pending, 1);
  const kid = s.summary(BEN, MONDAY);
  assert.equal(kid.open.length, 1);
  assert.equal(kid.balance.available, 0);
  const parent = s.summary(PARENT, MONDAY);
  assert.equal(parent.children.length, 2);
});

test('Eingaben werden geprueft', () => {
  const { s } = setup();
  assert.throws(() => action(s, { title: '' }), { reason: 'required' });
  assert.throws(() => action(s, { title: 'x'.repeat(81) }), { reason: 'too_long' });
  assert.throws(() => action(s, { stars: -1 }), { reason: 'out_of_range' });
  assert.throws(() => action(s, { weekdays: 0 }), { reason: 'out_of_range' });
  assert.throws(() => action(s, { child_ids: [] }), { reason: 'no_children' });
  assert.throws(() => action(s, { child_ids: [99] }), { reason: 'not_a_child' });
  assert.throws(() => action(s, { icon: '<img>' }), { reason: 'invalid_input' });
  assert.throws(() => s.reportCompletion(ANNA, MONDAY, { action_id: 1, request_id: 'x' }), { reason: 'invalid_request_id' });
});
