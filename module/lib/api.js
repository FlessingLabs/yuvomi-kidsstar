/**
 * KidsStar - Client fuer den KidsStar-Dienst
 *
 * Yuvomis `/api.js` haengt `/api/v1` vor jeden Pfad und schickt Yuvomis
 * CSRF-Token - beides passt nicht zum Dienst. Dieser Client spricht deshalb
 * selbst mit `/api/extensions/kidsstar`: same-origin, also mit dem
 * Session-Cookie, und mit dem eigenen CSRF-Paar des Dienstes.
 */

export const BASE = '/api/extensions/kidsstar';
export const CSRF_HEADER = 'X-KidsStar-CSRF';

export class KidsStarError extends Error {
  constructor(message, status, reason = null, body = {}) {
    super(message);
    this.name = 'KidsStarError';
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

/** Zufaellige Anfrage-Id: dieselbe Id zweimal ist fuer den Dienst ein Vorgang. */
export function requestId() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function createClient({ base = BASE, fetchImpl = (...a) => fetch(...a) } = {}) {
  let csrfToken = '';

  async function request(path, { method = 'GET', body, raw, contentType, signal } = {}, retried = false) {
    const write = method !== 'GET';
    if (write && !csrfToken) await refreshCsrf(signal);

    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(raw !== undefined ? { 'Content-Type': contentType || 'application/octet-stream' } : {}),
          ...(write ? { [CSRF_HEADER]: csrfToken } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(raw !== undefined ? { body: raw } : {}),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new KidsStarError('KidsStar service unreachable.', 0, 'unreachable');
    }

    let data = null;
    try { data = await res.json(); } catch { /* z. B. 502 vom Proxy mit HTML */ }

    if (!res.ok) {
      // Token abgelaufen oder Cookie verworfen (iOS-PWA): einmal neu holen.
      if (res.status === 403 && data?.reason === 'csrf_invalid' && !retried) {
        csrfToken = '';
        return request(path, { method, body, raw, contentType, signal }, true);
      }
      // 404 ohne `reason`: der Pfad landet nicht beim Dienst, sondern bei Yuvomi
      // selbst (Dienst aus oder Proxy fehlt) - der Dienst nennt bei 404 immer einen Grund.
      const reason = data?.reason ?? (res.status >= 502 || res.status === 404 ? 'unreachable' : null);
      throw new KidsStarError(data?.error || `HTTP ${res.status}`, res.status, reason, data ?? {});
    }
    return data?.data;
  }

  async function refreshCsrf(signal) {
    csrfToken = (await request('/csrf', { signal })).token;
  }

  return {
    get: (path, opts) => request(path, opts),
    post: (path, body = {}, opts) => request(path, { ...opts, method: 'POST', body }),
    patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
    put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
    del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
    upload: (path, blob, opts) => request(path, { ...opts, method: 'PUT', raw: blob, contentType: blob.type }),
  };
}
