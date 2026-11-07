/**
 * KidsStar - Haushaltstag
 *
 * Welcher Kalendertag "heute" ist, entscheidet die Zeitzone des Haushalts
 * (Yuvomi: Einstellungen -> Region, `timezone_effective`), nicht die Uhr des
 * Servers und nicht die des Browsers. Eine Erledigung um 23:30 in Berlin
 * gehoert zum Berliner Tag, auch wenn der Container in UTC laeuft.
 */

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ day: string, weekday: number }} day als YYYY-MM-DD, weekday 1 = Montag .. 7 = Sonntag
 */
export function householdDay(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAY[parts.weekday] };
}

/** Bitmaske der Wochentage: Bit 0 = Montag .. Bit 6 = Sonntag. */
export const ALL_WEEKDAYS = 0b1111111;

export function weekdayBit(weekday) {
  return 1 << (weekday - 1);
}
