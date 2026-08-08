import { describe, it, expect, beforeEach, vi } from "vitest";
import importLedger from "../src/handlers/import-ledger";

/**
 * The import handler, driven against a fake gateway.
 *
 * The handler reads `signal` and `gateway` from its enclosing scope, which the runtime provides.
 * Here they are set as globals before importing the module, which is also a fair simulation of
 * how it actually runs: the bundled source is evaluated with those names in scope.
 */

interface Query {
  cypher: string;
  params?: Record<string, unknown>;
}

function setup(fileContent: string, filename = "ledger.txt") {
  const queries: Query[] = [];
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
    kg: {
      query: vi.fn(async (q: Query) => {
        queries.push(q);
        return { rows: [], warnings: [] };
      }),
    },
  };

  return { queries, reads };
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
    const { queries, reads } = setup(LEDGER);

    const message = await runHandler();

    expect(reads).toHaveLength(1);
    expect(message).toContain("Acme Pty Ltd");
    expect(message).toContain("2025-07-01");
    expect(queries.length).toBeGreaterThan(0);
  });

  it("declines anything without the signature, without reading the file", async () => {
    // The whole point of head(): a file that is not ours costs a few hundred characters, not
    // the whole export.
    const { queries, reads } = setup("milk, bread, coffee", "shopping.txt");

    const message = await runHandler();

    expect(message).toContain("Not a CeeData export");
    expect(reads).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it("re-checks content even though the host pre-filtered", async () => {
    // A pre-filter is a cheap exclusion, not a guarantee. Acting on a file that merely looked
    // right is how a ledger gets corrupted.
    const { queries } = setup("CDS-NOT-REALLY~Acme");

    await runHandler();

    expect(queries).toHaveLength(0);
  });
});

describe("writing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the declared window before inserting", async () => {
    // Replace-by-window is what makes a re-export idempotent: without the delete, importing the
    // same period twice doubles every total.
    const { queries } = setup(LEDGER);

    await runHandler();

    const deletes = queries.filter((q) => q.cypher.includes("DETACH DELETE"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((q) => q.params?.from === "2025-07-01" && q.params?.to === "2026-06-30"))
      .toBe(true);
    // And the delete happens before any write.
    const firstWrite = queries.findIndex((q) => q.cypher.includes("MERGE"));
    const lastDelete = queries.map((q) => q.cypher.includes("DETACH DELETE")).lastIndexOf(true);
    expect(lastDelete).toBeLessThan(firstWrite);
  });

  it("writes coverage last, so it never claims data that did not land", async () => {
    const { queries } = setup(LEDGER);

    await runHandler();

    const coverageIndex = queries.findIndex((q) => q.cypher.includes("LedgerCoverage"));
    expect(coverageIndex).toBe(queries.length - 1);
  });

  it("keys entities on source, entity and code so two companies never collide", async () => {
    const { queries } = setup(LEDGER);

    await runHandler();

    const accounts = queries.find((q) => q.cypher.includes("MERGE (a:LedgerAccount"));
    const rows = accounts?.params?.rows as { key: string }[];
    expect(rows[0].key).toBe("myob-ceedata:Acme Pty Ltd:6-4390");
  });

  it("preserves the sign of each posting", async () => {
    // Income is credited and therefore negative. Absolute-valuing on import would make income
    // and expenditure indistinguishable.
    const { queries } = setup(LEDGER);

    await runHandler();

    const entries = queries.find((q) => q.cypher.includes("MERGE (e:LedgerEntry"));
    const rows = entries?.params?.rows as { amount: number }[];
    expect(rows.map((r) => r.amount)).toEqual([42.5, -100]);
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
    const { queries } = setup(noHeader);

    const message = await runHandler();

    expect(message).toContain("does not declare which period");
    expect(queries).toHaveLength(0);
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
