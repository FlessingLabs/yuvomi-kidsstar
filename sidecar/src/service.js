/**
 * KidsStar - Fachlogik
 *
 * Alles hier ist synchron: Pruefen und Schreiben laufen in einer Transaktion
 * ohne Yield-Punkt (siehe transaction() in db.js). Was asynchron ist - wer
 * fragt, welche Kinder es gibt, welcher Tag heute ist -, loest der HTTP-Teil
 * vorher auf und reicht es als `actor` und `ctx` herein.
 *
 *   actor: { userId, name, role: 'parent'|'child'|'other', access: 'read'|'write' }
 *   ctx:   { day: 'YYYY-MM-DD', weekday: 1..7, children: [{ id, name, avatar_color }] }
 *
 * Sterne entstehen nur hier, und nur als Zeile im Journal (`ledger`).
 */

import crypto from 'node:crypto';
import { transaction } from './db.js';
import { conflict, forbidden, invalid, notFound } from './errors.js';
import { weekdayBit } from './time.js';
import * as v from './validate.js';

export const PARENT_FAMILY_ROLES = Object.freeze(['dad', 'mom', 'parent']);

export const DEFAULT_SETTINGS = Object.freeze({
  // Duerfen Mitglieder mit der Familienrolle Vater/Mutter/Elternteil (und
  // Schreibrecht auf KidsStar) Elternfunktionen nutzen, auch ohne Admin zu sein?
  parent_roles: true,
  // Vorgabe fuer neue Aktionen.
  default_requires_approval: true,
  // Duerfen Kinder eigene Wuensche vorschlagen?
  wishes_enabled: true,
});

const nowIso = () => new Date().toISOString();

function isConstraint(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message));
}

export function createService(db) {
  // ------------------------------------------------------------------
  // Einstellungen und Rollen
  // ------------------------------------------------------------------

  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      if (row.key in DEFAULT_SETTINGS) out[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  /**
   * Rolle im Sinne von KidsStar, nur aus der /auth/me-Antwort von Yuvomi.
   * Eltern: Yuvomi-Administratoren, und - wenn der Haushalt es erlaubt -
   * Mitglieder mit Familienrolle Vater/Mutter/Elternteil und Schreibrecht.
   * Die Familienrolle setzt in Yuvomi nur ein Administrator.
   * Kind: Familienrolle "Kind". Alle anderen sehen KidsStar nur von aussen.
   */
  function roleOf(identity) {
    if (identity.admin) return 'parent';
    if (getSettings().parent_roles && PARENT_FAMILY_ROLES.includes(identity.familyRole) && identity.access === 'write') {
      return 'parent';
    }
    if (identity.familyRole === 'child') return 'child';
    return 'other';
  }

  /**
   * Die Zeitzone des Haushalts, zuletzt aus einer Yuvomi-Sitzung gelernt. Das
   * Tablet hat keine Sitzung und das Token keinen Zugriff auf
   * /api/v1/preferences; es rechnet mit dem zuletzt gesehenen Wert.
   */
  function rememberTimeZone(tz) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'household_timezone'").get();
    if (row && JSON.parse(row.value) === tz) return;
    db.prepare("INSERT INTO settings (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(tz));
  }
  function knownTimeZone() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'household_timezone'").get();
    return row ? JSON.parse(row.value) : null;
  }

  function updateSettings(actor, body, { admin }) {
    requireParent(actor);
    const patch = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (body[key] !== undefined) patch[key] = v.bool(body[key], key);
    }
    // Wer Eltern sein darf, ist eine Frage des Haushalts: nur Administratoren.
    if ('parent_roles' in patch && !admin) throw forbidden('Only administrators can change who counts as a parent.', 'admin_required');
    transaction(db, () => {
      const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, val] of Object.entries(patch)) up.run(k, JSON.stringify(val));
    });
    return getSettings();
  }

  // ------------------------------------------------------------------
  // Pruefungen
  // ------------------------------------------------------------------

  function requireParent(actor) {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
  }
  function requireWrite(actor) {
    if (actor.access !== 'write') throw forbidden('KidsStar is read-only for you.', 'read_only');
  }
  function requireChild(actor) {
    if (actor.role !== 'child') throw forbidden('Only children can do this.', 'child_required');
  }
  function requireKnownChild(ctx, childId) {
    if (!ctx.children.some((c) => c.id === childId)) throw invalid('Not a child of this household.', 'not_a_child', { child_id: childId });
  }
  function childIdsFrom(ctx, list) {
    const ids = v.idList(list, 'child_ids');
    for (const id of ids) requireKnownChild(ctx, id);
    return ids;
  }

  /**
   * Wessen Daten liest die Anfrage? Ein Kind immer nur seine eigenen - auch
   * wenn es eine fremde Id schickt. Eltern lesen jedes Kind des Haushalts.
   */
  function readableChild(actor, ctx, requested) {
    if (actor.role === 'child') {
      if (requested != null && Number(requested) !== actor.userId) throw notFound('Child not found.', 'child_not_found');
      return actor.userId;
    }
    if (actor.role === 'parent') {
      const id = v.id(requested, 'child');
      if (!ctx.children.some((c) => c.id === id)) throw notFound('Child not found.', 'child_not_found');
      return id;
    }
    throw forbidden('KidsStar is for parents and children.', 'no_role');
  }

  // ------------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------------

  const insertLedger = db.prepare(`
    INSERT INTO ledger (child_id, kind, delta, reserved_delta, reason, completion_id, redemption_id, reverses_id, request_id, created_by, created_at)
    VALUES (@child_id, @kind, @delta, @reserved_delta, @reason, @completion_id, @redemption_id, @reverses_id, @request_id, @created_by, @created_at)
  `);

  function book(entry) {
    const row = {
      reserved_delta: 0, reason: '', completion_id: null, redemption_id: null, reverses_id: null,
      request_id: null, created_by: null, created_at: nowIso(), ...entry,
    };
    const res = insertLedger.run(row);
    return Number(res.lastInsertRowid);
  }

  function balance(childId) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(delta), 0) AS available,
             COALESCE(SUM(reserved_delta), 0) AS reserved,
             COALESCE(SUM(CASE WHEN kind IN ('earn', 'bonus') THEN delta ELSE 0 END), 0) AS earned
      FROM ledger WHERE child_id = ?
    `).get(childId);
    return { available: row.available, reserved: row.reserved, earned: row.earned };
  }

  /** Verfuegbarer Stand darf nie unter null fallen; geprueft in der Transaktion der Buchung. */
  function assertCovers(childId, stars) {
    const { available } = balance(childId);
    if (available < stars) {
      throw conflict('Not enough stars.', 'insufficient_stars', { available, needed: stars });
    }
  }

  function ledgerList(actor, ctx, { child, limit = 50, before } = {}) {
    const childId = readableChild(actor, ctx, child);
    const lim = v.int(limit ?? 50, 'limit', { min: 1, max: 200 });
    const beforeId = before != null && before !== '' ? v.id(before, 'before') : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`
      SELECT l.*, c.day AS completion_day, c.icon AS completion_icon, r.icon AS redemption_icon
      FROM ledger l
      LEFT JOIN completions c ON c.id = l.completion_id
      LEFT JOIN redemptions r ON r.id = l.redemption_id
      WHERE l.child_id = ? AND l.id < ?
      ORDER BY l.id DESC LIMIT ?
    `).all(childId, beforeId, lim + 1);
    const reversed = new Set(db.prepare('SELECT reverses_id FROM ledger WHERE child_id = ? AND reverses_id IS NOT NULL').all(childId).map((r) => r.reverses_id));
    const entries = rows.slice(0, lim).map((r) => ({
      id: r.id,
      kind: r.kind,
      delta: r.delta,
      reserved_delta: r.reserved_delta,
      reason: r.reason,
      icon: r.completion_icon || r.redemption_icon || '',
      completion_id: r.completion_id,
      redemption_id: r.redemption_id,
      reverses_id: r.reverses_id,
      reversed: reversed.has(r.id),
      created_at: r.created_at,
      created_by: r.created_by,
    }));
    return { child_id: childId, balance: balance(childId), entries, next: rows.length > lim ? entries.at(-1).id : null };
  }

  function bonus(actor, ctx, body) {
    requireParent(actor);
    requireWrite(actor);
    const childId = v.id(body.child_id, 'child_id');
    requireKnownChild(ctx, childId);
    const stars = v.int(body.stars, 'stars', { min: 1, max: 1000 });
    const reason = v.text(body.reason, 'reason', { required: true, max: 200 });
    const requestId = v.requestId(body.request_id);
    return transaction(db, () => {
      const existing = db.prepare('SELECT id FROM ledger WHERE child_id = ? AND request_id = ?').get(childId, requestId);
      if (existing) return { id: existing.id, replayed: true, balance: balance(childId) };
      const id = book({ child_id: childId, kind: 'bonus', delta: stars, reason, request_id: requestId, created_by: actor.userId });
      return { id, replayed: false, balance: balance(childId) };
    });
  }

  /**
   * Korrektur einer Fehlbuchung. Entweder als Gegenbuchung einer bestimmten
   * Zeile (`reverses_id`: Betrag = minus deren Betrag) oder als freie Korrektur
   * mit Vorzeichen. Immer mit Begruendung, immer als eigene Zeile.
   */
  function correction(actor, ctx, body) {
    requireParent(actor);
    requireWrite(actor);
    const childId = v.id(body.child_id, 'child_id');
    requireKnownChild(ctx, childId);
    const reason = v.text(body.reason, 'reason', { required: true, max: 200 });
    const requestId = v.requestId(body.request_id);
    const reversesId = body.reverses_id != null ? v.id(body.reverses_id, 'reverses_id') : null;
    const freeStars = reversesId == null ? v.int(body.stars, 'stars', { min: -100000, max: 100000 }) : null;
    if (freeStars === 0) throw invalid('stars must not be 0.', 'out_of_range', { field: 'stars' });

    return transaction(db, () => {
      const existing = db.prepare('SELECT id FROM ledger WHERE child_id = ? AND request_id = ?').get(childId, requestId);
      if (existing) return { id: existing.id, replayed: true, balance: balance(childId) };
      let delta = freeStars;
      if (reversesId != null) {
        const target = db.prepare('SELECT * FROM ledger WHERE id = ? AND child_id = ?').get(reversesId, childId);
        if (!target) throw notFound('Booking not found.', 'entry_not_found');
        if (!['earn', 'bonus', 'correction'].includes(target.kind)) {
          throw conflict('Only earnings, bonuses and corrections can be reversed; redemptions are decided in the shop.', 'not_reversible');
        }
        if (db.prepare('SELECT 1 FROM ledger WHERE reverses_id = ?').get(reversesId)) {
          throw conflict('This booking has already been reversed.', 'already_reversed');
        }
        delta = -target.delta;
      }
      if (delta < 0) assertCovers(childId, -delta);
      const id = book({
        child_id: childId, kind: 'correction', delta, reason, reverses_id: reversesId,
        request_id: requestId, created_by: actor.userId,
      });
      return { id, replayed: false, balance: balance(childId) };
    });
  }

  // ------------------------------------------------------------------
  // Aktionen
  // ------------------------------------------------------------------

  function actionRow(row, childMap) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      icon: row.icon,
      stars: row.stars,
      repeats: Boolean(row.repeats),
      weekdays: row.weekdays,
      per_day: row.per_day,
      requires_approval: Boolean(row.requires_approval),
      status: row.status,
      sort_order: row.sort_order,
      child_ids: childMap.get(row.id) ?? [],
      updated_at: row.updated_at,
    };
  }

  function actionChildren() {
    const map = new Map();
    for (const r of db.prepare('SELECT action_id, child_id FROM action_children ORDER BY child_id').all()) {
      if (!map.has(r.action_id)) map.set(r.action_id, []);
      map.get(r.action_id).push(r.child_id);
    }
    return map;
  }

  function listActions(actor) {
    requireParent(actor);
    const map = actionChildren();
    return db.prepare(`
      SELECT * FROM actions
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, sort_order, title COLLATE NOCASE, id
    `).all().map((r) => actionRow(r, map));
  }

  function getAction(id) {
    const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
    if (!row) throw notFound('Action not found.', 'action_not_found');
    return actionRow(row, new Map([[id, db.prepare('SELECT child_id FROM action_children WHERE action_id = ? ORDER BY child_id').all(id).map((r) => r.child_id)]]));
  }

  function actionFields(body, ctx, { partial }) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (!partial || has('title')) out.title = v.text(body.title, 'title', { required: true, max: 80 });
    if (!partial || has('description')) out.description = v.text(body.description, 'description', { max: 500, multiline: true });
    if (!partial || has('icon')) out.icon = v.icon(body.icon ?? '');
    if (!partial || has('stars')) out.stars = v.int(body.stars, 'stars', { min: 1, max: 1000 });
    if (!partial || has('repeats')) out.repeats = v.bool(body.repeats ?? true, 'repeats') ? 1 : 0;
    if (!partial || has('weekdays')) out.weekdays = v.int(body.weekdays ?? 127, 'weekdays', { min: 1, max: 127 });
    if (!partial || has('per_day')) out.per_day = v.int(body.per_day ?? 1, 'per_day', { min: 1, max: 10 });
    if (!partial || has('requires_approval')) {
      out.requires_approval = v.bool(body.requires_approval ?? getSettings().default_requires_approval, 'requires_approval') ? 1 : 0;
    }
    if (has('status')) {
      if (!['active', 'paused', 'archived'].includes(body.status)) throw invalid('status must be active, paused or archived.', 'invalid_input', { field: 'status' });
      out.status = body.status;
    }
    if (has('sort_order')) out.sort_order = v.int(body.sort_order, 'sort_order', { min: 0, max: 100000 });
    let childIds;
    if (!partial || has('child_ids')) {
      childIds = childIdsFrom(ctx, body.child_ids ?? []);
      if (!childIds.length) throw invalid('Choose at least one child.', 'no_children', { field: 'child_ids' });
    }
    return { fields: out, childIds };
  }

  function createAction(actor, ctx, body) {
    requireParent(actor);
    requireWrite(actor);
    const { fields, childIds } = actionFields(body, ctx, { partial: false });
    return transaction(db, () => {
      const t = nowIso();
      const res = db.prepare(`
        INSERT INTO actions (title, description, icon, stars, repeats, weekdays, per_day, requires_approval, status, sort_order, created_by, created_at, updated_at)
        VALUES (@title, @description, @icon, @stars, @repeats, @weekdays, @per_day, @requires_approval, @status, @sort_order, @created_by, @t, @t)
      `).run({ status: 'active', sort_order: 0, ...fields, created_by: actor.userId, t });
      const id = Number(res.lastInsertRowid);
      const ins = db.prepare('INSERT INTO action_children (action_id, child_id) VALUES (?, ?)');
      for (const c of childIds) ins.run(id, c);
      return getAction(id);
    });
  }

  function updateAction(actor, ctx, id, body) {
    requireParent(actor);
    requireWrite(actor);
    const { fields, childIds } = actionFields(body, ctx, { partial: true });
    return transaction(db, () => {
      getAction(id);
      const keys = Object.keys(fields);
      if (keys.length) {
        db.prepare(`UPDATE actions SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE id = @id`)
          .run({ ...fields, t: nowIso(), id });
      }
      if (childIds) {
        db.prepare('DELETE FROM action_children WHERE action_id = ?').run(id);
        const ins = db.prepare('INSERT INTO action_children (action_id, child_id) VALUES (?, ?)');
        for (const c of childIds) ins.run(id, c);
      }
      return getAction(id);
    });
  }

  // ------------------------------------------------------------------
  // Heute und Erledigungen
  // ------------------------------------------------------------------

  function periodOf(action, day) {
    return action.repeats ? day : 'once';
  }

  /** Zaehlende Erledigungen (offen oder bestaetigt) je Aktion im aktuellen Zeitraum. */
  function countsFor(childId, day) {
    const rows = db.prepare(`
      SELECT action_id, period, status, COUNT(*) AS n FROM completions
      WHERE child_id = ? AND status IN ('pending', 'approved') AND (period = ? OR period = 'once')
      GROUP BY action_id, period, status
    `).all(childId, day);
    const map = new Map();
    for (const r of rows) {
      const key = `${r.action_id}|${r.period}`;
      const e = map.get(key) ?? { pending: 0, approved: 0 };
      e[r.status] += r.n;
      map.set(key, e);
    }
    return map;
  }

  function today(actor, ctx, { child } = {}) {
    const childId = readableChild(actor, ctx, child);
    const { day, weekday } = ctx;
    const counts = countsFor(childId, day);
    const actions = db.prepare(`
      SELECT a.* FROM actions a JOIN action_children ac ON ac.action_id = a.id
      WHERE ac.child_id = ? AND a.status = 'active'
      ORDER BY a.sort_order, a.title COLLATE NOCASE, a.id
    `).all(childId);
    const items = [];
    for (const a of actions) {
      if (a.repeats && !(a.weekdays & weekdayBit(weekday))) continue;
      const limit = a.repeats ? a.per_day : 1;
      const c = counts.get(`${a.id}|${periodOf(a, day)}`) ?? { pending: 0, approved: 0 };
      // Eine einmalige Aktion, die schon bestaetigt ist, ist erledigt und verschwindet.
      if (!a.repeats && c.approved >= 1) continue;
      items.push({
        id: a.id,
        title: a.title,
        description: a.description,
        icon: a.icon,
        stars: a.stars,
        repeats: Boolean(a.repeats),
        requires_approval: Boolean(a.requires_approval),
        limit,
        pending: c.pending,
        approved: c.approved,
        remaining: Math.max(0, limit - c.pending - c.approved),
      });
    }
    const pending = db.prepare(`
      SELECT * FROM completions WHERE child_id = ? AND status = 'pending' ORDER BY id
    `).all(childId).map(completionRow);
    const recent = db.prepare(`
      SELECT id, kind, delta, reason, created_at FROM ledger
      WHERE child_id = ? AND kind IN ('earn', 'bonus') ORDER BY id DESC LIMIT 5
    `).all(childId);
    const rejected = db.prepare(`
      SELECT * FROM completions WHERE child_id = ? AND status = 'rejected' AND day = ? ORDER BY id DESC LIMIT 5
    `).all(childId, day).map(completionRow);
    return { child_id: childId, day, weekday, actions: items, pending, rejected, recent, balance: balance(childId), goal: goalOf(childId) };
  }

  function completionRow(r) {
    return {
      id: r.id, action_id: r.action_id, child_id: r.child_id, day: r.day, title: r.title, icon: r.icon,
      stars: r.stars, status: r.status, feedback: r.feedback, created_at: r.created_at, decided_at: r.decided_at,
    };
  }

  /**
   * Ein Kind meldet eine Aktion als erledigt. Wiederholsicher ueber
   * `request_id`; gegen parallele Meldungen schuetzen die Zaehlung in der
   * Transaktion und der eindeutige Platz (completions_slot).
   */
  function reportCompletion(actor, ctx, body) {
    requireChild(actor);
    requireWrite(actor);
    const actionId = v.id(body.action_id, 'action_id');
    const requestId = v.requestId(body.request_id);
    const childId = actor.userId;
    const { day, weekday } = ctx;

    try {
      return transaction(db, () => {
        const replay = db.prepare('SELECT * FROM completions WHERE child_id = ? AND request_id = ?').get(childId, requestId);
        if (replay) return { completion: completionRow(replay), replayed: true, balance: balance(childId) };

        const a = db.prepare(`
          SELECT a.* FROM actions a JOIN action_children ac ON ac.action_id = a.id
          WHERE a.id = ? AND ac.child_id = ?
        `).get(actionId, childId);
        if (!a) throw notFound('Action not found.', 'action_not_found');
        if (a.status !== 'active') throw conflict('This action is paused.', 'action_inactive');
        if (a.repeats && !(a.weekdays & weekdayBit(weekday))) throw conflict('This action is not due today.', 'not_due_today');

        const period = periodOf(a, day);
        const limit = a.repeats ? a.per_day : 1;
        const taken = new Set(db.prepare(`
          SELECT slot FROM completions
          WHERE action_id = ? AND child_id = ? AND period = ? AND status IN ('pending', 'approved')
        `).all(a.id, childId, period).map((r) => r.slot));
        let slot = 0;
        for (let s = 1; s <= limit; s += 1) if (!taken.has(s)) { slot = s; break; }
        if (!slot) throw conflict('Already done as often as allowed today.', 'limit_reached', { limit });

        const t = nowIso();
        const status = a.requires_approval ? 'pending' : 'approved';
        const res = db.prepare(`
          INSERT INTO completions (action_id, child_id, period, day, slot, title, icon, stars, status, request_id, created_by, created_at, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(a.id, childId, period, day, slot, a.title, a.icon, a.stars, status, requestId, actor.userId, t, status === 'approved' ? t : null);
        const completionId = Number(res.lastInsertRowid);
        if (status === 'approved') {
          book({ child_id: childId, kind: 'earn', delta: a.stars, reason: a.title, completion_id: completionId, created_by: actor.userId });
        }
        const row = db.prepare('SELECT * FROM completions WHERE id = ?').get(completionId);
        return { completion: completionRow(row), replayed: false, balance: balance(childId) };
      });
    } catch (err) {
      // Zwei Geraete zugleich: der eindeutige Platz hat die zweite Meldung abgewiesen.
      if (!err.status && isConstraint(err)) throw conflict('Already done as often as allowed today.', 'limit_reached');
      throw err;
    }
  }

  function listCompletions(actor, ctx, { status = 'pending', child } = {}) {
    const states = ['pending', 'approved', 'rejected', 'cancelled'];
    if (!states.includes(status)) throw invalid('Unknown status.', 'invalid_input', { field: 'status' });
    if (actor.role === 'child') {
      return db.prepare('SELECT * FROM completions WHERE child_id = ? AND status = ? ORDER BY id DESC LIMIT 100')
        .all(actor.userId, status).map(completionRow);
    }
    requireParent(actor);
    const ids = ctx.children.map((c) => c.id);
    if (child != null) {
      const id = readableChild(actor, ctx, child);
      return db.prepare('SELECT * FROM completions WHERE child_id = ? AND status = ? ORDER BY id DESC LIMIT 100').all(id, status).map(completionRow);
    }
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM completions WHERE status = ? AND child_id IN (${ids.map(() => '?').join(',')}) ORDER BY id LIMIT 200`)
      .all(status, ...ids).map(completionRow);
  }

  function decideCompletion(actor, ctx, id, decision, body = {}) {
    requireParent(actor);
    requireWrite(actor);
    const feedback = v.text(body.feedback, 'feedback', { max: 200 });
    return transaction(db, () => {
      const c = db.prepare('SELECT * FROM completions WHERE id = ?').get(id);
      if (!c || !ctx.children.some((k) => k.id === c.child_id)) throw notFound('Completion not found.', 'completion_not_found');
      const target = decision === 'approve' ? 'approved' : 'rejected';
      if (c.status === target) return { completion: completionRow(c), replayed: true, balance: balance(c.child_id) };
      if (c.status !== 'pending') throw conflict('This report has already been decided.', 'already_decided', { status: c.status });
      db.prepare('UPDATE completions SET status = ?, feedback = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(target, feedback, actor.userId, nowIso(), id);
      if (target === 'approved') {
        book({ child_id: c.child_id, kind: 'earn', delta: c.stars, reason: c.title, completion_id: c.id, created_by: actor.userId });
      }
      return { completion: completionRow(db.prepare('SELECT * FROM completions WHERE id = ?').get(id)), replayed: false, balance: balance(c.child_id) };
    });
  }

  /** Ein Kind zieht eine noch offene Meldung zurueck (aus Versehen getippt). */
  function cancelCompletion(actor, id) {
    requireChild(actor);
    requireWrite(actor);
    return transaction(db, () => {
      const c = db.prepare('SELECT * FROM completions WHERE id = ? AND child_id = ?').get(id, actor.userId);
      if (!c) throw notFound('Completion not found.', 'completion_not_found');
      if (c.status === 'cancelled') return { completion: completionRow(c), replayed: true };
      if (c.status !== 'pending') throw conflict('This report has already been decided.', 'already_decided', { status: c.status });
      db.prepare("UPDATE completions SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?").run(actor.userId, nowIso(), id);
      return { completion: completionRow(db.prepare('SELECT * FROM completions WHERE id = ?').get(id)), replayed: false };
    });
  }

  // ------------------------------------------------------------------
  // Belohnungen (Sterneshop)
  // ------------------------------------------------------------------

  function rewardChildren() {
    const map = new Map();
    for (const r of db.prepare('SELECT reward_id, child_id FROM reward_children ORDER BY child_id').all()) {
      if (!map.has(r.reward_id)) map.set(r.reward_id, []);
      map.get(r.reward_id).push(r.child_id);
    }
    return map;
  }

  function rewardRow(r, map) {
    return {
      id: r.id, title: r.title, description: r.description, icon: r.icon, image: r.image, url: r.url,
      stars: r.stars, available: Boolean(r.available), all_children: Boolean(r.all_children),
      child_ids: map.get(r.id) ?? [], archived: Boolean(r.archived), wish_id: r.wish_id,
      sort_order: r.sort_order, updated_at: r.updated_at,
    };
  }

  function visibleToChild(reward, childId, map) {
    return !reward.archived && (reward.all_children || (map.get(reward.id) ?? []).includes(childId));
  }

  function listRewards(actor, ctx, { archived = false } = {}) {
    const map = rewardChildren();
    const rows = db.prepare('SELECT * FROM rewards ORDER BY archived, sort_order, stars, title COLLATE NOCASE, id').all();
    if (actor.role === 'parent') {
      return rows.filter((r) => archived || !r.archived).map((r) => rewardRow(r, map));
    }
    if (actor.role === 'child') {
      const goal = db.prepare('SELECT reward_id FROM goals WHERE child_id = ?').get(actor.userId)?.reward_id;
      return rows
        .filter((r) => visibleToChild(r, actor.userId, map) && (r.available || r.id === goal))
        .map((r) => {
          const out = rewardRow(r, map);
          // Ein Kind braucht nicht zu wissen, fuer wen sonst eine Belohnung gilt.
          delete out.child_ids;
          delete out.all_children;
          return out;
        });
    }
    throw forbidden('KidsStar is for parents and children.', 'no_role');
  }

  function getReward(id) {
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
    if (!r) throw notFound('Reward not found.', 'reward_not_found');
    return rewardRow(r, rewardChildren());
  }

  function rewardFields(body, ctx, { partial }) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (!partial || has('title')) out.title = v.text(body.title, 'title', { required: true, max: 80 });
    if (!partial || has('description')) out.description = v.text(body.description, 'description', { max: 500, multiline: true });
    if (!partial || has('icon')) out.icon = v.icon(body.icon ?? '');
    if (!partial || has('url')) out.url = v.url(body.url ?? '');
    if (!partial || has('stars')) out.stars = v.int(body.stars, 'stars', { min: 1, max: 100000 });
    if (!partial || has('available')) out.available = v.bool(body.available ?? true, 'available') ? 1 : 0;
    if (!partial || has('all_children')) out.all_children = v.bool(body.all_children ?? true, 'all_children') ? 1 : 0;
    if (has('archived')) out.archived = v.bool(body.archived, 'archived') ? 1 : 0;
    if (has('sort_order')) out.sort_order = v.int(body.sort_order, 'sort_order', { min: 0, max: 100000 });
    let childIds;
    if (!partial || has('child_ids')) childIds = childIdsFrom(ctx, body.child_ids ?? []);
    return { fields: out, childIds };
  }

  function checkAudience(rewardId) {
    const r = db.prepare('SELECT all_children FROM rewards WHERE id = ?').get(rewardId);
    const n = db.prepare('SELECT COUNT(*) AS n FROM reward_children WHERE reward_id = ?').get(rewardId).n;
    if (!r.all_children && n === 0) throw invalid('Choose at least one child or "all children".', 'no_children', { field: 'child_ids' });
  }

  function createReward(actor, ctx, body, { wishId = null } = {}) {
    requireParent(actor);
    requireWrite(actor);
    const { fields, childIds } = rewardFields(body, ctx, { partial: false });
    const t = nowIso();
    const res = db.prepare(`
      INSERT INTO rewards (title, description, icon, url, stars, available, all_children, archived, wish_id, sort_order, created_by, created_at, updated_at)
      VALUES (@title, @description, @icon, @url, @stars, @available, @all_children, 0, @wish_id, @sort_order, @created_by, @t, @t)
    `).run({ sort_order: 0, ...fields, wish_id: wishId, created_by: actor.userId, t });
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO reward_children (reward_id, child_id) VALUES (?, ?)');
    for (const c of childIds) ins.run(id, c);
    checkAudience(id);
    return getReward(id);
  }

  function updateReward(actor, ctx, id, body) {
    requireParent(actor);
    requireWrite(actor);
    const { fields, childIds } = rewardFields(body, ctx, { partial: true });
    return transaction(db, () => {
      getReward(id);
      const keys = Object.keys(fields);
      if (keys.length) {
        db.prepare(`UPDATE rewards SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE id = @id`)
          .run({ ...fields, t: nowIso(), id });
      }
      if (childIds) {
        db.prepare('DELETE FROM reward_children WHERE reward_id = ?').run(id);
        const ins = db.prepare('INSERT INTO reward_children (reward_id, child_id) VALUES (?, ?)');
        for (const c of childIds) ins.run(id, c);
      }
      checkAudience(id);
      // Ein archiviertes Ziel ist kein Ziel mehr.
      if (fields.archived) db.prepare('DELETE FROM goals WHERE reward_id = ?').run(id);
      return getReward(id);
    });
  }

  /** Bild einer Belohnung setzen oder entfernen; liefert den alten Dateinamen zum Aufraeumen. */
  function setRewardImage(actor, id, filename) {
    requireParent(actor);
    requireWrite(actor);
    return transaction(db, () => {
      const r = db.prepare('SELECT image FROM rewards WHERE id = ?').get(id);
      if (!r) throw notFound('Reward not found.', 'reward_not_found');
      db.prepare('UPDATE rewards SET image = ?, updated_at = ? WHERE id = ?').run(filename, nowIso(), id);
      return { reward: getReward(id), previous: r.image };
    });
  }

  /** Wird ein Bild noch gebraucht (Belohnung oder Momentaufnahme einer Einloesung)? */
  function imageInUse(filename) {
    return Boolean(
      db.prepare('SELECT 1 FROM rewards WHERE image = ?').get(filename)
      || db.prepare('SELECT 1 FROM redemptions WHERE image = ?').get(filename),
    );
  }

  /** Darf diese Anfrage das Bild sehen? Eltern alle, ein Kind die seiner Belohnungen und Einloesungen. */
  function mayViewImage(actor, filename) {
    if (actor.role === 'parent') return true;
    if (actor.role !== 'child') return false;
    const map = rewardChildren();
    for (const r of db.prepare('SELECT * FROM rewards WHERE image = ?').all(filename)) {
      if (visibleToChild(r, actor.userId, map)) return true;
    }
    return Boolean(db.prepare('SELECT 1 FROM redemptions WHERE image = ? AND child_id = ?').get(filename, actor.userId));
  }

  // ------------------------------------------------------------------
  // Sparziel
  // ------------------------------------------------------------------

  function goalOf(childId) {
    const g = db.prepare(`
      SELECT g.reward_id, r.title, r.icon, r.image, r.stars, r.available
      FROM goals g JOIN rewards r ON r.id = g.reward_id WHERE g.child_id = ?
    `).get(childId);
    if (!g) return null;
    const { available } = balance(childId);
    return {
      reward_id: g.reward_id, title: g.title, icon: g.icon, image: g.image, stars: g.stars,
      available: Boolean(g.available), have: Math.min(available, g.stars), missing: Math.max(0, g.stars - available),
    };
  }

  function setGoal(actor, ctx, body) {
    requireChild(actor);
    requireWrite(actor);
    const childId = actor.userId;
    return transaction(db, () => {
      if (body.reward_id === null) {
        db.prepare('DELETE FROM goals WHERE child_id = ?').run(childId);
        return null;
      }
      const rewardId = v.id(body.reward_id, 'reward_id');
      const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(rewardId);
      if (!r || !visibleToChild(r, childId, rewardChildren())) throw notFound('Reward not found.', 'reward_not_found');
      db.prepare('INSERT INTO goals (child_id, reward_id, set_at) VALUES (?, ?, ?) ON CONFLICT(child_id) DO UPDATE SET reward_id = excluded.reward_id, set_at = excluded.set_at')
        .run(childId, rewardId, nowIso());
      return goalOf(childId);
    });
  }

  // ------------------------------------------------------------------
  // Wuensche
  // ------------------------------------------------------------------

  function wishRow(w) {
    return {
      id: w.id, child_id: w.child_id, title: w.title, description: w.description, url: w.url,
      status: w.status, feedback: w.feedback, reward_id: w.reward_id, created_at: w.created_at, decided_at: w.decided_at,
    };
  }

  function listWishes(actor, ctx, { status } = {}) {
    if (status !== undefined && !['proposed', 'approved', 'rejected', 'withdrawn'].includes(status)) {
      throw invalid('Unknown status.', 'invalid_input', { field: 'status' });
    }
    const filter = status ? 'AND status = @status' : '';
    if (actor.role === 'child') {
      return db.prepare(`SELECT * FROM wishes WHERE child_id = @child ${filter} ORDER BY id DESC LIMIT 100`)
        .all({ child: actor.userId, ...(status ? { status } : {}) }).map(wishRow);
    }
    requireParent(actor);
    const ids = ctx.children.map((c) => c.id);
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM wishes WHERE child_id IN (${ids.join(',')}) ${filter} ORDER BY id DESC LIMIT 200`)
      .all(status ? { status } : {}).map(wishRow);
  }

  function proposeWish(actor, body) {
    requireChild(actor);
    requireWrite(actor);
    if (!getSettings().wishes_enabled) throw forbidden('Wishes are switched off.', 'wishes_disabled');
    const title = v.text(body.title, 'title', { required: true, max: 80 });
    const description = v.text(body.description, 'description', { max: 500, multiline: true });
    const link = v.url(body.url ?? '');
    const requestId = v.requestId(body.request_id);
    return transaction(db, () => {
      const replay = db.prepare('SELECT * FROM wishes WHERE child_id = ? AND request_id = ?').get(actor.userId, requestId);
      if (replay) return wishRow(replay);
      const open = db.prepare("SELECT COUNT(*) AS n FROM wishes WHERE child_id = ? AND status = 'proposed'").get(actor.userId).n;
      if (open >= 20) throw conflict('Too many open wishes. Wait until your parents have looked at them.', 'too_many_wishes');
      const res = db.prepare(`
        INSERT INTO wishes (child_id, title, description, url, status, request_id, created_at)
        VALUES (?, ?, ?, ?, 'proposed', ?, ?)
      `).run(actor.userId, title, description, link, requestId, nowIso());
      return wishRow(db.prepare('SELECT * FROM wishes WHERE id = ?').get(Number(res.lastInsertRowid)));
    });
  }

  function withdrawWish(actor, id) {
    requireChild(actor);
    requireWrite(actor);
    return transaction(db, () => {
      const w = db.prepare('SELECT * FROM wishes WHERE id = ? AND child_id = ?').get(id, actor.userId);
      if (!w) throw notFound('Wish not found.', 'wish_not_found');
      if (w.status === 'withdrawn') return wishRow(w);
      if (w.status !== 'proposed') throw conflict('This wish has already been decided.', 'already_decided', { status: w.status });
      db.prepare("UPDATE wishes SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(nowIso(), id);
      return wishRow(db.prepare('SELECT * FROM wishes WHERE id = ?').get(id));
    });
  }

  /**
   * Eltern nehmen einen Wunsch an: sie legen den Preis fest, und der Wunsch
   * wird zu einer Belohnung - standardmaessig nur fuer das Kind, das ihn hatte.
   */
  function approveWish(actor, ctx, id, body) {
    requireParent(actor);
    requireWrite(actor);
    return transaction(db, () => {
      const w = db.prepare('SELECT * FROM wishes WHERE id = ?').get(id);
      if (!w || !ctx.children.some((c) => c.id === w.child_id)) throw notFound('Wish not found.', 'wish_not_found');
      if (w.status === 'approved') return { wish: wishRow(w), reward: getReward(w.reward_id), replayed: true };
      if (w.status !== 'proposed') throw conflict('This wish has already been decided.', 'already_decided', { status: w.status });
      const reward = createReward(actor, ctx, {
        title: body.title ?? w.title,
        description: body.description ?? w.description,
        icon: body.icon ?? '',
        url: body.url ?? w.url,
        stars: body.stars,
        available: body.available ?? true,
        all_children: body.all_children ?? false,
        child_ids: body.child_ids ?? [w.child_id],
      }, { wishId: w.id });
      const feedback = v.text(body.feedback, 'feedback', { max: 200 });
      db.prepare("UPDATE wishes SET status = 'approved', reward_id = ?, feedback = ?, decided_by = ?, decided_at = ? WHERE id = ?")
        .run(reward.id, feedback, actor.userId, nowIso(), id);
      return { wish: wishRow(db.prepare('SELECT * FROM wishes WHERE id = ?').get(id)), reward, replayed: false };
    });
  }

  function rejectWish(actor, ctx, id, body) {
    requireParent(actor);
    requireWrite(actor);
    const feedback = v.text(body.feedback, 'feedback', { required: true, max: 200 });
    return transaction(db, () => {
      const w = db.prepare('SELECT * FROM wishes WHERE id = ?').get(id);
      if (!w || !ctx.children.some((c) => c.id === w.child_id)) throw notFound('Wish not found.', 'wish_not_found');
      if (w.status === 'rejected') return wishRow(w);
      if (w.status !== 'proposed') throw conflict('This wish has already been decided.', 'already_decided', { status: w.status });
      db.prepare("UPDATE wishes SET status = 'rejected', feedback = ?, decided_by = ?, decided_at = ? WHERE id = ?")
        .run(feedback, actor.userId, nowIso(), id);
      return wishRow(db.prepare('SELECT * FROM wishes WHERE id = ?').get(id));
    });
  }

  // ------------------------------------------------------------------
  // Einloesungen
  // ------------------------------------------------------------------

  function redemptionRow(r) {
    return {
      id: r.id, child_id: r.child_id, reward_id: r.reward_id, title: r.title, icon: r.icon, image: r.image,
      stars: r.stars, status: r.status, feedback: r.feedback, created_at: r.created_at,
      decided_at: r.decided_at, fulfilled_at: r.fulfilled_at,
    };
  }

  function listRedemptions(actor, ctx, { status } = {}) {
    const states = ['pending', 'approved', 'rejected', 'cancelled', 'fulfilled'];
    if (status !== undefined && !states.includes(status)) throw invalid('Unknown status.', 'invalid_input', { field: 'status' });
    const filter = status ? 'AND status = @status' : '';
    if (actor.role === 'child') {
      return db.prepare(`SELECT * FROM redemptions WHERE child_id = @child ${filter} ORDER BY id DESC LIMIT 100`)
        .all({ child: actor.userId, ...(status ? { status } : {}) }).map(redemptionRow);
    }
    requireParent(actor);
    const ids = ctx.children.map((c) => c.id);
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM redemptions WHERE child_id IN (${ids.join(',')}) ${filter} ORDER BY id DESC LIMIT 200`)
      .all(status ? { status } : {}).map(redemptionRow);
  }

  /**
   * Ein Kind loest eine Belohnung ein. Preis, Berechtigung, Verfuegbarkeit und
   * Guthaben prueft der Server in derselben Transaktion, in der er reserviert.
   * `expected_stars` ist der Preis, den das Kind bestaetigt hat: hat er sich
   * inzwischen geaendert, wird nichts gebucht und die Seite zeigt den neuen.
   * Der Browser gibt damit nie einen Preis vor, er kann nur einen alten ablehnen.
   */
  function requestRedemption(actor, body) {
    requireChild(actor);
    requireWrite(actor);
    const childId = actor.userId;
    const rewardId = v.id(body.reward_id, 'reward_id');
    const requestId = v.requestId(body.request_id);
    const expected = body.expected_stars != null ? v.int(body.expected_stars, 'expected_stars', { min: 1, max: 100000 }) : null;
    try {
      return transaction(db, () => {
        const replay = db.prepare('SELECT * FROM redemptions WHERE child_id = ? AND request_id = ?').get(childId, requestId);
        if (replay) return { redemption: redemptionRow(replay), replayed: true, balance: balance(childId) };

        const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(rewardId);
        if (!r || !visibleToChild(r, childId, rewardChildren())) throw notFound('Reward not found.', 'reward_not_found');
        if (!r.available) throw conflict('This reward is not available right now.', 'reward_unavailable');
        if (expected != null && expected !== r.stars) throw conflict('The price has changed.', 'price_changed', { stars: r.stars });
        if (db.prepare("SELECT 1 FROM redemptions WHERE child_id = ? AND reward_id = ? AND status = 'pending'").get(childId, rewardId)) {
          throw conflict('You have already asked for this reward.', 'already_requested');
        }
        assertCovers(childId, r.stars);

        const res = db.prepare(`
          INSERT INTO redemptions (child_id, reward_id, title, icon, image, stars, status, request_id, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).run(childId, r.id, r.title, r.icon, r.image, r.stars, requestId, actor.userId, nowIso());
        const redemptionId = Number(res.lastInsertRowid);
        book({
          child_id: childId, kind: 'reserve', delta: -r.stars, reserved_delta: r.stars, reason: r.title,
          redemption_id: redemptionId, created_by: actor.userId,
        });
        return { redemption: redemptionRow(db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId)), replayed: false, balance: balance(childId) };
      });
    } catch (err) {
      if (!err.status && isConstraint(err)) throw conflict('You have already asked for this reward.', 'already_requested');
      throw err;
    }
  }

  /**
   * Entscheidungen ueber eine Einloesung:
   *   approve : pending  -> approved  (redeem: reservierte Sterne endgueltig eingeloest)
   *   reject  : pending  -> rejected  (release: Reservierung vollstaendig frei)
   *   cancel  : pending  -> cancelled (release; das Kind selbst oder Eltern)
   *   fulfill : approved -> fulfilled (Geschenk besorgt bzw. uebergeben, keine Buchung)
   *   revoke  : approved -> cancelled (refund: Eltern nehmen eine Genehmigung zurueck)
   */
  function decideRedemption(actor, ctx, id, action, body = {}) {
    requireWrite(actor);
    const feedback = v.text(body.feedback, 'feedback', { max: 200 });
    if (!['approve', 'reject', 'cancel', 'fulfill', 'revoke'].includes(action)) throw invalid('Unknown action.', 'invalid_input');
    if (action !== 'cancel') requireParent(actor);
    return transaction(db, () => {
      const r = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(id);
      const visible = r && (actor.role === 'child' ? r.child_id === actor.userId : actor.role === 'parent' && ctx.children.some((c) => c.id === r.child_id));
      if (!visible) throw notFound('Redemption not found.', 'redemption_not_found');

      const flow = {
        approve: { from: 'pending', to: 'approved' },
        reject: { from: 'pending', to: 'rejected' },
        cancel: { from: 'pending', to: 'cancelled' },
        fulfill: { from: 'approved', to: 'fulfilled' },
        revoke: { from: 'approved', to: 'cancelled' },
      }[action];
      if (r.status === flow.to && (action !== 'revoke' || db.prepare("SELECT 1 FROM ledger WHERE redemption_id = ? AND kind = 'refund'").get(id))) {
        return { redemption: redemptionRow(r), replayed: true, balance: balance(r.child_id) };
      }
      if (r.status !== flow.from) throw conflict('This request has already been decided.', 'already_decided', { status: r.status });

      const t = nowIso();
      if (action === 'fulfill') {
        db.prepare("UPDATE redemptions SET status = 'fulfilled', fulfilled_by = ?, fulfilled_at = ? WHERE id = ?").run(actor.userId, t, id);
      } else {
        db.prepare('UPDATE redemptions SET status = ?, feedback = ?, decided_by = ?, decided_at = ? WHERE id = ?')
          .run(flow.to, feedback, actor.userId, t, id);
      }
      const base = { child_id: r.child_id, reason: r.title, redemption_id: r.id, created_by: actor.userId, created_at: t };
      if (action === 'approve') {
        book({ ...base, kind: 'redeem', delta: 0, reserved_delta: -r.stars });
        // Das Ziel ist erreicht.
        db.prepare('DELETE FROM goals WHERE child_id = ? AND reward_id = ?').run(r.child_id, r.reward_id);
      } else if (action === 'reject' || action === 'cancel') {
        book({ ...base, kind: 'release', delta: r.stars, reserved_delta: -r.stars });
      } else if (action === 'revoke') {
        book({ ...base, kind: 'refund', delta: r.stars });
      }
      return { redemption: redemptionRow(db.prepare('SELECT * FROM redemptions WHERE id = ?').get(id)), replayed: false, balance: balance(r.child_id) };
    });
  }

  // ------------------------------------------------------------------
  // Uebersichten
  // ------------------------------------------------------------------

  function overview(actor, ctx) {
    requireParent(actor);
    const children = ctx.children.map((c) => {
      const t = today({ role: 'child', userId: c.id }, ctx, {});
      return {
        id: c.id, name: c.name, avatar_color: c.avatar_color,
        balance: t.balance,
        today_total: t.actions.reduce((n, a) => n + a.limit, 0),
        today_done: t.actions.reduce((n, a) => n + a.approved, 0),
        pending: t.pending.length,
        goal: t.goal,
      };
    });
    const ids = ctx.children.map((c) => c.id);
    const inList = ids.length ? `child_id IN (${ids.join(',')})` : '0';
    const count = (sql) => db.prepare(sql).get().n;
    return {
      day: ctx.day,
      children,
      counts: {
        completions: count(`SELECT COUNT(*) AS n FROM completions WHERE status = 'pending' AND ${inList}`),
        wishes: count(`SELECT COUNT(*) AS n FROM wishes WHERE status = 'proposed' AND ${inList}`),
        redemptions: count(`SELECT COUNT(*) AS n FROM redemptions WHERE status = 'pending' AND ${inList}`),
        to_fulfil: count(`SELECT COUNT(*) AS n FROM redemptions WHERE status = 'approved' AND ${inList}`),
      },
      actions: db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'active'").get().n,
      rewards: db.prepare('SELECT COUNT(*) AS n FROM rewards WHERE archived = 0').get().n,
    };
  }

  /** Kachel auf der Yuvomi-Uebersicht: Sternestand und offene Aktionen. */
  function summary(actor, ctx) {
    if (actor.role === 'child') {
      const t = today(actor, ctx, {});
      return {
        role: 'child', day: t.day, balance: t.balance, goal: t.goal,
        open: t.actions.filter((a) => a.remaining > 0).map((a) => ({ id: a.id, title: a.title, icon: a.icon, stars: a.stars, remaining: a.remaining })),
        pending: t.pending.length,
      };
    }
    if (actor.role === 'parent') {
      const o = overview(actor, ctx);
      return { role: 'parent', day: o.day, children: o.children, counts: o.counts };
    }
    return { role: 'other' };
  }

  return {
    getSettings, updateSettings, roleOf, rememberTimeZone, knownTimeZone,
    balance, ledgerList, bonus, correction,
    listActions, getAction, createAction, updateAction,
    today, reportCompletion, listCompletions, decideCompletion, cancelCompletion,
    listRewards, getReward, createReward: (actor, ctx, body) => transaction(db, () => createReward(actor, ctx, body)),
    updateReward, setRewardImage, imageInUse, mayViewImage,
    setGoal, goalOf,
    listWishes, proposeWish, withdrawWish, approveWish, rejectWish,
    listRedemptions, requestRedemption, decideRedemption,
    overview, summary,
  };
}

/** Zufaellige Id fuer Bilddateien. */
export function randomName() {
  return crypto.randomBytes(16).toString('hex');
}
