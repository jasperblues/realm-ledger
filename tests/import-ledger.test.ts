import { describe, it, expect, beforeEach, vi } from "vitest";
import importLedger from "../src/handlers/import-ledger";

/**
 * The import handler, driven against a fake gateway.
 *
 * The handler reads `signal` and `gateway` from its enclosing scope, which the runtime provides.
 * Here they are set as globals before importing the module, which is also a fair simulation of
 * how it actually runs: the bundled source is evaluated with those names in scope.
 */

interface Write {
  type: string;
  rows: Record<string, unknown>[];
}

function setup(fileContent: string, filename = "ledger.txt") {
  const writes: Write[] = [];
  const reads: string[] = [];

  // Mirrors the host's SignalEnvelope: only wire fields are lifted, everything type-specific
  // sits under `properties`. Getting this wrong in the fake is how the real bug survived tests.
  (globalThis as any).signal = {
    id: "sig-1",
    typeName: "attachment.received",
    subject: `Attachment received: ${filename}`,
    occurredAt: "2026-08-08T04:18:59Z",
    properties: {
      attachmentId: "att-1",
      filename,
      mimeType: "text/plain",
      sizeBytes: fileContent.length,
      storageKey: `chat-attachments/ben/${filename}`,
      caption: "",
      conversationId: "conv-1",
    },
  };

  (globalThis as any).gateway = {
    attachment: {
      head: vi.fn(async ({ maxChars }: { maxChars?: number }) =>
        fileContent.slice(0, maxChars ?? 512),
      ),
      read: vi.fn(async () => {
        reads.push("read");
        return fileContent;
      }),
    },
    repository: {
      createEntries: vi.fn(async (w: Write) => {
        writes.push(w);
        return `Created or updated ${w.rows.length} ${w.type} entries.`;
      }),
    },
  };

  return { writes, reads };
}

/**
 * One static import is enough: the handler reads `signal` and `gateway` when it RUNS, not when
 * the module loads, so setting the globals per test is all that is required.
 */
const runHandler = (): Promise<string> => importLedger();

const LEDGER = [
  "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
  "AC~6-4390~Staff Amenities",
  "AC~4-1400~Sales - GST",
  "TR~1~03/07/25~6-4390~REF1~42.50~~COFFEE SHOP~",
  "TR~2~04/07/25~4-1400~REF2~-100.00~~Sale; Widgets Ltd~",
].join("\n");

describe("claiming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports a CeeData export", async () => {
    const { writes, reads } = setup(LEDGER);

    const message = await runHandler();

    expect(reads).toHaveLength(1);
    expect(message).toContain("Acme Pty Ltd");
    expect(message).toContain("2025-07-01");
    expect(writes.length).toBeGreaterThan(0);
  });

  it("declines anything without the signature, without reading the file", async () => {
    // The whole point of head(): a file that is not ours costs a few hundred characters, not
    // the whole export.
    const { writes, reads } = setup("milk, bread, coffee", "shopping.txt");

    const message = await runHandler();

    expect(message).toContain("Not a CeeData export");
    expect(reads).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("re-checks content even though the host pre-filtered", async () => {
    // A pre-filter is a cheap exclusion, not a guarantee. Acting on a file that merely looked
    // right is how a ledger gets corrupted.
    const { writes } = setup("CDS-NOT-REALLY~Acme");

    await runHandler();

    expect(writes).toHaveLength(0);
  });
});

describe("writing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const rowsFor = (writes: Write[], type: string) =>
    writes.filter((w) => w.type === type).flatMap((w) => w.rows);

  it("upserts accounts, transactions and postings", () => {
    const { writes } = setup(LEDGER);
    return runHandler().then(() => {
      expect(rowsFor(writes, "LedgerAccount")).toHaveLength(2);
      expect(rowsFor(writes, "LedgerTransaction")).toHaveLength(2);
      expect(rowsFor(writes, "LedgerEntry")).toHaveLength(2);
    });
  });

  it("writes coverage last, so it never claims data that did not land", async () => {
    const { writes } = setup(LEDGER);

    await runHandler();

    expect(writes[writes.length - 1].type).toBe("LedgerCoverage");
  });

  it("keys entities on source and entity so two companies never collide", async () => {
    const { writes } = setup(LEDGER);

    await runHandler();

    expect(rowsFor(writes, "LedgerAccount")[0].key).toBe("myob-ceedata:Acme Pty Ltd:6-4390");
  });

  it("keys a posting by its position in its transaction, not the vendor's line id", async () => {
    // Nothing promises the export's own line id survives a re-export. Position within a
    // transaction is derivable from the file and stable under a far weaker assumption.
    const { writes } = setup(LEDGER);

    await runHandler();

    expect(rowsFor(writes, "LedgerEntry").map((r) => r.key)).toEqual([
      "myob-ceedata:Acme Pty Ltd:REF1:0",
      "myob-ceedata:Acme Pty Ltd:REF2:0",
    ]);
  });

  it("gives every row a title, so entries are not invisible in entity surfaces", async () => {
    const { writes } = setup(LEDGER);

    await runHandler();

    expect(writes.flatMap((w) => w.rows).every((r) => !!r.title)).toBe(true);
  });

  it("carries the join fields, since a batch cannot create edges", async () => {
    const { writes } = setup(LEDGER);

    await runHandler();

    const posting = rowsFor(writes, "LedgerEntry")[0];
    expect(posting.accountCode).toBe("6-4390");
    expect(posting.transactionRef).toBe("REF1");
  });

  it("preserves the sign of each posting", async () => {
    // Income is credited and therefore negative. Absolute-valuing on import would make income
    // and expenditure indistinguishable.
    const { writes } = setup(LEDGER);

    await runHandler();

    expect(rowsFor(writes, "LedgerEntry").map((r) => r.amount)).toEqual([42.5, -100]);
  });
});

describe("refusing to import unsafely", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a file that does not declare its period", async () => {
    // Without a window an import cannot be superseded, so a later export of the same period
    // would double the totals rather than replace them.
    const noHeader = ["CDS1~", "TR~1~03/07/25~6-4390~REF1~42.50~~COFFEE~"].join("\n");
    const { writes } = setup(noHeader);

    const message = await runHandler();

    expect(message).toContain("does not declare which period");
    expect(writes).toHaveLength(0);
  });
});

describe("reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports rows it could not read", async () => {
    // "2,338 of 2,340" is a different claim from "2,340".
    const withBad = [
      "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
      "AC~6-4390~Staff Amenities",
      "TR~1~03/07/25~6-4390~REF1~42.50~~fine~",
      "TR~2~notadate~6-4390~REF2~10.00~~bad~",
    ].join("\n");
    setup(withBad);

    const message = await runHandler();

    expect(message).toContain("could not be read");
    expect(message).toContain("line 4");
  });

  it("surfaces an assumption it had to make", async () => {
    // An ambiguous date order is not a fault in the file, but the user should know it was read
    // day-first rather than discover it in a wrong quarter.
    const ambiguous = [
      "CDS1~Acme Pty Ltd~01/02/26~03/04/26",
      "AC~6-4390~Staff Amenities",
      "TR~1~01/02/26~6-4390~REF1~42.50~~COFFEE~",
    ].join("\n");
    setup(ambiguous);

    const message = await runHandler();

    expect(message).toContain("day-first");
  });
});
