import { parseCeeData, claimsCeeData, SIGNATURE } from "../parse/myob-ceedata";
import { resolveCounterparties } from "../parse/counterparty";
import type { Ledger, ParseResult } from "../parse/model";

/**
 * Imports a general ledger export attached to a conversation.
 *
 * Wakes on `attachment.received`. The declarative match in `import-ledger.yml` narrows to text
 * files whose content starts with the CeeData signature, so this handler is normally not woken
 * at all for anything else — but it re-checks, because a pre-filter is a cheap exclusion and not
 * a guarantee, and acting on a file that merely looked right is how you corrupt a ledger.
 *
 * Bundled from source at build time: the spec loader inlines exactly ONE file, so a handler
 * cannot import its own parser at runtime. The parser stays in `src/parse` where it is tested,
 * and `npm run build` bundles this entry point into `actions/import-ledger.ts`.
 */

/**
 * The runtime provides `signal` and `gateway` in scope.
 *
 * Type-specific fields live under `properties`, not at the top level: the host wraps a signal in
 * an envelope where only wire fields (id, typeName, subject, occurredAt, source) are lifted, and
 * everything else is a property. Reading `signal.storageKey` yields undefined, which reaches the
 * gateway as a missing parameter and reports itself as a gateway error rather than a signal one.
 */
declare const signal: {
  id: string;
  typeName: string;
  subject: string;
  occurredAt: string;
  properties: {
    attachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    caption: string;
    conversationId: string;
  };
};

declare const gateway: {
  attachment: {
    head(args: { storageKey: string; maxChars?: number }): Promise<string>;
    read(args: { storageKey: string }): Promise<string>;
  };
  repository: {
    /**
     * Bulk upsert. Identity-keyed MERGE per row, so re-importing a period updates in place
     * instead of duplicating. Relations are not supported here — see the note on joins below.
     */
    createEntries(args: { type: string; rows: Record<string, unknown>[] }): Promise<string>;
  };
  /**
   * Optional: older assistants do not expose it. Never call it unguarded — this realm is cloned at
   * `main` by whoever installs it, so it must keep working against a host that predates the tool.
   */
  progress?: {
    report(args: { message: string }): Promise<string>;
  };
};

export default async function importLedger(): Promise<string> {
  // Cheap confirmation first. `head` reads a bounded prefix, so a file that is not ours costs a
  // few hundred characters rather than the whole export.
  const { storageKey, filename } = signal.properties;

  const head = await gateway.attachment.head({
    storageKey,
    maxChars: SIGNATURE.length + 64,
  });
  if (!claimsCeeData(head)) {
    return `Not a CeeData export (${filename}); leaving it alone.`;
  }

  const text = await gateway.attachment.read({ storageKey });
  const result = parseCeeData(text);
  const { ledger, rejected, clarifications } = result;

  if (!ledger.coverage.from || !ledger.coverage.to) {
    // Without a declared window an import cannot safely supersede an earlier one, so refuse
    // rather than write data that can never be cleanly replaced.
    return (
      `${filename} does not declare which period it covers, so it cannot be imported ` +
      `safely — a later export of the same period would double the totals rather than replace them.`
    );
  }

  const written = await writeLedger(ledger);

  return summarise(filename, result, written);
}

/**
 * Upsert everything the file contains.
 *
 * UPSERT, NOT REPLACE. Replacing a date range would need a bulk delete, and the repository surface
 * deletes one entry at a time by id — so a "replace the window" import would be thousands of
 * round-trips to remove rows before thousands more to write them. Upsert gets what a re-export
 * actually needs: postings already held are updated in place, new ones are appended.
 *
 * What upsert does NOT do: notice a transaction DELETED in the accounting package. It will linger.
 * That is a real limitation and the reason this reports what it wrote rather than claiming the
 * graph now mirrors the file.
 *
 * JOINS BY PROPERTY, NOT EDGE. A batch create cannot carry relations, so a posting records its
 * `accountCode` and `transactionRef` as fields and the views join on them. Less graph-shaped, but
 * correct and idempotent; edges can be added later without changing what a row means.
 */
async function writeLedger(ledger: Ledger): Promise<WriteCounts> {
  const { entity, source } = ledger.coverage;

  await inBatches(ledger.accounts, (a) => ({
    // Keyed on the account code within one company's books: a code is unique per entity, and a
    // user may keep more than one set.
    key: `${source}:${entity}:${a.code}`,
    title: a.name,
    code: a.code,
    accountType: a.type,
    parentCode: a.parent ?? null,
    taxCode: a.taxCode ?? null,
    header: a.header,
    active: a.active,
    entity,
    source,
  }), "LedgerAccount", "accounts");

  const transactions = [...groupByRef(ledger).values()];
  await inBatches(transactions, (t) => ({
    key: `${source}:${entity}:${t.reference}`,
    title: t.counterparty ?? t.narration,
    reference: t.reference,
    date: t.date,
    narration: t.narration,
    counterparty: t.counterparty,
    entity,
    source,
  }), "LedgerTransaction", "transactions");

  const postings = await inBatches(postingRows(ledger), (r) => r, "LedgerEntry", "postings");

  // Coverage last, so a record only exists for data that actually landed.
  await gateway.repository.createEntries({
    type: "LedgerCoverage",
    rows: [{
      key: `${source}:${entity}:${ledger.coverage.from}:${ledger.coverage.to}`,
      title: `${entity} ${ledger.coverage.from} to ${ledger.coverage.to}`,
      entity,
      fromDate: ledger.coverage.from,
      toDate: ledger.coverage.to,
      source,
      importedAt: new Date().toISOString(),
      lineCount: ledger.lines.length,
    }],
  });

  return postings;
}

/**
 * A stable identity for each posting, derived from the data rather than the vendor's line id.
 *
 * The export carries its own line id, but nothing promises it survives a re-export — and if it is
 * regenerated, keying on it turns every re-import into a duplicate set. Position within a
 * transaction is derivable from the file itself and stable as long as the package emits a
 * transaction's postings in the same order, which is a far weaker assumption.
 */
function postingRows(ledger: Ledger): Record<string, unknown>[] {
  const { entity, source } = ledger.coverage;
  const ordinals = new Map<string, number>();
  const accounts = new Map(ledger.accounts.map((a) => [a.code, a]));
  const counterparties = resolveCounterparties(ledger);
  return ledger.lines.map((l) => {
    const seen = ordinals.get(l.transactionRef) ?? 0;
    ordinals.set(l.transactionRef, seen + 1);
    const account = accounts.get(l.accountCode);
    const party = counterparties.get(l);
    return {
      key: `${source}:${entity}:${l.transactionRef}:${seen}`,
      title: l.description || `${l.accountCode} ${l.amount}`,
      amount: l.amount,
      date: l.date,
      accountCode: l.accountCode,
      // Carried on the posting, not left to a join. A question like "spend by supplier" is one
      // GROUP BY over these fields; without them the only path is a traversal, and this graph has
      // no edges between postings, accounts and transactions to traverse. A model asked to
      // aggregate invented `HAS_ACCOUNT`, got nothing, and reported the category as having no
      // data at all.
      accountName: account?.name ?? null,
      accountType: account?.type ?? null,
      counterparty: party?.name ?? null,
      counterpartyKey: party?.key ?? null,
      // The text the name was read from, so a report can show which spellings it merged rather
      // than asking anyone to trust the merge.
      counterpartyNarration: party?.narration ?? null,
      counterpartySource: party?.source ?? null,
      transactionRef: l.transactionRef,
      description: l.description,
      entity,
      source,
    };
  });
}

/**
 * One transaction per reference.
 *
 * Narration comes from the counterparty leg where there is one, NOT from whichever posting was
 * seen first. First-seen made a transaction's identity depend on file order: the same client's
 * invoices surfaced sometimes as "Sale; <client>" and sometimes as a timesheet, so grouping by
 * transaction narration split one client across a dozen apparent parties.
 */
function groupByRef(ledger: Ledger) {
  const counterparties = resolveCounterparties(ledger);
  const byRef = new Map<
    string,
    { reference: string; date: string; narration: string; counterparty: string | null }
  >();
  for (const line of ledger.lines) {
    const party = counterparties.get(line);
    const existing = byRef.get(line.transactionRef);
    if (!existing) {
      byRef.set(line.transactionRef, {
        reference: line.transactionRef,
        date: line.date,
        narration: party?.narration ?? line.description,
        counterparty: party?.name ?? null,
      });
    } else if (!existing.counterparty && party) {
      // A later leg resolved a party the first one could not. Take it: a transaction with a known
      // counterparty is strictly better identified than one narrated by whichever line came first.
      existing.narration = party.narration;
      existing.counterparty = party.name;
    }
  }
  return byRef;
}

/** How many rows a write actually added, as opposed to how many it sent. */
export interface WriteCounts {
  created: number;
  updated: number;
}

/**
 * Read the counts back out of the store's summary line.
 *
 * The store distinguishes a fresh node from a MERGE onto an existing one; without reading that
 * back, this handler can only report how many rows it PARSED — which announces a successful
 * import of 2,340 postings when a re-run of an unchanged export changed nothing at all.
 *
 * An unrecognised summary counts as zero rather than guessing: under-reporting is recoverable,
 * a fabricated "added 2,340" is not.
 */
export function parseWriteCounts(summary: string): WriteCounts {
  const created = /Created (\d+) new/.exec(summary);
  const updated = /[Uu]pdated (\d+) existing/.exec(summary);
  return {
    created: created ? Number(created[1]) : 0,
    updated: updated ? Number(updated[1]) : 0,
  };
}

/** Send in chunks: one call per chunk, each validated and written as a set. */
async function inBatches<T>(
  items: T[],
  toRow: (item: T) => Record<string, unknown>,
  type: string,
  label: string,
): Promise<WriteCounts> {
  const total: WriteCounts = { created: 0, updated: 0 };
  const batches = chunked(items, BATCH_SIZE);
  let done = 0;
  for (const chunk of batches) {
    const summary = await gateway.repository.createEntries({ type, rows: chunk.map(toRow) });
    const counts = parseWriteCounts(summary);
    total.created += counts.created;
    total.updated += counts.updated;
    done += chunk.length;
    // AFTER the write, so "imported 1,200" means 1,200 are in the graph. Reporting on entry would
    // claim work that has not happened — the same lie as counting parsed rows instead of written
    // ones. Only worth saying when there is more than one batch: a single-batch import would just
    // announce itself once, immediately before finishing.
    if (batches.length > 1) await report(`imported ${done} of ${items.length} ${label}`);
  }
  return total;
}

/**
 * Say how far along we are, if anyone is listening.
 *
 * Guarded twice over: the namespace is absent on assistants that predate it, and a failure to
 * report must never fail an import that is otherwise going fine. Progress is decoration.
 */
async function report(message: string): Promise<void> {
  try {
    await gateway.progress?.report({ message });
  } catch {
    // Nobody to tell, or the channel has gone. The import continues either way.
  }
}

const BATCH_SIZE = 200;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * What to tell the user.
 *
 * Reports the rejected count whenever it is non-zero, because "2,338 of 2,340" is a different
 * claim from "2,340", and surfaces clarifications so an assumption the parser had to make is
 * visible rather than buried.
 */
function summarise(filename: string, result: ParseResult, written: WriteCounts): string {
  const { ledger, rejected, clarifications } = result;
  const { entity, from, to } = ledger.coverage;
  const { created, updated } = written;

  // Report what CHANGED, not what was parsed. Re-importing an unchanged export sends every row
  // and moves nothing; saying "imported 2,340 postings" there is a success message for a no-op,
  // and the person appending a partial year is the one who most needs the difference.
  const scope = `for ${entity}, covering ${from} to ${to}, from ${filename}.`;
  const headline =
    created === 0 && updated > 0
      ? `No new postings: all ${updated} in this file were already in your ledger, ${scope}`
      : updated === 0
        ? `Imported ${created} postings and ${ledger.accounts.length} accounts ${scope}`
        : `Added ${created} new postings and refreshed ${updated} already present, ` +
          `across ${ledger.accounts.length} accounts, ${scope}`;

  const parts = [headline];
  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} row(s) could not be read: ` +
        rejected.slice(0, 3).map((r) => `line ${r.line} (${r.reason})`).join("; ") +
        (rejected.length > 3 ? `, and ${rejected.length - 3} more.` : "."),
    );
  }
  for (const c of clarifications) {
    parts.push(`${c.question} ${c.reason}. For now it was ${c.assumed}.`);
  }
  return parts.join(" ");
}
