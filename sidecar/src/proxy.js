/**
 * KidsStar - Durchreichen an Yuvomi
 *
 * Browser und KidsStar-Dienst muessen sich EINE Adresse teilen (Session-Cookie,
 * Same-Origin), Yuvomi leitet /api/extensions/... aber nicht selbst weiter.
 * Statt eines zusaetzlichen Proxy-Containers uebernimmt das der Dienst: alles
 * ausserhalb seines eigenen Pfads geht unveraendert an Yuvomi.
 *
 * Bewusst dumm: Anfrage und Antwort werden gestreamt, nichts wird gelesen oder
 * umgeschrieben. Der Host-Header bleibt der, den der Browser geschickt hat (wie
 * bei Caddy), damit Yuvomi seine oeffentliche Adresse sieht. Yuvomi nutzt weder
 * WebSockets noch Server-Sent Events, ein Upgrade-Pfad ist daher nicht noetig.
 */

import http from 'node:http';
import https from 'node:https';

// Hop-by-hop-Header gelten nur fuer eine Verbindung und werden nie weitergereicht (RFC 9110, 7.6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function stripHopByHop(headers) {
  const out = {};
  const listed = String(headers.connection || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k) && !listed.includes(k)) out[k] = v;
  }
  return out;
}

export function createPassThrough(yuvomiUrl, { log = console } = {}) {
  const target = new URL(yuvomiUrl);
  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });

  return function passThrough(req, res) {
    const headers = stripHopByHop(req.headers);
    const remote = req.socket.remoteAddress || '';
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${remote}` : remote;
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');

    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent,
    }, (up) => {
      res.writeHead(up.statusCode, up.statusMessage, stripHopByHop(up.headers));
      up.pipe(res);
    });

    upstream.on('error', (err) => {
      log.error(`[kidsstar] Yuvomi at ${target.origin} unreachable: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Yuvomi is not reachable from the KidsStar container. Check YUVOMI_URL.\n');
      } else {
        res.destroy();
      }
    });
    // Bricht der Browser ab, die Anfrage an Yuvomi ebenfalls abbrechen.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  };
}
