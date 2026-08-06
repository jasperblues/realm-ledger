import type {
  Account,
  AccountType,
  JournalLine,
  ParseResult,
  RejectedRow,
} from "./model";
import { inferOrder, parseWith, type DateOrder } from "./dates";

/**
 * Adapter for MYOB's "Data for Accountant" export (CeeData).
 *
 * The format is tilde-delimited with a record-type prefix per line, and three record types
 * interleaved in one file:
 *
 *   CDS1~<entity>~<from>~<to>              header, once, first
 *   AC~<code>~<name>                       chart of accounts
 *   TR~<id>~<dd/mm/yy>~<code>~<ref>~<amount>~~<description>~
 *
 * Two things about it shape everything downstream. The header declares the file's own
 * coverage window, which is what makes replace-by-window imports safe: a re-export of the
 * same period can supersede it wholesale, without depending on line ids being stable across
 * exports. And field 5 groups the lines of a transaction, which is the only reason a sale's
 * customer (named on the receivable line) can be tied to its revenue (on the income line).
 *
 * Chosen as the reference adapter because it is unusually well behaved: flat, one line per
 * posting, and carrying a working transaction key. Report-style exports from other packages
 * are messier and will need more from their adapters, not less.
 */
export function parseCeeData(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const rejected: RejectedRow[] = [];

  const header = findHeader(lines, rejected);

  const accounts = lines
    .map((raw, i) => parseAccount(raw, i + 1, rejected))
    .filter((a): a is Account => a !== null);

  checkDateOrder(
    lines.filter((l) => l.startsWith("TR~")).map((l) => l.split("~")[2] ?? ""),
    rejected,
  );

  const journal = lines
    .map((raw, i) => parseLine(raw, i + 1, rejected))
    .filter((l): l is JournalLine => l !== null);

  return {
    ledger: {
      coverage: {
        entity: header.entity,
        from: header.from,
        to: header.to,
        source: SOURCE,
      },
      accounts,
      lines: journal,
    },
    rejected,
  };
}

export const SOURCE = "myob-ceedata";

/** Content signature — the first bytes of any CeeData file. */
export const SIGNATURE = "CDS1~";

/** Whether this adapter recognises the content. Cheap: reads the first line only. */
export function claimsCeeData(text: string): boolean {
  return text.startsWith(SIGNATURE);
}

interface Header {
  entity: string;
  from: string;
  to: string;
}

function findHeader(lines: string[], rejected: RejectedRow[]): Header {
  const index = lines.findIndex((l) => l.startsWith(SIGNATURE));
  if (index < 0) {
    // Not fatal on its own: the accounts and postings may still parse. But without a
    // declared window the caller cannot safely replace a period, so this is loud.
    rejected.push({
      line: 0,
      reason:
        "no CDS1 header, so the file does not declare which period it covers; " +
        "an import cannot safely supersede an earlier one",
      raw: "",
    });
    return { entity: "", from: "", to: "" };
  }
  const fields = lines[index].split("~");
  return {
    entity: (fields[1] ?? "").trim(),
    from: toIsoDate(fields[2] ?? "") ?? "",
    to: toIsoDate(fields[3] ?? "") ?? "",
  };
}

function parseAccount(raw: string, lineNumber: number, rejected: RejectedRow[]): Account | null {
  if (!raw.startsWith("AC~")) return null;
  const f = raw.split("~");
  const code = (f[1] ?? "").trim();
  const name = (f[2] ?? "").trim();
  if (!code) {
    rejected.push({ line: lineNumber, reason: "account row has no code", raw: truncate(raw) });
    return null;
  }
  return {
    code,
    name,
    // CeeData carries no classification, only the code. The leading digit is MYOB's own
    // convention and is the only signal present; the richer chart-of-accounts export
    // supplies real types and supersedes this when both are imported.
    type: typeFromCode(code),
    header: false,
    active: true,
  };
}

function parseLine(raw: string, lineNumber: number, rejected: RejectedRow[]): JournalLine | null {
  if (!raw.startsWith("TR~")) return null;
  const f = raw.split("~");

  const date = toIsoDate((f[2] ?? "").trim());
  const accountCode = (f[3] ?? "").trim();
  const transactionRef = (f[4] ?? "").trim();
  const amountText = (f[5] ?? "").trim();
  const amount = Number(amountText);

  if (!date) {
    rejected.push({ line: lineNumber, reason: `unreadable date '${f[2] ?? ""}'`, raw: truncate(raw) });
    return null;
  }
  if (!accountCode) {
    rejected.push({ line: lineNumber, reason: "posting has no account code", raw: truncate(raw) });
    return null;
  }
  if (amountText === "" || Number.isNaN(amount)) {
    // Never default a missing amount to zero. A zero posting is a real thing and would
    // silently join the totals as if it were the truth.
    rejected.push({ line: lineNumber, reason: `unreadable amount '${amountText}'`, raw: truncate(raw) });
    return null;
  }
  if (!transactionRef) {
    rejected.push({
      line: lineNumber,
      reason: "posting has no transaction reference, so it cannot be tied to its counterpart",
      raw: truncate(raw),
    });
    return null;
  }

  return {
    transactionRef,
    date,
    accountCode,
    amount,
    description: (f[7] ?? "").trim(),
    lineId: (f[1] ?? "").trim() || undefined,
  };
}

/**
 * MYOB is an AU/NZ product and writes dates day-first. Declared here rather than assumed
 * globally: the same `07/01/25` is July 1st here and January 7th out of a US package, and
 * both parse, so the convention has to travel with the adapter that knows it.
 */
export const DATE_ORDER: DateOrder = "day-first";

export function toIsoDate(value: string): string | null {
  return parseWith(value, DATE_ORDER);
}

/**
 * Check the file against the convention we claim it uses.
 *
 * Cheap insurance against a format change or a mis-set locale: if a file turns out to carry
 * month-first dates, reading it day-first would move transactions between periods without
 * a single row failing to parse. Better to say so than to import silently wrong books.
 */
function checkDateOrder(dates: readonly string[], rejected: RejectedRow[]): void {
  const inferred = inferOrder(dates);
  if (inferred === "contradictory") {
    rejected.push({
      line: 0,
      reason:
        "the file mixes day-first and month-first dates, so some transactions would land " +
        "in the wrong period whichever reading is used",
      raw: "",
    });
    return;
  }
  if (inferred !== "day-first" && inferred !== "ambiguous" && inferred !== "none") {
    rejected.push({
      line: 0,
      reason:
        `dates look ${inferred}, but this export is read day-first; ` +
        "transactions would be placed in the wrong period",
      raw: "",
    });
  }
}

/** MYOB's account-number convention. A hint only — see the note in [parseAccount]. */
function typeFromCode(code: string): AccountType {
  switch (code.charAt(0)) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "income";
    case "5":
      return "cost-of-sales";
    case "6":
      return "expense";
    case "8":
      return "other-income";
    case "9":
      return "other-expense";
    default:
      return "unknown";
  }
}

function truncate(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}
