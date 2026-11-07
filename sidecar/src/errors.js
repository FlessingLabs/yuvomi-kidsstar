/**
 * KidsStar - Fehler mit HTTP-Status und maschinenlesbarem Grund
 *
 * `reason` ist der Vertrag mit der Oberflaeche: sie uebersetzt den Grund,
 * nie den englischen Text der Meldung.
 */

export class HttpError extends Error {
  constructor(status, message, reason, extra = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

export const notFound = (what = 'Not found.', reason = 'not_found') => new HttpError(404, what, reason);
export const forbidden = (what = 'Not allowed.', reason = 'forbidden') => new HttpError(403, what, reason);
export const conflict = (what, reason, extra) => new HttpError(409, what, reason, extra);
export const invalid = (what, reason = 'invalid_input', extra) => new HttpError(400, what, reason, extra);
