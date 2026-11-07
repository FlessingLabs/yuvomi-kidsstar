/**
 * KidsStar - Routen des Flurtablets unter /api/extensions/kidsstar/tablet
 *
 * Yuvomi bietet Modulen keine oeffentliche Route: eine Modulseite (/m/<id>)
 * und ihre Dateien gibt es nur mit Yuvomi-Sitzung. Das Tablet hat keine, also
 * liefert der Dienst die Seite selbst aus, auf derselben Origin und unter
 * seinem eigenen Pfad (den Yuvomis Service Worker nicht zwischenspeichert).
 *
 *   /tablet/                  die Seite (HTML, JS, CSS aus public/tablet)
 *   /tablet/api/pair          Kopplungscode einloesen -> Geraete-Cookie
 *   /tablet/api/state         Kacheln der freigegebenen Kinder, aktives Kind
 *   /tablet/api/session       Profil oeffnen (POST) / wechseln (DELETE)
 *   /tablet/api/...           was ein Kind darf: heute, melden, Sterne,
 *                             Verlauf, Shop, Wuensche, Einloesen anfragen
 *
 * Jede Anfrage prueft, ob das Geraet gekoppelt und nicht widerrufen ist und
 * ob KidsStar in Yuvomi eingeschaltet ist (API-Token, yuvomi.js). Jede
 * Kind-Anfrage prueft zusaetzlich die Kindersitzung (Freigabe, Leerlauf). Das
 * aktive Kind kommt nur aus dieser Sitzung.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError, forbidden } from './errors.js';
import { readCookie, MODULE_ID } from './yuvomi.js';
import { householdDay } from './time.js';

export const TABLET_PREFIX = '/tablet';
export const DEVICE_COOKIE = 'kidsstar-device';
export const KID_COOKIE = 'kidsstar-kid';
export const TABLET_CSRF_COOKIE = 'kidsstar-tablet-csrf';
const CSRF_HEADER = 'x-kidsstar-csrf';
const COOKIE_PATH = `/api/extensions/${MODULE_ID}${TABLET_PREFIX}`;
const DEVICE_MAX_AGE = 400 * 24 * 3600;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function loadStatic() {
  const out = new Map();
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    out.set(route, { body: fs.readFileSync(new URL(`../public/tablet/${file}`, import.meta.url)), type });
  }
  return out;
}

/** Fehlgeschlagene Kopplungsversuche je Adresse begrenzen (10 je 10 Minuten). */
function createLimiter({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  const live = (key) => {
    const e = hits.get(key);
    return e && e.reset > now() ? e : null;
  };
  return {
    allowed: (key) => (live(key)?.count ?? 0) < max,
    fail(key) {
      const e = live(key);
      if (e) e.count += 1;
      else hits.set(key, { count: 1, reset: now() + windowMs });
      if (hits.size > 1000) for (const [k, val] of hits) if (val.reset <= now()) hits.delete(k);
    },
  };
}

export function createTabletRoutes({ service, tablet, yuvomi, images, profileImages, publicOrigins, clock, helpers }) {
  const { send, readJson, safeEqual, expectedOrigins, isSecure, parseId } = helpers;
  const files = loadStatic();
  const pairLimit = createLimiter();

  function cookie(req, name, value, { maxAge } = {}) {
    return [
      `${name}=${value}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict',
      ...(maxAge != null ? [`Max-Age=${maxAge}`] : []),
      ...(isSecure(req) ? ['Secure'] : []),
    ].join('; ');
  }

  function requireOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || !expectedOrigins(req, publicOrigins).includes(origin)) {
      throw new HttpError(403, 'Origin not allowed.', 'origin_mismatch');
    }
  }
  function requireCsrf(req) {
    requireOrigin(req);
    const c = readCookie(req.headers.cookie, TABLET_CSRF_COOKIE);
    const h = req.headers[CSRF_HEADER];
    if (!c || !h || !safeEqual(c, h)) throw new HttpError(403, 'Invalid CSRF token.', 'csrf_invalid');
  }

  /** Geraet + Haushaltszustand. Ohne gekoppeltes Geraet: 401 device_unpaired. */
  async function device(req) {
    const d = tablet.deviceByToken(readCookie(req.headers.cookie, DEVICE_COOKIE));
    if (!d) throw new HttpError(401, 'This tablet is not paired.', 'device_unpaired');
    const view = await yuvomi.householdView();
    if (!view.enabled) throw forbidden('KidsStar is switched off in Yuvomi.', 'module_forbidden');
    return { device: d, children: view.children };
  }

  /** Das aktive Kind - nur aus der Kindersitzung. */
  async function kid(req) {
    const { device: d, children } = await device(req);
    const s = tablet.kidSession(d, children, readCookie(req.headers.cookie, KID_COOKIE));
    if (!s) throw new HttpError(401, 'Choose your picture first.', 'kid_session_required');
    const tz = service.knownTimeZone() || process.env.TZ || 'Europe/Berlin';
    const { day, weekday } = householdDay(clock(), tz);
    const actor = { userId: s.child_id, name: s.name, role: 'child', access: 'write', admin: false, via: 'tablet' };
    return { actor, ctx: { day, weekday, timeZone: tz, children: [] }, device: d };
  }

  // Was ein Kind am Tablet darf - dieselben Funktionen wie in der Kinderansicht,
  // mit einem Akteur, der nur aus der Kindersitzung stammt.
  const KID = [
    ['GET', /^\/today$/, ({ actor, ctx }) => service.today(actor, ctx, {})],
    ['GET', /^\/ledger$/, ({ actor, ctx, url }) => service.ledgerList(actor, ctx, { limit: url.searchParams.get('limit') ?? 30, before: url.searchParams.get('before') ?? undefined })],
    ['GET', /^\/rewards$/, ({ actor, ctx }) => ({ child_id: actor.userId, items: service.listRewards(actor, ctx) })],
    ['GET', /^\/wishes$/, ({ actor, ctx }) => ({ child_id: actor.userId, items: service.listWishes(actor, ctx) })],
    ['GET', /^\/redemptions$/, ({ actor, ctx }) => ({ child_id: actor.userId, items: service.listRedemptions(actor, ctx) })],
    ['POST', /^\/completions$/, ({ actor, ctx, body }) => service.reportCompletion(actor, ctx, body)],
    ['POST', /^\/completions\/([^/]+)\/cancel$/, ({ actor, m }) => service.cancelCompletion(actor, parseId(m[1]))],
    ['POST', /^\/wishes$/, ({ actor, body }) => service.proposeWish(actor, body)],
    ['POST', /^\/wishes\/([^/]+)\/withdraw$/, ({ actor, m }) => service.withdrawWish(actor, parseId(m[1]))],
    ['POST', /^\/redemptions$/, ({ actor, body }) => service.requestRedemption(actor, body)],
    ['POST', /^\/redemptions\/([^/]+)\/cancel$/, ({ actor, ctx, m }) => service.decideRedemption(actor, ctx, parseId(m[1]), 'cancel', {})],
    ['PUT', /^\/goal$/, ({ actor, ctx, body }) => service.setGoal(actor, ctx, body)],
  ];

  return async function tabletRoutes(req, res, pathname, url) {
    const sub = pathname.slice(TABLET_PREFIX.length) || '/';
    const method = req.method;

    if (sub === '/' && pathname === TABLET_PREFIX) {
      // Ohne Schraegstrich wuerden relative Pfade der Seite falsch aufgeloest.
      res.writeHead(308, { location: `${COOKIE_PATH}/`, 'cache-control': 'no-store' });
      return res.end();
    }
    const file = files.get(sub);
    if (file && method === 'GET') {
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        'content-security-policy': PAGE_CSP,
        'x-frame-options': 'DENY',
      });
      return res.end(file.body);
    }

    if (!sub.startsWith('/api/')) throw new HttpError(404, 'Not found.', 'not_found');
    const api = sub.slice(4);

    if (api === '/pair' && method === 'POST') {
      requireOrigin(req);
      const ip = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '';
      if (!pairLimit.allowed(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'rate_limited');
      const body = await readJson(req);
      // Erst den Haushalt fragen: ohne Token oder bei abgeschaltetem Modul gibt es keine Kopplung.
      const view = await yuvomi.householdView();
      if (!view.enabled) throw forbidden('KidsStar is switched off in Yuvomi.', 'module_forbidden');
      let token;
      try {
        ({ token } = tablet.pair(body.code));
      } catch (err) {
        pairLimit.fail(ip);
        throw err;
      }
      return send(res, 201, { data: { paired: true } }, {
        'set-cookie': [cookie(req, DEVICE_COOKIE, token, { maxAge: DEVICE_MAX_AGE }), cookie(req, KID_COOKIE, '', { maxAge: 0 })],
      });
    }

    if (api === '/state' && method === 'GET') {
      const d = tablet.deviceByToken(readCookie(req.headers.cookie, DEVICE_COOKIE));
      if (!d) return send(res, 200, { data: { paired: false } });
      const { device: dev, children } = await device(req);
      const s = tablet.kidSession(dev, children, readCookie(req.headers.cookie, KID_COOKIE), { touch: false });
      return send(res, 200, {
        data: {
          paired: true,
          device: { name: dev.name, idle_seconds: dev.idle_seconds },
          profiles: tablet.tiles(dev, children),
          active: s ? { child_id: s.child_id, name: s.name } : null,
        },
      });
    }

    if (api === '/csrf' && method === 'GET') {
      await device(req);
      const token = crypto.randomBytes(32).toString('base64url');
      return send(res, 200, { data: { token } }, { 'set-cookie': cookie(req, TABLET_CSRF_COOKIE, token) });
    }

    if (api === '/session' && method === 'POST') {
      requireCsrf(req);
      const { device: d, children } = await device(req);
      const body = await readJson(req);
      const { token, child_id } = tablet.startKidSession(d, children, body.child_id, body.code);
      return send(res, 201, { data: { child_id } }, { 'set-cookie': cookie(req, KID_COOKIE, token) });
    }
    if (api === '/session' && method === 'DELETE') {
      requireCsrf(req);
      const d = tablet.deviceByToken(readCookie(req.headers.cookie, DEVICE_COOKIE));
      if (d) tablet.endKidSession(d, readCookie(req.headers.cookie, KID_COOKIE), endReason(url));
      return send(res, 200, { data: { ended: true } }, { 'set-cookie': cookie(req, KID_COOKIE, '', { maxAge: 0 }) });
    }

    // Kachelbild: nur fuer ein gekoppeltes Geraet, dem dieses Kind freigegeben ist.
    let m = api.match(/^\/profile-images\/([^/]+)$/);
    if (m && method === 'GET') {
      const { device: d, children } = await device(req);
      const owner = profileImages.isName(m[1]) ? tablet.profileImageOwner(m[1]) : null;
      if (owner == null || !d.child_ids.includes(owner) || !children.some((c) => c.id === owner)) throw new HttpError(404, 'Not found.', 'not_found');
      return sendFile(res, profileImages.read(m[1]));
    }
    m = api.match(/^\/images\/([^/]+)$/);
    if (m && method === 'GET') {
      const { actor } = await kid(req);
      if (!images.isName(m[1]) || !service.mayViewImage(actor, m[1])) throw new HttpError(404, 'Not found.', 'not_found');
      return sendFile(res, images.read(m[1]));
    }

    const candidates = KID.filter(([, re]) => re.test(api));
    if (!candidates.length) throw new HttpError(404, 'Not found.', 'not_found');
    const r = candidates.find(([verb]) => verb === method);
    if (!r) throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
    const write = method !== 'GET';
    if (write) requireCsrf(req);
    const { actor, ctx } = await kid(req);
    const body = write ? await readJson(req) : undefined;
    const data = await r[2]({ actor, ctx, body, url, m: api.match(r[1]) });
    return send(res, method === 'POST' ? 201 : 200, { data });
  };
}

function endReason(url) {
  return url.searchParams.get('reason') === 'idle' ? 'idle' : 'switched';
}

function sendFile(res, file) {
  if (!file) throw new HttpError(404, 'Not found.', 'not_found');
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.body.length,
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  return res.end(file.body);
}
