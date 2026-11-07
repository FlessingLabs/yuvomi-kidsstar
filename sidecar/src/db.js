/**
 * KidsStar - Datenbank und versionierte Migrationen
 *
 * Eigene SQLite-Datei im Datenverzeichnis des Dienstes (`kidsstar.db`), nie
 * Yuvomis `yuvomi.db` (MODULES.md). `node:sqlite` ist in Node eingebaut, der
 * Dienst hat damit keine npm-Abhaengigkeit.
 *
 * Migrationen laufen beim Start der Reihe nach, jede in ihrer eigenen
 * Transaktion, und werden in `schema_migrations` vermerkt. Eine Migration wird
 * nie nachtraeglich geaendert; eine Korrektur ist eine neue Nummer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Aktionen: was ein Kind tun kann und wie viele Sterne es dafuer gibt.
      CREATE TABLE actions (
        id                INTEGER PRIMARY KEY,
        title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
        description       TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        icon              TEXT NOT NULL DEFAULT '',
        stars             INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 1000),
        repeats           INTEGER NOT NULL DEFAULT 1 CHECK (repeats IN (0, 1)),
        weekdays          INTEGER NOT NULL DEFAULT 127 CHECK (weekdays BETWEEN 1 AND 127),
        per_day           INTEGER NOT NULL DEFAULT 1 CHECK (per_day BETWEEN 1 AND 10),
        requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),
        status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_by        INTEGER,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE action_children (
        action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        child_id  INTEGER NOT NULL,
        PRIMARY KEY (action_id, child_id)
      );

      -- Erledigungen. Titel, Symbol und Sterne sind eine Momentaufnahme der
      -- Aktion zum Zeitpunkt der Meldung: aendern Eltern spaeter den Wert, gilt
      -- fuer eine bereits gemeldete Erledigung weiter der alte.
      -- period: Haushaltstag (YYYY-MM-DD) bei wiederkehrenden Aktionen, 'once' bei einmaligen.
      CREATE TABLE completions (
        id         INTEGER PRIMARY KEY,
        action_id  INTEGER NOT NULL REFERENCES actions(id),
        child_id   INTEGER NOT NULL,
        period     TEXT NOT NULL,
        day        TEXT NOT NULL,
        slot       INTEGER NOT NULL CHECK (slot >= 1),
        title      TEXT NOT NULL,
        icon       TEXT NOT NULL DEFAULT '',
        stars      INTEGER NOT NULL CHECK (stars >= 1),
        status     TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        request_id TEXT NOT NULL,
        feedback   TEXT NOT NULL DEFAULT '',
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        decided_by INTEGER,
        decided_at TEXT
      );
      -- Ein Platz (slot) je Aktion, Kind und Zeitraum kann nur einmal belegt
      -- sein, solange die Erledigung zaehlt. Das ist das Netz gegen parallele
      -- Meldungen von zwei Geraeten; abgelehnte und zurueckgezogene geben ihn frei.
      CREATE UNIQUE INDEX completions_slot ON completions (action_id, child_id, period, slot)
        WHERE status IN ('pending', 'approved');
      -- Dieselbe Anfrage zweimal (Doppelklick, Wiederholung nach Netzfehler) ist eine Erledigung.
      CREATE UNIQUE INDEX completions_request ON completions (child_id, request_id);
      CREATE INDEX completions_child_day ON completions (child_id, day);
      CREATE INDEX completions_status ON completions (status);

      CREATE TABLE rewards (
        id           INTEGER PRIMARY KEY,
        title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
        description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        icon         TEXT NOT NULL DEFAULT '',
        image        TEXT,
        url          TEXT NOT NULL DEFAULT '',
        stars        INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 100000),
        available    INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
        all_children INTEGER NOT NULL DEFAULT 1 CHECK (all_children IN (0, 1)),
        archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        wish_id      INTEGER,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_by   INTEGER,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE reward_children (
        reward_id INTEGER NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
        child_id  INTEGER NOT NULL,
        PRIMARY KEY (reward_id, child_id)
      );

      CREATE TABLE wishes (
        id          INTEGER PRIMARY KEY,
        child_id    INTEGER NOT NULL,
        title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        url         TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
        feedback    TEXT NOT NULL DEFAULT '',
        reward_id   INTEGER REFERENCES rewards(id),
        request_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        decided_by  INTEGER,
        decided_at  TEXT
      );
      CREATE UNIQUE INDEX wishes_request ON wishes (child_id, request_id);

      -- Sparziel: hoechstens eines je Kind.
      CREATE TABLE goals (
        child_id  INTEGER PRIMARY KEY,
        reward_id INTEGER NOT NULL REFERENCES rewards(id),
        set_at    TEXT NOT NULL
      );

      -- Einloesungen. Titel, Symbol, Bild und Preis sind eine Momentaufnahme:
      -- eine spaetere Katalogaenderung veraendert keine bestehende Anfrage.
      CREATE TABLE redemptions (
        id           INTEGER PRIMARY KEY,
        child_id     INTEGER NOT NULL,
        reward_id    INTEGER REFERENCES rewards(id),
        title        TEXT NOT NULL,
        icon         TEXT NOT NULL DEFAULT '',
        image        TEXT,
        stars        INTEGER NOT NULL CHECK (stars >= 1),
        status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'fulfilled')),
        request_id   TEXT NOT NULL,
        feedback     TEXT NOT NULL DEFAULT '',
        created_by   INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        decided_by   INTEGER,
        decided_at   TEXT,
        fulfilled_by INTEGER,
        fulfilled_at TEXT
      );
      CREATE UNIQUE INDEX redemptions_request ON redemptions (child_id, request_id);
      -- Eine offene Anfrage je Kind und Belohnung: zwei Klicks mit zwei
      -- verschiedenen Anfrage-Ids reservieren trotzdem nur einmal.
      CREATE UNIQUE INDEX redemptions_open ON redemptions (child_id, reward_id) WHERE status = 'pending';
      CREATE INDEX redemptions_status ON redemptions (status);

      -- Das Buchungsjournal, die einzige Quelle fuer Sternestaende.
      --   delta          : Wirkung auf den verfuegbaren Stand
      --   reserved_delta : Wirkung auf die reservierten Sterne
      -- verfuegbar = SUM(delta), reserviert = SUM(reserved_delta). Kein
      -- gespeicherter Kontostand, der davon abweichen koennte.
      --   earn       +n / 0   Aktion erledigt (bestaetigt oder ohne Bestaetigung)
      --   bonus      +n / 0   Eltern vergeben Sterne mit Begruendung
      --   correction +-n / 0  Korrektur mit Begruendung, ggf. Gegenbuchung (reverses_id)
      --   reserve    -n / +n  Einloesung angefragt
      --   release    +n / -n  Einloesung abgelehnt oder zurueckgezogen
      --   redeem      0 / -n  Einloesung genehmigt: reservierte Sterne endgueltig eingeloest
      --   refund     +n / 0   genehmigte Einloesung zurueckgenommen
      CREATE TABLE ledger (
        id             INTEGER PRIMARY KEY,
        child_id       INTEGER NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('earn', 'bonus', 'correction', 'reserve', 'release', 'redeem', 'refund')),
        delta          INTEGER NOT NULL,
        reserved_delta INTEGER NOT NULL DEFAULT 0,
        reason         TEXT NOT NULL DEFAULT '',
        completion_id  INTEGER REFERENCES completions(id),
        redemption_id  INTEGER REFERENCES redemptions(id),
        reverses_id    INTEGER REFERENCES ledger(id),
        request_id     TEXT,
        created_by     INTEGER,
        created_at     TEXT NOT NULL,
        CHECK (delta <> 0 OR reserved_delta <> 0)
      );
      CREATE INDEX ledger_child ON ledger (child_id, id);
      -- Eine Erledigung wird hoechstens einmal gutgeschrieben.
      CREATE UNIQUE INDEX ledger_earn ON ledger (completion_id) WHERE kind = 'earn';
      -- Jeder Schritt einer Einloesung hoechstens einmal.
      CREATE UNIQUE INDEX ledger_redemption_step ON ledger (redemption_id, kind) WHERE redemption_id IS NOT NULL;
      -- Eine Buchung wird hoechstens einmal gegengebucht.
      CREATE UNIQUE INDEX ledger_reverses ON ledger (reverses_id) WHERE reverses_id IS NOT NULL;
      CREATE UNIQUE INDEX ledger_request ON ledger (child_id, request_id) WHERE request_id IS NOT NULL;

      -- Das Journal ist unveraenderlich: Fehler werden mit einer Korrektur
      -- sichtbar gegengebucht, nie still ueberschrieben oder geloescht.
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    `,
  },
  {
    version: 2,
    name: 'hallway tablet: devices, child profiles, picture codes, kid sessions',
    sql: `
      -- Bild, Symbol, Farbe und optionaler Bildcode je Kind ("Wer bist du?").
      CREATE TABLE child_profiles (
        child_id   INTEGER PRIMARY KEY,
        image      TEXT,
        symbol     TEXT NOT NULL DEFAULT '',
        color      TEXT NOT NULL DEFAULT '',
        code_hash  TEXT,
        code_salt  TEXT,
        updated_at TEXT NOT NULL
      );

      -- Gekoppelte Tablets. Das Geheimnis des Geraets steht nur als Hash hier;
      -- der Kopplungscode ist kurzlebig, einmalig und ebenfalls gehasht.
      CREATE TABLE devices (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        token_hash      TEXT UNIQUE,
        pairing_hash    TEXT UNIQUE,
        pairing_expires TEXT,
        idle_seconds    INTEGER NOT NULL DEFAULT 120 CHECK (idle_seconds BETWEEN 30 AND 1800),
        created_by      INTEGER,
        created_at      TEXT NOT NULL,
        paired_at       TEXT,
        last_seen_at    TEXT,
        revoked_at      TEXT,
        revoked_by      INTEGER
      );

      CREATE TABLE device_children (
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        child_id  INTEGER NOT NULL,
        PRIMARY KEY (device_id, child_id)
      );

      -- Kindersitzung am Tablet: ein Kind, ein Geraet, kurze Leerlaufzeit.
      CREATE TABLE kid_sessions (
        id           INTEGER PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        child_id     INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at     TEXT,
        end_reason   TEXT
      );
      CREATE INDEX kid_sessions_device ON kid_sessions (device_id) WHERE ended_at IS NULL;

      -- Fehlversuche beim Bildcode, je Geraet und Kind.
      CREATE TABLE code_attempts (
        device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        child_id     INTEGER NOT NULL,
        failures     INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        PRIMARY KEY (device_id, child_id)
      );
    `,
  },
];

export function migrate(db, { log = console } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const newest = Math.max(0, ...applied);
  const known = Math.max(...MIGRATIONS.map((m) => m.version));
  if (newest > known) {
    // Eine Datenbank aus einer neueren Version: nicht anfassen, statt halb zu lesen.
    throw new Error(`kidsstar.db has schema version ${newest}, this service knows up to ${known}. Update the service.`);
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      log.info?.(`[kidsstar] migration ${m.version} (${m.name}) applied`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function schemaVersion(db) {
  return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
}

/**
 * Oeffnet (und legt bei Bedarf an) die Datenbank. `file` = ':memory:' fuer Tests.
 */
export function openDatabase(file, { log = console } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, { log });
  return db;
}

/**
 * Fuehrt fn in einer Schreibtransaktion aus. BEGIN IMMEDIATE nimmt die
 * Schreibsperre sofort: Pruefen und Schreiben laufen ohne Luecke, auch wenn
 * (unerwartet) ein zweiter Prozess dieselbe Datei benutzt. Innerhalb von fn
 * darf kein `await` stehen - der Treiber ist synchron, und genau das macht
 * "Guthaben pruefen, dann reservieren" atomar.
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
