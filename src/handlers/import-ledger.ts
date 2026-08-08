import { parseCeeData, claimsCeeData, SIGNATURE } from "../parse/myob-ceedata";
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
  kg: {
    query(args: { cypher: string; params?: Record<string, unknown> }): Promise<{
      rows: Record<string, unknown>[];
      warnings: string[];
    }>;
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

  await writeLedger(ledger);

  return summarise(filename, result);
}

/**
 * Replace the declared window, then write.
 *
 * Replace-by-window rather than merge-by-line: the file header declares exactly what it covers,
 * so deleting that range and re-inserting is idempotent no matter how many times the same period
 * is exported, and does not depend on line ids being stable across exports (they are not
 * guaranteed to be). Amended prior-period transactions correct themselves for free.
 */
async function writeLedger(ledger: Ledger): Promise<void> {
  const { entity, from, to, source } = ledger.coverage;

  // Delete first. Entries and transactions within the window only — accounts are reference data
  // shared across windows and are upserted rather than replaced.
  await gateway.kg.query({
    cypher: `
      MATCH (e:LedgerEntry)
      WHERE e.entity = $entity AND e.source = $source AND e.date >= $from AND e.date <= $to
      DETACH DELETE e
    `,
    params: { entity, source, from, to },
  });
  await gateway.kg.query({
    cypher: `
      MATCH (t:LedgerTransaction)
      WHERE t.entity = $entity AND t.source = $source AND t.date >= $from AND t.date <= $to
      DETACH DELETE t
    `,
    params: { entity, source, from, to },
  });

  for (const chunk of chunked(ledger.accounts, 200)) {
    await gateway.kg.query({
      cypher: `
        UNWIND $rows AS row
        MERGE (a:LedgerAccount {key: row.key})
        SET a.code = row.code, a.name = row.name, a.accountType = row.accountType,
            a.parentCode = row.parentCode, a.taxCode = row.taxCode,
            a.header = row.header, a.active = row.active,
            a.entity = row.entity, a.source = row.source
      `,
      params: {
        rows: chunk.map((a) => ({
          key: `${source}:${entity}:${a.code}`,
          code: a.code,
          name: a.name,
          accountType: a.type,
          parentCode: a.parent ?? null,
          taxCode: a.taxCode ?? null,
          header: a.header,
          active: a.active,
          entity,
          source,
        })),
      },
    });
  }

  // Transactions carry the narration of their first posting: the counterparty is named there,
  // and it is what "who did we pay" reads.
  const byRef = groupByRef(ledger);
  for (const chunk of chunked([...byRef.values()], 200)) {
    await gateway.kg.query({
      cypher: `
        UNWIND $rows AS row
        MERGE (t:LedgerTransaction {key: row.key})
        SET t.reference = row.reference, t.date = row.date, t.narration = row.narration,
            t.entity = row.entity, t.source = row.source
      `,
      params: {
        rows: chunk.map((t) => ({
          key: `${source}:${entity}:${t.reference}`,
          reference: t.reference,
          date: t.date,
          narration: t.narration,
          entity,
          source,
        })),
      },
    });
  }

  for (const chunk of chunked(ledger.lines, 200)) {
    await gateway.kg.query({
      cypher: `
        UNWIND $rows AS row
        MERGE (e:LedgerEntry {key: row.key})
        SET e.amount = row.amount, e.date = row.date, e.accountCode = row.accountCode,
            e.description = row.description, e.entity = row.entity, e.source = row.source
        WITH e, row
        MATCH (t:LedgerTransaction {key: row.transactionKey})
        MERGE (t)-[:HAS_ENTRY]->(e)
        WITH e, row
        MATCH (a:LedgerAccount {key: row.accountKey})
        MERGE (e)-[:POSTED_TO]->(a)
      `,
      params: {
        rows: chunk.map((l, i) => ({
          key: `${source}:${entity}:${l.transactionRef}:${l.lineId ?? i}`,
          transactionKey: `${source}:${entity}:${l.transactionRef}`,
          accountKey: `${source}:${entity}:${l.accountCode}`,
          amount: l.amount,
          date: l.date,
          accountCode: l.accountCode,
          description: l.description,
          entity,
          source,
        })),
      },
    });
  }

  // Coverage last, so a record only exists for data that actually landed. Written after the
  // rows precisely so a crash mid-import leaves no claim to completeness.
  await gateway.kg.query({
    cypher: `
      MERGE (c:LedgerCoverage {key: $key})
      SET c.entity = $entity, c.fromDate = $from, c.toDate = $to, c.source = $source,
          c.importedAt = $importedAt, c.lineCount = $lineCount, c.rejectedCount = $rejectedCount
    `,
    params: {
      key: `${source}:${entity}:${from}:${to}`,
      entity,
      from,
      to,
      source,
      importedAt: new Date().toISOString(),
      lineCount: ledger.lines.length,
      rejectedCount: 0,
    },
  });
}

/** One transaction per reference, taking its date and narration from the first posting seen. */
function groupByRef(ledger: Ledger) {
  const byRef = new Map<string, { reference: string; date: string; narration: string }>();
  for (const line of ledger.lines) {
    if (!byRef.has(line.transactionRef)) {
      byRef.set(line.transactionRef, {
        reference: line.transactionRef,
        date: line.date,
        narration: line.description,
      });
    }
  }
  return byRef;
}

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
function summarise(filename: string, result: ParseResult): string {
  const { ledger, rejected, clarifications } = result;
  const { entity, from, to } = ledger.coverage;

  const parts = [
    `Imported ${ledger.lines.length} postings and ${ledger.accounts.length} accounts ` +
      `for ${entity}, covering ${from} to ${to}, from ${filename}.`,
  ];
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
