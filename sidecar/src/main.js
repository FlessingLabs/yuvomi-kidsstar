/**
 * KidsStar-Dienst - Startpunkt. Konfiguration ausschliesslich ueber die Umgebung.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db.js';
import { createService } from './service.js';
import { createTablet } from './tablet.js';
import { createYuvomiClient } from './yuvomi.js';
import { createImageStore } from './images.js';
import { createServer, PREFIX, VERSION } from './server.js';
import { createPassThrough } from './proxy.js';

/** Geheimnis aus NAME oder aus der Datei in NAME_FILE (Docker-Secrets). */
function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return (process.env[name] || '').trim();
}

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.DATA_DIR || '/data';
const yuvomiUrl = process.env.YUVOMI_URL || 'http://yuvomi:3000';
const publicOrigins = (process.env.PUBLIC_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);

const db = openDatabase(path.join(dataDir, 'kidsstar.db'));
const service = createService(db);
const tablet = createTablet(db);
const images = createImageStore(path.join(dataDir, 'images'));
const profileImages = createImageStore(path.join(dataDir, 'profile-images'));
const apiToken = readSecret('YUVOMI_API_TOKEN');
const yuvomi = createYuvomiClient({
  yuvomiUrl,
  sessionCookie: process.env.YUVOMI_SESSION_COOKIE || 'yuvomi.sid',
  cacheMs: Number(process.env.AUTH_CACHE_MS || 5000),
  apiToken,
});

// Standard: der Dienst ist zugleich der Eingang fuer Yuvomi (ein Container,
// keine Proxy-Konfiguration). Wer schon einen Reverse-Proxy hat, der
// /api/extensions/kidsstar/ hierher leitet, schaltet das mit PROXY_YUVOMI=false ab.
const proxyYuvomi = process.env.PROXY_YUVOMI !== 'false';
const passThrough = proxyYuvomi ? createPassThrough(yuvomiUrl) : null;

const server = createServer({ db, service, tablet, yuvomi, images, profileImages, publicOrigins, passThrough });
server.listen(port, () => {
  if (!apiToken) console.log('[kidsstar] no YUVOMI_API_TOKEN: the hallway tablet is switched off');
  console.log(`[kidsstar] ${VERSION} listening on :${port}${PREFIX}, data in ${dataDir}, Yuvomi at ${yuvomiUrl}${proxyYuvomi ? ' (proxying all other paths to it)' : ''}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
