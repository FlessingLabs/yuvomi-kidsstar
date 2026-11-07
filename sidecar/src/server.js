/**
 * KidsStar - HTTP-Dienst unter /api/extensions/kidsstar
 *
 * Der Pfad ist durch Yuvomi vorgegeben (capabilities.api.prefix). Jede Anfrage
 * ausser /health braucht eine gueltige Yuvomi-Sitzung und das Modulrecht
 * `ext:kidsstar` (ist KidsStar in Yuvomi abgeschaltet, fehlt das Recht ganz).
 * Jede schreibende Anfrage muss zusaetzlich bestehen (MODULES.md):
 *   - Origin passt zum oeffentlichen Host
 *   - eigenes Double-Submit-CSRF-Paar (Cookie + Header)
 *   - Modulrecht `write`
 *   - die Rollen- oder Eigentumspruefung des Endpunkts (service.js)
 *
 * Bewusst ohne Framework und ohne npm-Abhaengigkeiten.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError, forbidden } from './errors.js';
import { MODULE_ID, readCookie } from './yuvomi.js';
import { householdDay } from './time.js';
import { MAX_IMAGE_BYTES } from './images.js';
import { schemaVersion } from './db.js';
import { createTabletRoutes, TABLET_PREFIX } from './tablet-routes.js';

export const PREFIX = `/api/extensions/${MODULE_ID}`;
export const CSRF_COOKIE = 'kidsstar-csrf';
export const CSRF_HEADER = 'x-kidsstar-csrf';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_BODY = 32 * 1024;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

function sendError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const body = { error: status >= 500 && !err.reason ? 'Internal server error.' : err.message, code: status };
  if (err.reason) body.reason = err.reason;
  if (err.extra && Object.keys(err.extra).length) Object.assign(body, err.extra);
  send(res, status, body);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large.', 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const buf = await readBody(req, MAX_BODY);
  if (!buf.length) return {};
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.', 'unsupported_media_type');
  try {
    const body = JSON.parse(buf.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.', 'invalid_json');
  }
}

/** Ein Bild ausliefern: Typ aus dem Inhalt, privat zwischenspeicherbar, nie als Dokument. */
export function sendImage(res, file) {
  if (!file) throw new HttpError(404, 'Not found.', 'not_found');
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.body.length,
    'cache-control': 'private, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  return res.end(file.body);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/**
 * Die Origins, die als "dieselbe Seite" gelten. Mit PUBLIC_ORIGIN fest
 * eingestellt; sonst aus dem Host, den der Proxy weiterreicht - der Browser
 * hat genau diesen Host aufgerufen, und ein fremder Origin passt nicht dazu.
 */
function expectedOrigins(req, publicOrigins) {
  if (publicOrigins.length) return publicOrigins;
  const host = req.headers['x-forwarded-host']?.split(',')[0].trim() || req.headers.host;
  if (!host) return [];
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || 'http';
  return [`${proto}://${host}`];
}

function isSecure(req) {
  return (req.headers['x-forwarded-proto']?.split(',')[0].trim() || '') === 'https';
}

function parseId(raw) {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new HttpError(404, 'Not found.', 'not_found');
  return Number(raw);
}

/** Liegt der Pfad im eigenen Bereich des Dienstes? */
export function ownPath(rawUrl) {
  const pathname = new URL(rawUrl, 'http://localhost').pathname;
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/**
 * @param {object} opts
 * @param {object} opts.db       offene Datenbank (fuer /health)
 * @param {object} opts.service  service.js
 * @param {object} opts.yuvomi   yuvomi.js: identify, children, timeZone
 * @param {object} opts.images   images.js
 * @param {Function} [opts.passThrough]  Reicht alles ausserhalb von PREFIX an Yuvomi weiter
 *        (proxy.js). Ohne sie antwortet der Dienst dort mit 404 - fuer den Betrieb hinter
 *        einem eigenen Reverse-Proxy.
 * @param {Function} [opts.clock]  liefert "jetzt" (Tests)
 */
export function createApp({ db, service, tablet, yuvomi, images, profileImages, publicOrigins = [], passThrough = null, log = console, clock = () => new Date() }) {
  const origins = publicOrigins.map((o) => o.replace(/\/+$/, ''));

  function requireSameOriginAndCsrf(req) {
    const origin = req.headers.origin;
    if (!origin || !expectedOrigins(req, origins).includes(origin)) {
      throw new HttpError(403, 'Origin not allowed.', 'origin_mismatch');
    }
    const cookie = readCookie(req.headers.cookie, CSRF_COOKIE);
    const header = req.headers[CSRF_HEADER];
    if (!cookie || !header || !safeEqual(cookie, header)) {
      throw new HttpError(403, 'Invalid CSRF token.', 'csrf_invalid');
    }
  }

  /** Wer fragt? Nur Yuvomis Antwort zaehlt; dazu Rolle, Tag und - fuer Eltern - die Kinder. */
  async function resolve(req) {
    const identity = await yuvomi.identify(req);
    if (!identity) throw new HttpError(401, 'Authentication required.', 'unauthenticated');
    if (identity.access === 'none') throw forbidden('No access to KidsStar.', 'module_forbidden');
    const role = service.roleOf(identity);
    const actor = { userId: identity.userId, name: identity.name, role, access: identity.access, admin: identity.admin };
    const tz = await yuvomi.timeZone(req, identity);
    service.rememberTimeZone(tz);
    const { day, weekday } = householdDay(clock(), tz);
    const children = role === 'parent' ? await yuvomi.children(req, identity) : [];
    return { actor, ctx: { day, weekday, timeZone: tz, children } };
  }

  const routes = [];
  const route = (method, pattern, handler, { write = false } = {}) => routes.push({ method, pattern, handler, write });
  const q = (url, key) => url.searchParams.get(key) ?? undefined;

  route('GET', /^\/me$/, async ({ actor, ctx }) => ({
    user: { id: actor.userId, name: actor.name },
    role: actor.role,
    access: actor.access,
    admin: actor.admin,
    day: ctx.day,
    weekday: ctx.weekday,
    timezone: ctx.timeZone,
    settings: service.getSettings(),
    version: VERSION,
  }));
  route('GET', /^\/summary$/, ({ actor, ctx }) => service.summary(actor, ctx));
  route('GET', /^\/overview$/, ({ actor, ctx }) => service.overview(actor, ctx));
  route('GET', /^\/children$/, ({ actor, ctx }) => {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    return ctx.children;
  });
  route('GET', /^\/settings$/, ({ actor }) => {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    return service.getSettings();
  });
  route('PATCH', /^\/settings$/, ({ actor, body }) => service.updateSettings(actor, body, { admin: actor.admin }), { write: true });

  route('GET', /^\/actions$/, ({ actor }) => service.listActions(actor));
  route('POST', /^\/actions$/, ({ actor, ctx, body }) => service.createAction(actor, ctx, body), { write: true });
  route('PATCH', /^\/actions\/([^/]+)$/, ({ actor, ctx, body, m }) => service.updateAction(actor, ctx, parseId(m[1]), body), { write: true });

  route('GET', /^\/today$/, ({ actor, ctx, url }) => service.today(actor, ctx, { child: q(url, 'child') }));
  route('GET', /^\/completions$/, ({ actor, ctx, url }) => service.listCompletions(actor, ctx, { status: q(url, 'status'), child: q(url, 'child') }));
  route('POST', /^\/completions$/, ({ actor, ctx, body }) => service.reportCompletion(actor, ctx, body), { write: true });
  route('POST', /^\/completions\/([^/]+)\/(approve|reject)$/, ({ actor, ctx, body, m }) => service.decideCompletion(actor, ctx, parseId(m[1]), m[2], body), { write: true });
  route('POST', /^\/completions\/([^/]+)\/cancel$/, ({ actor, m }) => service.cancelCompletion(actor, parseId(m[1])), { write: true });

  route('GET', /^\/ledger$/, ({ actor, ctx, url }) => service.ledgerList(actor, ctx, { child: q(url, 'child'), limit: q(url, 'limit'), before: q(url, 'before') }));
  route('POST', /^\/ledger\/bonus$/, ({ actor, ctx, body }) => service.bonus(actor, ctx, body), { write: true });
  route('POST', /^\/ledger\/correction$/, ({ actor, ctx, body }) => service.correction(actor, ctx, body), { write: true });

  route('GET', /^\/rewards$/, ({ actor, ctx, url }) => service.listRewards(actor, ctx, { archived: q(url, 'archived') === '1' }));
  route('POST', /^\/rewards$/, ({ actor, ctx, body }) => service.createReward(actor, ctx, body), { write: true });
  route('PATCH', /^\/rewards\/([^/]+)$/, ({ actor, ctx, body, m }) => service.updateReward(actor, ctx, parseId(m[1]), body), { write: true });
  route('DELETE', /^\/rewards\/([^/]+)\/image$/, ({ actor, m }) => {
    const { reward, previous } = service.setRewardImage(actor, parseId(m[1]), null);
    if (previous && !service.imageInUse(previous)) images.remove(previous);
    return reward;
  }, { write: true });

  route('PUT', /^\/goal$/, ({ actor, ctx, body }) => service.setGoal(actor, ctx, body), { write: true });

  route('GET', /^\/wishes$/, ({ actor, ctx, url }) => service.listWishes(actor, ctx, { status: q(url, 'status') }));
  route('POST', /^\/wishes$/, ({ actor, body }) => service.proposeWish(actor, body), { write: true });
  route('POST', /^\/wishes\/([^/]+)\/approve$/, ({ actor, ctx, body, m }) => service.approveWish(actor, ctx, parseId(m[1]), body), { write: true });
  route('POST', /^\/wishes\/([^/]+)\/reject$/, ({ actor, ctx, body, m }) => service.rejectWish(actor, ctx, parseId(m[1]), body), { write: true });
  route('POST', /^\/wishes\/([^/]+)\/withdraw$/, ({ actor, m }) => service.withdrawWish(actor, parseId(m[1])), { write: true });

  route('GET', /^\/redemptions$/, ({ actor, ctx, url }) => service.listRedemptions(actor, ctx, { status: q(url, 'status') }));
  route('POST', /^\/redemptions$/, ({ actor, body }) => service.requestRedemption(actor, body), { write: true });
  route('POST', /^\/redemptions\/([^/]+)\/(approve|reject|cancel|fulfill|revoke)$/, ({ actor, ctx, body, m }) => service.decideRedemption(actor, ctx, parseId(m[1]), m[2], body), { write: true });

  // Flurtablet: Profile und Geraete, verwaltet aus der regulaeren Elternsitzung.
  route('GET', /^\/profiles$/, ({ actor, ctx }) => tablet.listProfiles(actor, ctx));
  route('PATCH', /^\/profiles\/([^/]+)$/, ({ actor, ctx, body, m }) => tablet.updateProfile(actor, ctx, parseId(m[1]), body), { write: true });
  route('DELETE', /^\/profiles\/([^/]+)\/image$/, ({ actor, ctx, m }) => {
    const { profile, previous } = tablet.setProfileImage(actor, ctx, parseId(m[1]), null);
    if (previous) profileImages.remove(previous);
    return profile;
  }, { write: true });
  route('GET', /^\/devices$/, ({ actor }) => tablet.listDevices(actor));
  route('POST', /^\/devices$/, ({ actor, ctx, body }) => tablet.createDevice(actor, ctx, body), { write: true });
  route('PATCH', /^\/devices\/([^/]+)$/, ({ actor, ctx, body, m }) => tablet.updateDevice(actor, ctx, parseId(m[1]), body), { write: true });
  route('POST', /^\/devices\/([^/]+)\/pairing$/, ({ actor, m }) => tablet.renewPairing(actor, parseId(m[1])), { write: true });
  route('DELETE', /^\/devices\/([^/]+)$/, ({ actor, m }) => tablet.revokeDevice(actor, parseId(m[1])), { write: true });
  route('GET', /^\/tablet-status$/, async ({ actor }) => {
    if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
    if (!yuvomi.tabletConfigured()) return { configured: false, ok: false, reason: 'tablet_not_configured' };
    try {
      const view = await yuvomi.householdView();
      return { configured: true, ok: view.enabled, reason: view.enabled ? null : 'module_forbidden', children: view.children.length };
    } catch (err) {
      return { configured: true, ok: false, reason: err.reason || 'yuvomi_unavailable' };
    }
  });

  const tabletRoutes = createTabletRoutes({
    service, tablet, yuvomi, images, profileImages, publicOrigins: origins, clock, log,
    helpers: { send, readJson, readBody, safeEqual, expectedOrigins, isSecure, parseId },
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!ownPath(req.url)) throw new HttpError(404, 'Not found.', 'not_found');
    const pathname = url.pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/';
    const method = req.method;

    if (pathname === '/health' && method === 'GET') {
      // Auch die Datenbank fragen: ein Dienst ohne lesbare Datei ist nicht gesund.
      return send(res, 200, { data: { ok: true, version: VERSION, schema: schemaVersion(db) } });
    }

    if (pathname === '/csrf' && method === 'GET') {
      await resolve(req);
      const token = crypto.randomBytes(32).toString('base64url');
      const cookie = [
        `${CSRF_COOKIE}=${token}`, `Path=${PREFIX}`, 'HttpOnly', 'SameSite=Strict',
        ...(isSecure(req) ? ['Secure'] : []),
      ].join('; ');
      return send(res, 200, { data: { token } }, { 'set-cookie': cookie });
    }

    // Das Flurtablet hat seine eigenen Sitzungen und Regeln (tablet-routes.js).
    // Ungekuerzter Pfad: /tablet und /tablet/ sind dort verschiedene Adressen.
    const rawSub = url.pathname.slice(PREFIX.length);
    if (rawSub === TABLET_PREFIX || rawSub.startsWith(`${TABLET_PREFIX}/`)) {
      return tabletRoutes(req, res, rawSub, url);
    }

    let m = pathname.match(/^\/profiles\/([^/]+)\/image$/);
    if (m && method === 'PUT') {
      requireSameOriginAndCsrf(req);
      const { actor, ctx } = await resolve(req);
      if (actor.access !== 'write') throw forbidden('KidsStar is read-only for you.', 'read_only');
      if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
      const childId = parseId(m[1]);
      const buf = await readBody(req, MAX_IMAGE_BYTES);
      const name = profileImages.save(buf);
      if (!name) throw new HttpError(415, 'Only PNG, JPEG or WebP images.', 'unsupported_image');
      try {
        const { profile, previous } = tablet.setProfileImage(actor, ctx, childId, name);
        if (previous && previous !== name) profileImages.remove(previous);
        return send(res, 200, { data: profile });
      } catch (err) {
        profileImages.remove(name);
        throw err;
      }
    }

    // Kachelbilder sehen nur Eltern (und gekoppelte Tablets, siehe tablet-routes.js).
    m = pathname.match(/^\/profile-images\/([^/]+)$/);
    if (m && method === 'GET') {
      const { actor, ctx } = await resolve(req);
      const owner = profileImages.isName(m[1]) ? tablet.profileImageOwner(m[1]) : null;
      if (actor.role !== 'parent' || owner == null || !ctx.children.some((c) => c.id === owner)) throw new HttpError(404, 'Not found.', 'not_found');
      return sendImage(res, profileImages.read(m[1]));
    }

    // Bild hochladen: roher Koerper statt JSON, eigene Groessengrenze.
    m = pathname.match(/^\/rewards\/([^/]+)\/image$/);
    if (m && method === 'PUT') {
      requireSameOriginAndCsrf(req);
      const { actor } = await resolve(req);
      if (actor.access !== 'write') throw forbidden('KidsStar is read-only for you.', 'read_only');
      if (actor.role !== 'parent') throw forbidden('Only parents can do this.', 'parent_required');
      const id = parseId(m[1]);
      const buf = await readBody(req, MAX_IMAGE_BYTES);
      const name = images.save(buf);
      if (!name) throw new HttpError(415, 'Only PNG, JPEG or WebP images.', 'unsupported_image');
      try {
        const { reward, previous } = service.setRewardImage(actor, id, name);
        if (previous && previous !== name && !service.imageInUse(previous)) images.remove(previous);
        return send(res, 200, { data: reward });
      } catch (err) {
        images.remove(name);
        throw err;
      }
    }

    m = pathname.match(/^\/images\/([^/]+)$/);
    if (m && method === 'GET') {
      const { actor } = await resolve(req);
      const name = m[1];
      if (!images.isName(name) || !service.mayViewImage(actor, name)) throw new HttpError(404, 'Not found.', 'not_found');
      return sendImage(res, images.read(name));
    }

    const candidates = routes.filter((r) => r.pattern.test(pathname));
    if (!candidates.length) throw new HttpError(404, 'Not found.', 'not_found');
    const r = candidates.find((c) => c.method === method);
    if (!r) throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');

    if (r.write) requireSameOriginAndCsrf(req);
    const { actor, ctx } = await resolve(req);
    if (r.write && actor.access !== 'write') throw forbidden('KidsStar is read-only for you.', 'read_only');
    const body = r.write ? await readJson(req) : undefined;
    const data = await r.handler({ actor, ctx, body, url, m: pathname.match(r.pattern) });
    return send(res, method === 'POST' ? 201 : 200, { data });
  }

  return function app(req, res) {
    if (passThrough && !ownPath(req.url)) return passThrough(req, res);
    handle(req, res).catch((err) => {
      if (!err.status || err.status >= 500) log.error(`[kidsstar] ${req.method} ${req.url}:`, err);
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    });
  };
}

export function createServer(options) {
  return http.createServer(createApp(options));
}
