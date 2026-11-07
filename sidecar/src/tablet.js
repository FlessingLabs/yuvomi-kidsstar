/**
 * KidsStar - Flurtablet ("Wer bist du?")
 *
 * Ein gemeinsam genutztes Tablet ist kein Yuvomi-Mitglied und bekommt keine
 * Yuvomi-Sitzung. Es bekommt zwei eigene, auf KidsStar beschraenkte Sitzungen:
 *
 *   Geraet  - entsteht nur aus einem Kopplungscode, den ein Elternteil in einer
 *             regulaeren Yuvomi-Sitzung erzeugt hat. Das Geraet darf die
 *             freigegebenen Profile zeigen, sonst nichts.
 *   Kind    - entsteht, wenn auf dem Geraet eine Bildkachel angetippt (und ggf.
 *             der Bildcode eingegeben) wurde. Wer das aktive Kind ist, steht nur
 *             in dieser Zeile auf dem Server, nie in einer Angabe des Browsers.
 *             Kurze Leerlaufzeit; ein Profilwechsel beendet sie.
 *
 * Beide Geheimnisse liegen nur als SHA-256 in der Datenbank. Ein Kind am Tablet
 * hat genau die Rechte eines Kindes in KidsStar (melden, ansehen, wuenschen,
 * einloesen anfragen) - nie Elternrechte, nie Yuvomi-Zugriff.
 */

import crypto from 'node:crypto';
import { transaction } from './db.js';
import { forbidden, invalid, notFound, HttpError } from './errors.js';
import * as v from './validate.js';

export const CODE_SYMBOLS = 9;     // Bildcode: vier aus neun Symbolen
export const CODE_LENGTH = 4;
export const MAX_CODE_FAILURES = 5;
export const CODE_LOCK_MS = 5 * 60 * 1000;
export const PAIRING_TTL_MS = 15 * 60 * 1000;
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function newPairingCode() {
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normalizePairingCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code, salt) {
  return crypto.scryptSync(code.join('-'), salt, 32).toString('hex');
}

function parseCode(value) {
  if (!Array.isArray(value) || value.length !== CODE_LENGTH) {
    throw invalid(`The picture code has ${CODE_LENGTH} symbols.`, 'invalid_code', { field: 'code' });
  }
  return value.map((x) => v.int(x, 'code', { min: 0, max: CODE_SYMBOLS - 1 }));
}

export function createTablet(db, { now = () => Date.now() } = {}) {
  const iso = (ms = now()) => new Date(ms).toISOString();

  function requireParentWrite(actor) {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    if (actor.access !== 'write') throw forbidden('KidsStar is read-only for you.', 'read_only');
  }
  function requireKnownChild(ctx, childId) {
    if (!ctx.children.some((c) => c.id === childId)) throw invalid('Not a child of this household.', 'not_a_child', { child_id: childId });
  }

  // ------------------------------------------------------------------
  // Profile (Bild, Symbol, Farbe, Bildcode) - Verwaltung durch Eltern
  // ------------------------------------------------------------------

  function profileRow(childId) {
    return db.prepare('SELECT * FROM child_profiles WHERE child_id = ?').get(childId) ?? null;
  }

  function publicProfile(child, row) {
    return {
      child_id: child.id,
      name: child.name,
      avatar_color: child.avatar_color ?? null,
      image: row?.image ?? null,
      symbol: row?.symbol ?? '',
      color: row?.color ?? '',
      has_code: Boolean(row?.code_hash),
    };
  }

  function listProfiles(actor, ctx) {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    return ctx.children.map((c) => publicProfile(c, profileRow(c.id)));
  }

  function ensureProfile(childId) {
    db.prepare('INSERT INTO child_profiles (child_id, updated_at) VALUES (?, ?) ON CONFLICT(child_id) DO NOTHING').run(childId, iso());
  }

  function updateProfile(actor, ctx, childId, body) {
    requireParentWrite(actor);
    requireKnownChild(ctx, childId);
    const sets = {};
    if (body.symbol !== undefined) sets.symbol = v.icon(body.symbol, 'symbol');
    if (body.color !== undefined) {
      const c = String(body.color ?? '');
      if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw invalid('color must be #RRGGBB.', 'invalid_input', { field: 'color' });
      sets.color = c;
    }
    if (body.code !== undefined) {
      if (body.code === null) {
        sets.code_hash = null;
        sets.code_salt = null;
      } else {
        const code = parseCode(body.code);
        const salt = crypto.randomBytes(16).toString('hex');
        sets.code_hash = hashCode(code, salt);
        sets.code_salt = salt;
      }
    }
    return transaction(db, () => {
      ensureProfile(childId);
      const keys = Object.keys(sets);
      if (keys.length) {
        db.prepare(`UPDATE child_profiles SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE child_id = @id`)
          .run({ ...sets, t: iso(), id: childId });
      }
      if ('code_hash' in sets) db.prepare('DELETE FROM code_attempts WHERE child_id = ?').run(childId);
      return publicProfile(ctx.children.find((c) => c.id === childId), profileRow(childId));
    });
  }

  function setProfileImage(actor, ctx, childId, filename) {
    requireParentWrite(actor);
    requireKnownChild(ctx, childId);
    return transaction(db, () => {
      ensureProfile(childId);
      const previous = profileRow(childId).image;
      db.prepare('UPDATE child_profiles SET image = ?, updated_at = ? WHERE child_id = ?').run(filename, iso(), childId);
      return { profile: publicProfile(ctx.children.find((c) => c.id === childId), profileRow(childId)), previous };
    });
  }

  function profileImageOwner(filename) {
    return db.prepare('SELECT child_id FROM child_profiles WHERE image = ?').get(filename)?.child_id ?? null;
  }

  // ------------------------------------------------------------------
  // Geraete - Verwaltung durch Eltern
  // ------------------------------------------------------------------

  function deviceChildren(deviceId) {
    return db.prepare('SELECT child_id FROM device_children WHERE device_id = ? ORDER BY child_id').all(deviceId).map((r) => r.child_id);
  }

  function publicDevice(d) {
    const t = now();
    return {
      id: d.id,
      name: d.name,
      child_ids: deviceChildren(d.id),
      idle_seconds: d.idle_seconds,
      paired: Boolean(d.token_hash),
      pairing_open: Boolean(d.pairing_hash && d.pairing_expires && Date.parse(d.pairing_expires) > t),
      pairing_expires: d.pairing_expires,
      created_at: d.created_at,
      paired_at: d.paired_at,
      last_seen_at: d.last_seen_at,
      revoked_at: d.revoked_at,
    };
  }

  function getDevice(id) {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!d || d.revoked_at) throw notFound('Tablet not found.', 'device_not_found');
    return d;
  }

  function listDevices(actor) {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    return db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY id').all().map(publicDevice);
  }

  function deviceFields(body, ctx, { partial }) {
    const out = {};
    if (!partial || body.name !== undefined) out.name = v.text(body.name, 'name', { required: true, max: 60 });
    if (!partial || body.idle_seconds !== undefined) out.idle_seconds = v.int(body.idle_seconds ?? 120, 'idle_seconds', { min: 30, max: 1800 });
    let childIds;
    if (!partial || body.child_ids !== undefined) {
      childIds = v.idList(body.child_ids ?? [], 'child_ids');
      for (const id of childIds) requireKnownChild(ctx, id);
    }
    return { fields: out, childIds };
  }

  function replaceChildren(deviceId, childIds) {
    db.prepare('DELETE FROM device_children WHERE device_id = ?').run(deviceId);
    const ins = db.prepare('INSERT INTO device_children (device_id, child_id) VALUES (?, ?)');
    for (const c of childIds) ins.run(deviceId, c);
    // Ein Kind, das nicht mehr freigegeben ist, verliert seine laufende Sitzung sofort.
    db.prepare(`
      UPDATE kid_sessions SET ended_at = ?, end_reason = 'profile_removed'
      WHERE device_id = ? AND ended_at IS NULL AND child_id NOT IN (SELECT child_id FROM device_children WHERE device_id = ?)
    `).run(iso(), deviceId, deviceId);
  }

  /** Neues Tablet: liefert den Kopplungscode genau einmal im Klartext. */
  function createDevice(actor, ctx, body) {
    requireParentWrite(actor);
    const { fields, childIds } = deviceFields(body, ctx, { partial: false });
    const code = newPairingCode();
    return transaction(db, () => {
      const res = db.prepare(`
        INSERT INTO devices (name, idle_seconds, pairing_hash, pairing_expires, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fields.name, fields.idle_seconds, sha256(normalizePairingCode(code)), iso(now() + PAIRING_TTL_MS), actor.userId, iso());
      const id = Number(res.lastInsertRowid);
      replaceChildren(id, childIds);
      return { device: publicDevice(getDevice(id)), pairing_code: code };
    });
  }

  function updateDevice(actor, ctx, id, body) {
    requireParentWrite(actor);
    const { fields, childIds } = deviceFields(body, ctx, { partial: true });
    return transaction(db, () => {
      getDevice(id);
      const keys = Object.keys(fields);
      if (keys.length) db.prepare(`UPDATE devices SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
      if (childIds) replaceChildren(id, childIds);
      return publicDevice(getDevice(id));
    });
  }

  /** Neu koppeln (anderes Tablet, verlorenes Cookie): neuer Code, die alte Kopplung endet beim Einloesen. */
  function renewPairing(actor, id) {
    requireParentWrite(actor);
    const code = newPairingCode();
    return transaction(db, () => {
      getDevice(id);
      db.prepare('UPDATE devices SET pairing_hash = ?, pairing_expires = ? WHERE id = ?')
        .run(sha256(normalizePairingCode(code)), iso(now() + PAIRING_TTL_MS), id);
      return { device: publicDevice(getDevice(id)), pairing_code: code };
    });
  }

  /** Widerruf: das Geraetegeheimnis wird ungueltig, alle Kindersitzungen enden. */
  function revokeDevice(actor, id) {
    requireParentWrite(actor);
    return transaction(db, () => {
      getDevice(id);
      const t = iso();
      db.prepare('UPDATE devices SET token_hash = NULL, pairing_hash = NULL, pairing_expires = NULL, revoked_at = ?, revoked_by = ? WHERE id = ?')
        .run(t, actor.userId, id);
      db.prepare("UPDATE kid_sessions SET ended_at = ?, end_reason = 'device_revoked' WHERE device_id = ? AND ended_at IS NULL").run(t, id);
      return { id, revoked: true };
    });
  }

  // ------------------------------------------------------------------
  // Am Tablet
  // ------------------------------------------------------------------

  /** Kopplungscode einloesen. Liefert das Geraetegeheimnis (fuer das Cookie). */
  function pair(rawCode) {
    const code = normalizePairingCode(rawCode);
    if (code.length !== 8) throw invalid('The pairing code has 8 characters.', 'invalid_pairing_code');
    return transaction(db, () => {
      const d = db.prepare('SELECT * FROM devices WHERE pairing_hash = ? AND revoked_at IS NULL').get(sha256(code));
      if (!d || !d.pairing_expires || Date.parse(d.pairing_expires) <= now()) {
        throw new HttpError(403, 'Unknown or expired pairing code.', 'pairing_invalid');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const t = iso();
      db.prepare('UPDATE devices SET token_hash = ?, pairing_hash = NULL, pairing_expires = NULL, paired_at = ?, last_seen_at = ? WHERE id = ?')
        .run(sha256(token), t, t, d.id);
      // Eine fruehere Kopplung desselben Eintrags endet hier samt ihren Kindersitzungen.
      db.prepare("UPDATE kid_sessions SET ended_at = ?, end_reason = 'device_repaired' WHERE device_id = ? AND ended_at IS NULL").run(t, d.id);
      return { device_id: d.id, token };
    });
  }

  function deviceByToken(token) {
    if (!token) return null;
    const d = db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token));
    if (!d) return null;
    // Hoechstens einmal je Minute schreiben.
    if (!d.last_seen_at || now() - Date.parse(d.last_seen_at) > 60000) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(iso(), d.id);
    }
    return { id: d.id, name: d.name, idle_seconds: d.idle_seconds, child_ids: deviceChildren(d.id) };
  }

  /** Die Kacheln: nur freigegebene Kinder, die Yuvomi weiterhin als Kind fuehrt. */
  function tiles(device, children) {
    return children
      .filter((c) => device.child_ids.includes(c.id))
      .map((c) => {
        const p = publicProfile(c, profileRow(c.id));
        return { child_id: p.child_id, name: p.name, image: p.image, symbol: p.symbol, color: p.color || p.avatar_color || '', has_code: p.has_code };
      });
  }

  function codeState(deviceId, childId) {
    return db.prepare('SELECT * FROM code_attempts WHERE device_id = ? AND child_id = ?').get(deviceId, childId);
  }

  /**
   * Profil oeffnen. `children` sind die aktuellen Kinder laut Yuvomi; ein Kind,
   * das dort fehlt oder nicht freigegeben ist, laesst sich nicht oeffnen.
   */
  function startKidSession(device, children, childIdRaw, codeRaw) {
    const childId = v.id(childIdRaw, 'child_id');
    if (!device.child_ids.includes(childId) || !children.some((c) => c.id === childId)) {
      throw notFound('Profile not found.', 'profile_not_found');
    }
    // Pruefen und Zaehlen in einer Transaktion: parallele Versuche zaehlen alle.
    const result = transaction(db, () => {
      const p = profileRow(childId);
      if (p?.code_hash) {
        const st = codeState(device.id, childId);
        if (st?.locked_until && Date.parse(st.locked_until) > now()) {
          return { locked: Date.parse(st.locked_until) };
        }
        if (codeRaw === undefined || codeRaw === null) return { codeRequired: true };
        let ok = false;
        try {
          const code = parseCode(codeRaw);
          ok = crypto.timingSafeEqual(Buffer.from(hashCode(code, p.code_salt), 'hex'), Buffer.from(p.code_hash, 'hex'));
        } catch {
          ok = false; // auch eine kaputte Eingabe ist ein Fehlversuch
        }
        if (!ok) {
          const failures = (st?.locked_until && Date.parse(st.locked_until) <= now() ? 0 : (st?.failures ?? 0)) + 1;
          const locked = failures >= MAX_CODE_FAILURES ? iso(now() + CODE_LOCK_MS) : null;
          db.prepare(`
            INSERT INTO code_attempts (device_id, child_id, failures, locked_until) VALUES (?, ?, ?, ?)
            ON CONFLICT(device_id, child_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until
          `).run(device.id, childId, locked ? 0 : failures, locked);
          return { wrong: true, remaining: locked ? 0 : MAX_CODE_FAILURES - failures, locked: locked ? Date.parse(locked) : null };
        }
        db.prepare('DELETE FROM code_attempts WHERE device_id = ? AND child_id = ?').run(device.id, childId);
      }
      const t = iso();
      // Ein Tablet, ein aktives Kind: jede vorherige Sitzung auf dem Geraet endet.
      db.prepare("UPDATE kid_sessions SET ended_at = ?, end_reason = 'switched' WHERE device_id = ? AND ended_at IS NULL").run(t, device.id);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO kid_sessions (token_hash, device_id, child_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(token), device.id, childId, t, t);
      return { token, child_id: childId };
    });
    if (result.codeRequired) throw new HttpError(401, 'This profile needs its picture code.', 'code_required');
    if (result.wrong && !result.locked) throw new HttpError(401, 'Wrong picture code.', 'code_wrong', { remaining: result.remaining });
    if (result.locked) throw new HttpError(429, 'Too many wrong codes. Try again later.', 'code_locked', { retry_at: iso(result.locked) });
    return result;
  }

  /**
   * Die laufende Kindersitzung zu einem Geraet, oder null. Prueft Geraet,
   * Freigabe, Kindstatus in Yuvomi und Leerlaufzeit; beruehrt last_seen.
   */
  function kidSession(device, children, token, { touch = true } = {}) {
    if (!token) return null;
    const s = db.prepare('SELECT * FROM kid_sessions WHERE token_hash = ?').get(sha256(token));
    if (!s || s.ended_at || s.device_id !== device.id) return null;
    const end = (reason) => {
      db.prepare('UPDATE kid_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(iso(), reason, s.id);
      return null;
    };
    if (now() - Date.parse(s.last_seen_at) > device.idle_seconds * 1000) return end('idle');
    if (!device.child_ids.includes(s.child_id)) return end('profile_removed');
    if (!children.some((c) => c.id === s.child_id)) return end('not_a_child');
    if (touch) db.prepare('UPDATE kid_sessions SET last_seen_at = ? WHERE id = ?').run(iso(), s.id);
    const child = children.find((c) => c.id === s.child_id);
    return { id: s.id, child_id: s.child_id, name: child.name };
  }

  function endKidSession(device, token, reason = 'switched') {
    if (!token) return;
    db.prepare('UPDATE kid_sessions SET ended_at = ?, end_reason = ? WHERE token_hash = ? AND device_id = ? AND ended_at IS NULL')
      .run(iso(), reason, sha256(token), device.id);
  }

  return {
    listProfiles, updateProfile, setProfileImage, profileImageOwner,
    listDevices, createDevice, updateDevice, renewPairing, revokeDevice,
    pair, deviceByToken, tiles, startKidSession, kidSession, endKidSession,
  };
}

