/**
 * KidsStar - Bilder der Belohnungen, lokal im Datenverzeichnis
 *
 * Nur PNG, JPEG und WebP, erkannt am Inhalt (Magic Bytes), nie am Dateinamen
 * oder am Content-Type des Browsers. Gespeichert unter einem Zufallsnamen; der
 * Name in der Datenbank ist nur dieser Zufallsname, nie ein Pfad. Kein SVG:
 * das waere ausfuehrbarer Inhalt auf derselben Origin.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomName } from './service.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const NAME = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function createImageStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  return {
    dir,
    isName: (name) => NAME.test(name),
    /** @returns {string|null} Dateiname oder null, wenn kein unterstuetztes Bild */
    save(buf) {
      const ext = sniff(buf);
      if (!ext) return null;
      const name = `${randomName()}.${ext}`;
      const tmp = path.join(dir, `.${name}.tmp`);
      fs.writeFileSync(tmp, buf, { mode: 0o640 });
      fs.renameSync(tmp, path.join(dir, name));
      return name;
    },
    read(name) {
      if (!NAME.test(name)) return null;
      try {
        return { body: fs.readFileSync(path.join(dir, name)), type: TYPES[name.split('.').pop()] };
      } catch {
        return null;
      }
    },
    remove(name) {
      if (!NAME.test(name)) return;
      fs.rmSync(path.join(dir, name), { force: true });
    },
  };
}
