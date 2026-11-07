/**
 * KidsStar - Eingabepruefung
 *
 * Jeder Wert aus einem Anfragekoerper laeuft durch eine dieser Funktionen,
 * bevor er die Datenbank erreicht. Fehler nennen das Feld (`field`), damit die
 * Oberflaeche es markieren kann.
 */

import { invalid } from './errors.js';

// Steuerzeichen ausser Zeilenumbruch und Tab.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function text(value, field, { max = 80, required = false, multiline = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw invalid(`${field} must be text.`, 'invalid_input', { field });
  let v = value.normalize('NFC').trim();
  if (!multiline) v = v.replace(/\s+/g, ' ');
  if (CONTROL.test(v)) throw invalid(`${field} contains control characters.`, 'invalid_input', { field });
  if (required && !v) throw invalid(`${field} is required.`, 'required', { field });
  if (v.length > max) throw invalid(`${field} is longer than ${max} characters.`, 'too_long', { field, max });
  return v;
}

export function int(value, field, { min, max }) {
  const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(`${field} must be a whole number from ${min} to ${max}.`, 'out_of_range', { field, min, max });
  }
  return n;
}

export function bool(value, field) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  throw invalid(`${field} must be true or false.`, 'invalid_input', { field });
}

/** Symbol: ein Emoji oder ein kurzes Zeichen; wird beim Ausgeben immer escaped. */
export function icon(value, field = 'icon') {
  const v = text(value, field, { max: 16 });
  if (/[<>"'&]/.test(v)) throw invalid(`${field} contains invalid characters.`, 'invalid_input', { field });
  return v;
}

/** Produktlink: nur http(s), sonst waere ein `javascript:` ein klickbarer Link. */
export function url(value, field = 'url') {
  const v = text(value, field, { max: 500 });
  if (!v) return '';
  let parsed;
  try {
    parsed = new URL(v);
  } catch {
    throw invalid(`${field} is not a valid address.`, 'invalid_url', { field });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(`${field} must start with http:// or https://.`, 'invalid_url', { field });
  }
  return parsed.href;
}

/** Anfrage-Id fuer Wiederholungssicherheit, vom Browser je Vorgang einmal erzeugt. */
export function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw invalid('request_id must be 8 to 64 letters, digits, - or _.', 'invalid_request_id', { field: 'request_id' });
  }
  return value;
}

export function idList(value, field) {
  if (!Array.isArray(value) || value.length > 50) throw invalid(`${field} must be a list.`, 'invalid_input', { field });
  const out = new Set();
  for (const v of value) out.add(int(v, field, { min: 1, max: Number.MAX_SAFE_INTEGER }));
  return [...out];
}

export function id(value, field = 'id') {
  return int(value, field, { min: 1, max: Number.MAX_SAFE_INTEGER });
}
