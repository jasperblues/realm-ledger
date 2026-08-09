import type { Account, JournalLine, Ledger } from "./model";

/**
 * Who the other side of a transaction was.
 *
 * The counterparty is never on the income or expense line. A sale posts three legs sharing one
 * reference: the income leg carries the WORK ("August 29th; August 28th; …"), the receivable leg
 * carries the CLIENT ("Sale; Embabel Pty Limited"), and GST carries a copy. Reading the income
 * leg's own text therefore answers "what was done", not "who paid" — and grouping by it splits one
 * client into a dozen timesheets.
 *
 * Across a full year of one real export: 36 income transactions, 25 invoices (client on the
 * receivable leg only) and 11 direct receipts (both legs carrying the same bank text). Zero cases
 * where a receivable leg carried a timesheet. The rule below relies on that asymmetry, and on the
 * general shape of double entry rather than a vendor quirk: the income account records WHAT was
 * earned, the asset account records WHO paid.
 */
export interface Counterparty {
  /** Canonical display name, identical for every variant spelling of the same party. */
  name: string;
  /** Match key — case- and punctuation-free, company suffixes removed. */
  key: string;
  /** The raw narration this was read from, kept so a report can show its working. */
  narration: string;
  /** Which leg it came from. An invoice name is human-entered; a bank name is a feed. */
  source: "invoice" | "bank" | "same-leg";
}

/** Bank-feed noise that follows a party name: transaction type, reference, date. */
const NOISE = new RegExp(
  String.raw`\s+(fees?|funds?\s+transfer|short\s+payment|payment|transfer|rcti|refund\w*|` +
    String.raw`invoice|inv|ref|receipt|deposit|dishonour\w*)\b.*$`,
  "i",
);
const TRAILING_REFERENCE = /\s+[A-Z]*\d[\d-]{3,}\w*\s*$/;
const LEADING_DOCUMENT = /^(sale|purchase|payment|receipt)\s*;\s*/i;
const COMPANY_SUFFIX = /\b(pty|ltd|limited|pte|inc|incorporated|llc|plc|co|company)\b/gi;

/**
 * Strip a narration down to the party.
 *
 * Order matters: the document prefix goes first so "Sale; X" and a bank line reduce to the same
 * stem, then transaction-type noise, then a trailing reference number. Each step only ever removes
 * a suffix or a known prefix — nothing rewrites the middle, so a party whose name contains one of
 * these words keeps it unless it trails.
 */
export function stripNarration(raw: string): string {
  return raw
    .replace(LEADING_DOCUMENT, "")
    .replace(NOISE, "")
    .replace(TRAILING_REFERENCE, "")
    .replace(/\s+/g, " ")
    .replace(/[;,.\s]+$/, "")
    .trim();
}

/**
 * Match key for a party.
 *
 * Company suffixes are dropped because the same entity appears as "Embabel Pty Limited" on an
 * invoice and "EMBABEL PTY LIMITED" on a bank feed, and elsewhere as neither. Dropping them cannot
 * merge two parties that differ only by suffix — "Acme Pty Ltd" and "Acme Ltd" are the same name
 * with different legal forms, which is far more likely to be one misspelling than two companies.
 */
export function counterpartyKey(raw: string): string {
  return stripNarration(raw).replace(COMPANY_SUFFIX, "").replace(/[^a-z0-9]+/gi, "").toUpperCase();
}

/** Asset accounts hold the other side: receivable for an invoice, bank for a direct receipt. */
function isCounterpartySide(account: Account | undefined): boolean {
  return account?.type === "asset" || account?.type === "liability";
}

/**
 * The counterparty leg for one posting, or null when the transaction has no other side to read.
 *
 * Returns null rather than falling back to the posting's own text when the shape is unrecognised.
 * A guessed counterparty is worse than a missing one here: these figures decide whether income is
 * concentrated above a statutory threshold, and a wrong attribution moves that number silently.
 */
export function counterpartyLegFor(
  line: JournalLine,
  linesByRef: Map<string, JournalLine[]>,
  accounts: Map<string, Account>,
): { narration: string; source: Counterparty["source"] } | null {
  const siblings = linesByRef.get(line.transactionRef) ?? [];
  const other = siblings.filter(
    (l) => l !== line && isCounterpartySide(accounts.get(l.accountCode)) && l.description.trim(),
  );
  if (other.length === 0) return null;

  // A receivable/payable leg names a party an invoice was raised against; a bank leg carries the
  // feed's own text. Prefer the invoice: it was typed by someone who knew who the client was.
  const invoice = other.find((l) => LEADING_DOCUMENT.test(l.description));
  if (invoice) return { narration: invoice.description.trim(), source: "invoice" };

  const bank = other[0];
  const sameText = bank.description.trim() === line.description.trim();
  return { narration: bank.description.trim(), source: sameText ? "same-leg" : "bank" };
}

/**
 * Resolve every posting's counterparty, in two passes.
 *
 * The second pass exists so one party gets ONE name. Variants are collected per key first, then a
 * single display name is chosen for all of them — otherwise "Embabel Pty Limited" and
 * "EMBABEL PTY LIMITED" reach the graph as written and every later `GROUP BY counterparty` splits
 * the client again, which is the whole defect this function exists to close.
 *
 * The invoice spelling wins because a human chose it. Failing that, the longest variant wins: it
 * is the one that lost the least to noise-stripping.
 */
export function resolveCounterparties(ledger: Ledger): Map<JournalLine, Counterparty> {
  const accounts = new Map(ledger.accounts.map((a) => [a.code, a]));
  const linesByRef = new Map<string, JournalLine[]>();
  for (const line of ledger.lines) {
    const at = linesByRef.get(line.transactionRef);
    if (at) at.push(line);
    else linesByRef.set(line.transactionRef, [line]);
  }

  const found = new Map<JournalLine, { narration: string; source: Counterparty["source"] }>();
  const variants = new Map<string, { narration: string; source: Counterparty["source"] }[]>();
  for (const line of ledger.lines) {
    const leg = counterpartyLegFor(line, linesByRef, accounts);
    if (!leg) continue;
    found.set(line, leg);
    const key = counterpartyKey(leg.narration);
    if (!key) continue;
    const at = variants.get(key);
    if (at) at.push(leg);
    else variants.set(key, [leg]);
  }

  const display = new Map<string, string>();
  for (const [key, seen] of variants) {
    const invoice = seen.find((v) => v.source === "invoice");
    const chosen = invoice
      ? stripNarration(invoice.narration)
      : seen.map((v) => stripNarration(v.narration)).sort((a, b) => b.length - a.length)[0];
    display.set(key, chosen);
  }

  const out = new Map<JournalLine, Counterparty>();
  for (const [line, leg] of found) {
    const key = counterpartyKey(leg.narration);
    if (!key) continue;
    out.set(line, {
      name: display.get(key) ?? stripNarration(leg.narration),
      key,
      narration: leg.narration,
      source: leg.source,
    });
  }
  return out;
}
