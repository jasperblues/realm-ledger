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

/**
 * Default: the store reports every row as new. Tests that need the re-import case pass a
 * summariser producing the "none were new" shape instead — the handler's message is derived from
 * these strings, so a stub that lies about them tests nothing.
 */
const allNew = (w: Write) => `Created ${w.rows.length} new ${w.type} entries.`;
const noneNew = (w: Write) => `Updated ${w.rows.length} existing ${w.type} entries. None were new.`;

function setup(
  fileContent: string,
  filename = "ledger.txt",
  summariser: (w: Write) => string = allNew,
) {
  const writes: Write[] = [];
  const reports: string[] = [];
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
        return summariser(w);
      }),
    },
    progress: {
      report: vi.fn(async (a: { message: string }) => {
        reports.push(a.message);
        return "Reported.";
      }),
    },
  };

  return { writes, reads, reports };
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

describe("what the import reports", () => {
  const file = [
    "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
    "AC~6-4390~Staff Amenities",
    "TR~1~01/02/26~6-4390~REF1~42.50~~COFFEE~",
    "TR~2~02/02/26~6-4390~REF2~17.50~~MILK~",
  ].join("\n");

  it("reports a first import as new postings", async () => {
    setup(file);

    expect(await runHandler()).toContain("Imported 2 postings");
  });

  it("does not claim an import when nothing changed", async () => {
    // The defect: re-importing an unchanged export announced every parsed row as imported, so a
    // no-op read as success. This is the message the user actually sees.
    setup(file, "ledger.txt", noneNew);

    const message = await runHandler();

    expect(message).toContain("No new postings");
    expect(message).toContain("already in your ledger");
    expect(message).not.toContain("Imported 2 postings");
  });

  it("separates new postings from ones already present", async () => {
    setup(file, "ledger.txt", (w) =>
      w.type === "LedgerEntry"
        ? "Created 1 new and updated 1 existing LedgerEntry entries."
        : allNew(w),
    );

    const message = await runHandler();

    expect(message).toContain("Added 1 new postings");
    expect(message).toContain("refreshed 1 already present");
  });

  it("counts zero rather than inventing a number it cannot read", async () => {
    setup(file, "ledger.txt", () => "something the store did not used to say");

    expect(await runHandler()).not.toMatch(/Imported [1-9]/);
  });
});

describe("progress while importing", () => {
  /** Enough postings to need several batches — one batch reports nothing, by design. */
  const manyPostings = (n: number) =>
    [
      "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
      "AC~6-4390~Staff Amenities",
      ...Array.from({ length: n }, (_, i) => `TR~${i + 1}~01/02/26~6-4390~REF${i + 1}~10.00~~ITEM~`),
    ].join("\n");

  it("reports progress as batches land, ending at the total", async () => {
    // The silence this closes: 2,340 postings took ~40 seconds with nothing said until the end.
    const { reports } = setup(manyPostings(450));

    await runHandler();

    const postingReports = reports.filter((r) => r.endsWith("postings"));
    expect(postingReports.length).toBeGreaterThan(1);
    expect(postingReports[postingReports.length - 1]).toBe("imported 450 of 450 postings");
  });

  it("counts only upwards", async () => {
    const { reports } = setup(manyPostings(450));

    await runHandler();

    const counts = reports
      .filter((r) => r.endsWith("postings"))
      .map((r) => Number(/imported (\d+) of/.exec(r)![1]));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("says nothing when one batch does the job", async () => {
    // A single-batch import would announce itself once, immediately before finishing — noise.
    const { reports } = setup(manyPostings(3));

    await runHandler();

    expect(reports.filter((r) => r.endsWith("postings"))).toEqual([]);
  });

  it("imports fine against an assistant with no progress tool", async () => {
    // This realm is cloned at main by whoever installs it, so it must keep working on a host that
    // predates the tool. An unguarded call would fail the whole import.
    setup(manyPostings(450));
    delete (globalThis as any).gateway.progress;

    const message = await runHandler();

    expect(message).toContain("450");
  });

  it("a reporting failure does not fail the import", async () => {
    setup(manyPostings(450));
    (globalThis as any).gateway.progress.report = vi.fn(async () => {
      throw new Error("channel gone");
    });

    const message = await runHandler();

    expect(message).toContain("450");
  });
});
