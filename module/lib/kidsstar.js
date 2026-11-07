/**
 * KidsStar - reine Hilfen ohne DOM und ohne Netz (testbar mit node --test)
 */

/** Wochentage als Bits: Bit 0 = Montag .. Bit 6 = Sonntag (wie der Dienst). */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
export const ALL_DAYS = 0b1111111;
export const SCHOOL_DAYS = 0b0011111;
export const WEEKEND = 0b1100000;

export function maskFromDays(days) {
  let m = 0;
  for (const d of days) if (d >= 1 && d <= 7) m |= 1 << (d - 1);
  return m;
}
export function daysFromMask(mask) {
  return WEEKDAYS.filter((d) => mask & (1 << (d - 1)));
}

/** Sterne als Reihe, ab elf als Zahl. */
export function starRow(n, max = 10) {
  return n <= max ? '⭐'.repeat(Math.max(0, n)) : `⭐ × ${n}`;
}

/** Fortschritt zu einem Preis: { have, missing, pct } - have ist hoechstens der Preis. */
export function progress(available, price) {
  const have = Math.max(0, Math.min(available, price));
  return { have, missing: Math.max(0, price - available), pct: price > 0 ? Math.round((have / price) * 100) : 0 };
}

/**
 * Vorlagen fuer Aktionen. Nur Startwerte fuer das Formular: Titel kommen aus
 * der Sprachdatei, gespeichert wird, was die Eltern daraus machen.
 */
export const ACTION_TEMPLATES = [
  { key: 'teethMorning', icon: '🪥', stars: 1, weekdays: ALL_DAYS, per_day: 1, requires_approval: false },
  { key: 'teethEvening', icon: '🌙', stars: 1, weekdays: ALL_DAYS, per_day: 1, requires_approval: false },
  { key: 'tidyRoom', icon: '🧸', stars: 3, weekdays: ALL_DAYS, per_day: 1, requires_approval: true },
  { key: 'homework', icon: '📚', stars: 2, weekdays: SCHOOL_DAYS, per_day: 1, requires_approval: true },
  { key: 'setTable', icon: '🍽️', stars: 1, weekdays: ALL_DAYS, per_day: 2, requires_approval: false },
  { key: 'trash', icon: '🗑️', stars: 2, weekdays: ALL_DAYS, per_day: 1, requires_approval: true },
];

export const ACTION_ICONS = ['🪥', '🌙', '🧸', '📚', '🍽️', '🗑️', '🛏️', '👕', '🧺', '🌱', '🐕', '🚿', '🎹', '⚽', '🧹', '🥦', '⭐', '❤️'];
export const REWARD_ICONS = ['🎁', '📚', '🧸', '🍦', '🎬', '🎢', '🎮', '⚽', '🎨', '🍕', '🏊', '🚲'];

/** Bildcode am Flurtablet: dieselbe Reihenfolge wie sidecar/public/tablet/app.js. */
export const CODE_SYMBOLS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐸', '🦁', '🐵'];
export const CODE_LENGTH = 4;

/** Gut unterscheidbare Standardsymbole und Farben fuer die Profilkacheln. */
export const PROFILE_SYMBOLS = ['🦊', '🐻', '🐼', '🦁', '🐯', '🐸', '🐙', '🦄', '🐢', '🐬', '🚀', '⚽', '🌈', '🌻', '🍓', '🚒'];
export const PROFILE_COLORS = ['#F59E0B', '#EF4444', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

/** Ein Vorschlag je Kind, damit Geschwister nicht gleich aussehen. */
export function defaultLook(index) {
  return { symbol: PROFILE_SYMBOLS[index % PROFILE_SYMBOLS.length], color: PROFILE_COLORS[index % PROFILE_COLORS.length] };
}

/** Sind zwei Bildcodes gleich? */
export function sameCode(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Groesse fuer ein verkleinertes Bild: laengste Kante hoechstens max. */
export function fitSize(width, height, max = 800) {
  if (width <= max && height <= max) return { width, height };
  const f = max / Math.max(width, height);
  return { width: Math.round(width * f), height: Math.round(height * f) };
}
