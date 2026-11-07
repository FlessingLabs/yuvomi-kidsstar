/**
 * KidsStar - Sicherung und Wiederherstellung
 *
 *   node src/backup.js backup  [ZIELORDNER]   (Standard: $DATA_DIR/backups/kidsstar-<Zeit>)
 *   node src/backup.js restore QUELLORDNER    (nur bei gestopptem Dienst!)
 *
 * Eine Sicherung ist ein Ordner mit `kidsstar.db` (konsistente Kopie per
 * VACUUM INTO, auch waehrend der Dienst laeuft), `images/` (Belohnungen) und
 * `profile-images/` (Kacheln des Flurtablets). Mehr Daten hat
 * KidsStar nicht: Mitglieder, Anmeldung und Rechte liegen in Yuvomi und
 * gehoeren in Yuvomis eigene Sicherung.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, schemaVersion } from './db.js';

const dataDir = process.env.DATA_DIR || '/data';
const IMAGE_DIRS = ['images', 'profile-images'];

export function backup(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const target = path.join(to, 'kidsstar.db');
  if (fs.existsSync(target)) throw new Error(`${target} exists already`);
  const db = new DatabaseSync(path.join(from, 'kidsstar.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  let count = 0;
  for (const dir of IMAGE_DIRS) {
    const imgFrom = path.join(from, dir);
    const imgTo = path.join(to, dir);
    fs.mkdirSync(imgTo, { recursive: true });
    if (!fs.existsSync(imgFrom)) continue;
    for (const name of fs.readdirSync(imgFrom)) {
      if (name.startsWith('.')) continue;
      fs.copyFileSync(path.join(imgFrom, name), path.join(imgTo, name));
      count += 1;
    }
  }
  return { target: to, images: count };
}

export function restore(from, to) {
  const source = path.join(from, 'kidsstar.db');
  if (!fs.existsSync(source)) throw new Error(`${source} not found`);
  // Erst pruefen, ob die Sicherung lesbar ist und ein bekanntes Schema hat.
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    const ok = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('backup failed the integrity check');
  } finally {
    check.close();
  }
  fs.mkdirSync(to, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Den bisherigen Stand nicht wegwerfen, sondern beiseitelegen.
  for (const name of ['kidsstar.db', 'kidsstar.db-wal', 'kidsstar.db-shm', ...IMAGE_DIRS]) {
    const p = path.join(to, name);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(to, `${name}.before-restore-${stamp}`));
  }
  fs.copyFileSync(source, path.join(to, 'kidsstar.db'));
  for (const dir of IMAGE_DIRS) {
    if (fs.existsSync(path.join(from, dir))) fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
    else fs.mkdirSync(path.join(to, dir), { recursive: true });
  }
  // Oeffnen fuehrt fehlende Migrationen aus (Sicherung aus einer aelteren Version).
  const db = openDatabase(path.join(to, 'kidsstar.db'), { log: { info() {} } });
  const version = schemaVersion(db);
  db.close();
  return { restored: to, schema: version };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const [cmd, dir] = process.argv.slice(2);
  try {
    if (cmd === 'backup') {
      const to = dir || path.join(dataDir, 'backups', `kidsstar-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      console.log(JSON.stringify(backup(dataDir, to)));
    } else if (cmd === 'restore' && dir) {
      console.log(JSON.stringify(restore(dir, dataDir)));
    } else {
      console.error('usage: node src/backup.js backup [target-dir] | restore <backup-dir>');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[kidsstar] ${cmd} failed: ${err.message}`);
    process.exit(1);
  }
}
