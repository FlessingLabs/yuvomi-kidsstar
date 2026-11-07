/**
 * KidsStar - Was der Dienst von Yuvomi wissen muss
 *
 * Der Browser ist kein vertrauenswuerdiger Aufrufer (MODULES.md, "Modules With A
 * Backend Service"): Wer jemand ist und was er darf, sagt allein Yuvomi auf
 * GET /api/v1/auth/me, gefragt mit dem Session-Cookie der Anfrage. Eine
 * Benutzer-Id oder Rolle aus dem Anfragekoerper wird nie gelesen.
 *
 * Ebenso aus Yuvomi, mit derselben Sitzung:
 *   - die Mitglieder des Haushalts (GET /api/v1/family/members) - wer ein Kind ist,
 *   - die Zeitzone des Haushalts (GET /api/v1/preferences, timezone_effective).
 *
 * Alle Antworten werden kurz zwischengespeichert: Yuvomi begrenzt /api/ auf
 * 300 Anfragen je Minute und IP, und ohne Cache verbraucht der Dienst dieses
 * Budget fuer alle Mitglieder zugleich. /auth/me je Session-Cookie fuer wenige
 * Sekunden (eine Abmeldung wirkt damit gleich), Mitglieder und Zeitzone
 * haushaltsweit etwas laenger - sie sind fuer jedes Mitglied dieselben.
 */

import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { isValidTimeZone } from './time.js';

export const MODULE_ID = 'kidsstar';
export const PERMISSION_KEY = `ext:${MODULE_ID}`;

/** Liest ein Cookie aus dem Cookie-Header; null, wenn es fehlt. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * Zugriffsstufe aus der /auth/me-Antwort: 'none' | 'read' | 'write'.
 *
 * Fehlt der Schluessel, ist das Modul in Yuvomi nicht (mehr) aktiv -
 * abgeschaltet oder entfernt: Yuvomi fuehrt im Rechtekatalog nur aktive
 * Erweiterungen. Das ist 'none', nicht der Standard 'write'. So sperrt das
 * Abschalten in Yuvomi auch den Dienst, obwohl er selbst erreichbar bleibt.
 */
export function accessLevel(me) {
  const level = me?.permissions?.modules?.[PERMISSION_KEY];
  return level === 'read' || level === 'write' ? level : 'none';
}

function unavailable(what, status) {
  const err = new HttpError(502, `Yuvomi ${what} answered ${status}`, 'yuvomi_unavailable');
  return err;
}

export function createYuvomiClient({
  yuvomiUrl, sessionCookie = 'yuvomi.sid', cacheMs = 5000, householdCacheMs = 30000,
  fallbackTimeZone = process.env.TZ || 'Europe/Berlin', fetchImpl = fetch, now = Date.now,
  apiToken = '', serviceCacheMs = 5000,
}) {
  const identities = new Map();
  let members = null; // { value, expires }
  let zone = null;    // { value, expires }

  function headersFor(req, sid) {
    const headers = { cookie: `${sessionCookie}=${sid}`, accept: 'application/json' };
    // Die Adresse des Mitglieds weiterreichen: steht Yuvomi mit TRUST_PROXY
    // hinter demselben Proxy, zaehlt das Ratenlimit dann je Mitglied.
    if (req.headers['x-forwarded-for']) headers['x-forwarded-for'] = req.headers['x-forwarded-for'];
    return headers;
  }

  async function get(path, req, sid) {
    try {
      return await fetchImpl(new URL(path, yuvomiUrl), { headers: headersFor(req, sid), redirect: 'manual' });
    } catch {
      throw new HttpError(502, 'Yuvomi is not reachable from the KidsStar service.', 'yuvomi_unavailable');
    }
  }

  function prune(t) {
    if (identities.size < 500) return;
    for (const [k, val] of identities) if (val.expires <= t) identities.delete(k);
  }

  /**
   * @returns {Promise<null | { userId, name, admin, familyRole, access, sid }>}
   *          null heisst: nicht angemeldet.
   */
  async function identify(req) {
    const sid = readCookie(req.headers.cookie, sessionCookie);
    if (!sid) return null;
    const key = crypto.createHash('sha256').update(sid).digest('hex');
    const t = now();
    const hit = identities.get(key);
    if (hit && hit.expires > t) return hit.value && { ...hit.value, sid };

    const res = await get('/api/v1/auth/me', req, sid);
    let value = null;
    if (res.ok) {
      const me = await res.json();
      const u = me?.user;
      if (Number.isInteger(u?.id)) {
        value = {
          userId: u.id,
          name: String(u.display_name || u.username || ''),
          admin: me?.permissions?.admin === true,
          familyRole: typeof u.family_role === 'string' ? u.family_role : 'other',
          access: accessLevel(me),
        };
      }
    } else if (res.status !== 401 && res.status !== 403) {
      throw unavailable('/auth/me', res.status);
    }
    prune(t);
    identities.set(key, { value, expires: t + cacheMs });
    return value && { ...value, sid };
  }

  /** Die Kinder des Haushalts (Familienrolle "Kind"), in Yuvomis Mitgliederreihenfolge. */
  async function children(req, identity) {
    const t = now();
    if (!members || members.expires <= t) {
      const res = await get('/api/v1/family/members', req, identity.sid);
      if (!res.ok) throw unavailable('/family/members', res.status);
      const body = await res.json();
      const list = Array.isArray(body?.data) ? body.data : [];
      members = {
        value: list
          .filter((m) => Number.isInteger(m?.id))
          .map((m) => ({
            id: m.id,
            name: String(m.display_name || ''),
            avatar_color: /^#[0-9a-fA-F]{6}$/.test(m.avatar_color || '') ? m.avatar_color : null,
            family_role: m.family_role,
          })),
        expires: t + householdCacheMs,
      };
    }
    return members.value.filter((m) => m.family_role === 'child').map(({ family_role, ...rest }) => rest);
  }

  async function timeZone(req, identity) {
    const t = now();
    if (!zone || zone.expires <= t) {
      let value = fallbackTimeZone;
      try {
        const res = await get('/api/v1/preferences', req, identity.sid);
        if (res.ok) {
          const tz = (await res.json())?.data?.timezone_effective;
          if (isValidTimeZone(tz)) value = tz;
        }
      } catch {
        // Ohne Antwort die Zone des Dienstes; /auth/me hat schon geantwortet.
      }
      zone = { value, expires: t + householdCacheMs };
    }
    return zone.value;
  }

  // ------------------------------------------------------------------
  // Ohne Sitzung: das Flurtablet
  //
  // Am Tablet ist niemand bei Yuvomi angemeldet. Wer ein Kind ist und ob
  // KidsStar im Haushalt noch eingeschaltet ist, fragt der Dienst dann mit
  // einem API-Token (Einstellungen -> Haushalt -> API-Zugang, Scopes
  // `ext:kidsstar:read` und `family:read`), wie MODULES.md es fuer Arbeit ohne
  // Sitzung vorsieht. Ohne Token gibt es keinen Tablet-Modus: lieber keiner
  // als einer, der ein abgeschaltetes Modul nicht bemerkt.
  //
  // Ein Token mit Scopes erreicht /api/v1/auth/me nicht (Yuvomi sperrt /auth
  // fuer gescopte Tokens, GHSA-xcv5-6w6x-x5q2). Ob KidsStar eingeschaltet ist,
  // zeigt stattdessen Yuvomis Scope-Pruefung selbst: den Scope `ext:kidsstar`
  // gibt es nur, solange das Modul eingeschaltet ist, und er gehoert zum Pfad
  // /api/v1/extensions/kidsstar/. Dort liegt keine Route - eingeschaltet
  // antwortet Yuvomi 404 (Scope bekannt, nichts da), ausgeschaltet 403 (Scope
  // unbekannt, abgewiesen). Jede andere Antwort gilt als "nicht eingeschaltet"
  // bzw. "nicht erreichbar": der Tablet-Modus schliesst im Zweifel.
  // ------------------------------------------------------------------

  let service = null; // { value, expires }

  async function serviceGet(path) {
    try {
      return await fetchImpl(new URL(path, yuvomiUrl), {
        headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
        redirect: 'manual',
      });
    } catch {
      throw new HttpError(502, 'Yuvomi is not reachable from the KidsStar service.', 'yuvomi_unavailable');
    }
  }

  /**
   * @returns {Promise<{ enabled: boolean, children: Array }>}
   */
  async function householdView() {
    if (!apiToken) throw new HttpError(503, 'The hallway tablet needs YUVOMI_API_TOKEN on the KidsStar service.', 'tablet_not_configured');
    const t = now();
    if (service && service.expires > t) return service.value;

    const res = await serviceGet('/api/v1/family/members');
    if (res.status === 401) throw new HttpError(503, 'Yuvomi rejected the KidsStar API token.', 'tablet_token_invalid');
    if (res.status === 403) throw new HttpError(503, 'The KidsStar API token needs the scope family:read.', 'tablet_token_scope');
    if (!res.ok) throw unavailable('/family/members', res.status);
    const body = await res.json();
    const kids = (Array.isArray(body?.data) ? body.data : [])
      .filter((m) => Number.isInteger(m?.id) && m.family_role === 'child')
      .map((m) => ({ id: m.id, name: String(m.display_name || ''), avatar_color: /^#[0-9a-fA-F]{6}$/.test(m.avatar_color || '') ? m.avatar_color : null }));

    const probe = await serviceGet(`/api/v1/extensions/${MODULE_ID}/state`);
    if (probe.status >= 500) throw unavailable('/extensions probe', probe.status);
    const enabled = probe.status === 404;

    service = { value: { enabled, children: enabled ? kids : [] }, expires: t + serviceCacheMs };
    return service.value;
  }

  return { identify, children, timeZone, householdView, tabletConfigured: () => Boolean(apiToken) };
}
