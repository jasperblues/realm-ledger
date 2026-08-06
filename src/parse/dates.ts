/**
 * Date reading shared by every adapter.
 *
 * Exists because `07/01/25` is January 7th to QuickBooks and July 1st to MYOB, both parse
 * cleanly, and picking the wrong one silently moves a transaction across a quarter
 * boundary. Nothing downstream can detect that: the totals still balance, the line still
 * exists, it is simply in the wrong period. So the order is never assumed globally — an
 * adapter states what its source does, and where the source itself varies, it is inferred
 * from the file and refused when the file cannot settle it.
 */

/** Which of the two leading positions is the day. */
export type DateOrder = "day-first" | "month-first" | "iso";

export interface DateReader {
  order: DateOrder;
  /** ISO `YYYY-MM-DD`, or null if the value is not a date this reader accepts. */
  read(value: string): string | null;
}

/** A reader for a source whose date order is known and fixed. */
export function readerFor(order: DateOrder): DateReader {
  return { order, read: (value) => parseWith(value, order) };
}

/**
 * What the dates in [samples] can be, judged by the whole set rather than one value.
 *
 * A single date is rarely decisive; a file usually is. Any value with a first component
 * above 12 can only be a day, and one above 12 in the second position can only be a month.
 * A file containing both is contradictory and reported as such rather than resolved by
 * majority — a source that emits two conventions is broken in a way the user needs to know
 * about, not smoothed over.
 *
 * `"ambiguous"` means every date in the file happens to fall in the first twelve days of a
 * month. Rare in a year of transactions, common in a two-week sample, and genuinely
 * unresolvable from the data.
 */
export type OrderInference = DateOrder | "ambiguous" | "contradictory" | "none";

export function inferOrder(samples: readonly string[]): OrderInference {
  let sawDayFirstEvidence = false;
  let sawMonthFirstEvidence = false;
  let sawIso = false;
  let sawSlashed = false;

  for (const raw of samples) {
    const value = raw.trim();
    if (ISO.test(value)) {
      sawIso = true;
      continue;
    }
    const m = value.match(SLASHED);
    if (!m) continue;
    sawSlashed = true;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12 && second <= 12) sawDayFirstEvidence = true;
    if (second > 12 && first <= 12) sawMonthFirstEvidence = true;
  }

  if (sawDayFirstEvidence && sawMonthFirstEvidence) return "contradictory";
  if (sawDayFirstEvidence) return "day-first";
  if (sawMonthFirstEvidence) return "month-first";
  if (sawSlashed) return "ambiguous";
  if (sawIso) return "iso";
  return "none";
}

/**
 * Read [value] under a known [order].
 *
 * ISO input is accepted by every reader: a source that emits `2025-07-01` is not ambiguous
 * whatever its usual convention, and refusing it on the grounds that the adapter expected
 * slashes would reject perfectly good data.
 */
export function parseWith(value: string, order: DateOrder): string | null {
  const text = value.trim();

  const iso = text.match(ISO);
  if (iso) return validate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  if (order === "iso") return null;

  const m = text.match(SLASHED);
  if (!m) return null;

  const first = Number(m[1]);
  const second = Number(m[2]);
  const day = order === "day-first" ? first : second;
  const month = order === "day-first" ? second : first;

  return validate(expandYear(m[3]), month, day);
}

/**
 * Two-digit years are windowed to 2000–2099. Accounting exports of 20th-century books are
 * not a case worth mis-parsing this century's for.
 */
function expandYear(text: string): number {
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
}

/**
 * Reject impossible dates rather than letting them roll forward. Left to `Date`, the 31st
 * of February becomes the 2nd or 3rd of March — a real-looking date in the wrong month,
 * which is exactly the class of error this module exists to prevent.
 */
function validate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime())) return null;
  if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return iso;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
