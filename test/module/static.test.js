// Statische Pruefungen der Moduldateien: Manifest, Sprachdateien, Sicherheitsregeln.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../../module/', import.meta.url).pathname;
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const jsFiles = ['index.js', 'settings.js', 'widget.js', 'lib/api.js', 'lib/kidsstar.js', 'lib/image.js'];
const tabletFiles = ['../sidecar/public/tablet/app.js', '../sidecar/public/tablet/index.html', '../sidecar/public/tablet/app.css'];

test('Manifest entspricht MODULES.md', () => {
  const m = JSON.parse(read('module.json'));
  assert.equal(m.manifestVersion, 1);
  assert.equal(m.id, 'kidsstar');
  assert.match(m.id, /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
  assert.equal(m.capabilities.api.prefix, '/api/extensions/kidsstar');
  assert.ok(m.capabilities.permissions.module);
  for (const f of [m.entry, m.style, m.settings.entry, ...m.capabilities.widgets.map((w) => w.entry)]) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.deepEqual(m.settings.sections, ['household']);
  const w = m.capabilities.widgets[0];
  assert.match(w.id, /^[a-z][a-z0-9-]{0,31}$/);
  assert.ok(m.capabilities.permissions.widgets.some((x) => x.id === w.id));
  assert.match(m.accent, /^#[0-9A-Fa-f]{6}$/);
});

test('Nur Dateitypen, die der Yuvomi-Installer kopiert', () => {
  const allowed = /\.(js|mjs|css|json|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf|md|txt|map)$|^(LICENSE|LICENCE|NOTICE|README)/i;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.match(path.basename(f), allowed, f);
});

function usedKeys() {
  const keys = new Set();
  const dynamic = [];
  for (const f of jsFiles) {
    for (const m of read(f).matchAll(/tr\((['`])([^'`]+)\1/g)) {
      if (m[2].includes('${')) dynamic.push(m[2]);
      else keys.add(m[2]);
    }
  }
  return { keys, dynamic };
}

test('Sprachdateien: Deutsch und Englisch vollstaendig und gleich', () => {
  const de = JSON.parse(read('locales/de.json'));
  const en = JSON.parse(read('locales/en.json'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  const { keys, dynamic } = usedKeys();
  for (const k of keys) assert.ok(k in de, `missing key ${k}`);
  // Jeder dynamische Schluessel hat mindestens eine Auspraegung.
  for (const d of dynamic) {
    const prefix = d.slice(0, d.indexOf('${'));
    assert.ok(Object.keys(de).some((k) => k.startsWith(prefix)), `no keys for ${d}`);
  }
  // Ausdruecklich die Auspraegungen, die der Code erzeugt.
  for (const k of ['status.pending', 'status.approved', 'status.rejected', 'status.cancelled', 'status.fulfilled', 'status.proposed', 'status.withdrawn',
    'kind.earn', 'kind.bonus', 'kind.correction', 'kind.reserve', 'kind.release', 'kind.redeem', 'kind.refund',
    'action.reject', 'action.revoke', 'redemption.rejectTitle', 'redemption.revokeTitle', 'redemption.approveDone', 'redemption.fulfillDone',
    'actions.status.paused', 'actions.status.archived', 'load.forbidden.title', 'load.unreachable.text', 'load.failed.title']) {
    assert.ok(k in de, k);
  }
  for (const t of ['teethMorning', 'teethEvening', 'tidyRoom', 'homework', 'setTable', 'trash']) assert.ok(`template.${t}` in de);
  for (const role of ['child', 'parent']) {
    const ids = role === 'child' ? ['today', 'stars', 'shop', 'wishes'] : ['overview', 'actions', 'rewards', 'history', 'tablet'];
    for (const id of ids) assert.ok(`tab.${role}.${id}` in de);
  }
  // Fehlergruende, die die Seite kennt, haben einen Text.
  const known = read('index.js').match(/const known = \[([\s\S]*?)\];/)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  for (const r of known) assert.ok(`error.${r}` in de, `error.${r}`);
  // Platzhalter sind in beiden Sprachen dieselben.
  for (const k of Object.keys(de)) {
    const ph = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join();
    assert.equal(ph(en[k]), ph(de[k]), k);
  }
});

test('Frontend-Regeln: kein innerHTML, kein eval, keine fremden Quellen', () => {
  for (const f of [...jsFiles, ...tabletFiles]) {
    const src = read(f);
    assert.ok(!/\.innerHTML\s*=|outerHTML\s*=|document\.write|\beval\(|new Function\(/.test(src), `${f}: unsafe DOM API`);
    assert.ok(!/https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}\/[^'"`\s]*\.(js|css|woff2?)/i.test(src), `${f}: external asset`);
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), `${f}: external script`);
  }
});
