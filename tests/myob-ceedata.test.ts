import { describe, it, expect } from "vitest";
import { parseCeeData, claimsCeeData, toIsoDate } from "../src/parse/myob-ceedata";

/**
 * A miniature CeeData file with the shapes that matter: the header, a couple of accounts,
 * a multi-line sale (receivable + GST + income sharing one reference), and a purchase.
 *
 * Synthetic rather than a real export, deliberately — a realm's tests should not carry
 * anyone's actual books, and every behaviour worth pinning is reproducible in a dozen lines.
 */
const SAMPLE = [
  "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
  "AC~1-1200~Accounts Receivable",
  "AC~2-1212~GST Collected",
  "AC~4-1400~Sales - GST",
  "AC~6-4390~Staff Amenities",
  "",
  "TR~2507019062474~03/07/25~1-1200~00000012~11000.00~~Sale; Widgets Ltd~",
  "TR~2507019062475~03/07/25~2-1212~00000012~-1000.00~~Sale; Widgets Ltd~",
  "TR~2507019062476~03/07/25~4-1400~00000012~-10000.00~~Sale; Widgets Ltd~",
  "TR~2507019062480~14/08/25~6-4390~00000031~42.50~~COFFEE ROASTERS SOUTHBANK AUS~",
  "",
].join("\r\n");

describe("claiming", () => {
  it("recognises the format from its first bytes", () => {
    expect(claimsCeeData(SAMPLE)).toBe(true);
  });

  it("does not claim other text that happens to be tilde-delimited", () => {
    expect(claimsCeeData("A~B~C")).toBe(false);
    expect(claimsCeeData("date,account,amount")).toBe(false);
  });
});

describe("coverage", () => {
  it("reads the declared window from the header", () => {
    // This is what makes replace-by-window imports safe, so it is not incidental.
    const { ledger } = parseCeeData(SAMPLE);
    expect(ledger.coverage).toEqual({
      entity: "Acme Pty Ltd",
      from: "2025-07-01",
      to: "2026-06-30",
      source: "myob-ceedata",
    });
  });

  it("reports a missing header rather than inventing a window", () => {
    // Without a declared period an import cannot safely supersede an earlier one, so this
    // must be loud rather than defaulted.
    const { rejected } = parseCeeData("AC~1-1200~Accounts Receivable");
    expect(rejected.some((r) => r.reason.includes("does not declare which period"))).toBe(true);
  });
});

describe("accounts", () => {
  it("parses the chart of accounts", () => {
    const { ledger } = parseCeeData(SAMPLE);
    expect(ledger.accounts).toHaveLength(4);
    expect(ledger.accounts[3]).toMatchObject({ code: "6-4390", name: "Staff Amenities" });
  });

  it("infers a type from the account number as a fallback", () => {
    const { ledger } = parseCeeData(SAMPLE);
    const byCode = Object.fromEntries(ledger.accounts.map((a) => [a.code, a.type]));
    expect(byCode["1-1200"]).toBe("asset");
    expect(byCode["4-1400"]).toBe("income");
    expect(byCode["6-4390"]).toBe("expense");
  });
});

describe("journal lines", () => {
  it("parses postings with signed amounts", () => {
    const { ledger } = parseCeeData(SAMPLE);
    expect(ledger.lines).toHaveLength(4);
    expect(ledger.lines[0]).toMatchObject({
      transactionRef: "00000012",
      date: "2025-07-03",
      accountCode: "1-1200",
      amount: 11000,
      description: "Sale; Widgets Ltd",
    });
    expect(ledger.lines[1].amount).toBe(-1000);
  });

  it("groups a transaction's postings by reference", () => {
    // The field the whole model depends on: the customer is named on the receivable line
    // while the revenue sits on the income line, and only the shared reference connects them.
    const { ledger } = parseCeeData(SAMPLE);
    const sale = ledger.lines.filter((l) => l.transactionRef === "00000012");
    expect(sale).toHaveLength(3);
    expect(sale.reduce((sum, l) => sum + l.amount, 0)).toBeCloseTo(0);
  });

  it("keeps the source narration verbatim", () => {
    // It is evidence. Interpreting it is a separate, fallible step that must not overwrite
    // what the books actually say.
    const { ledger } = parseCeeData(SAMPLE);
    const amenities = ledger.lines.find((l) => l.accountCode === "6-4390");
    expect(amenities?.description).toBe("COFFEE ROASTERS SOUTHBANK AUS");
  });

  it("ignores blank lines", () => {
    const { ledger, rejected } = parseCeeData(SAMPLE);
    expect(ledger.lines).toHaveLength(4);
    expect(rejected).toHaveLength(0);
  });
});

describe("bad rows are reported, not dropped or fatal", () => {
  const withBadRows = [
    "CDS1~Acme Pty Ltd~01/07/25~30/06/26",
    "TR~1~03/07/25~6-4390~00000031~42.50~~fine~",
    "TR~2~notadate~6-4390~00000032~10.00~~bad date~",
    "TR~3~03/07/25~~00000033~10.00~~no account~",
    "TR~4~03/07/25~6-4390~00000034~~~no amount~",
    "TR~5~03/07/25~6-4390~~10.00~~no transaction ref~",
  ].join("\n");

  it("keeps the good rows", () => {
    const { ledger } = parseCeeData(withBadRows);
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0].amount).toBe(42.5);
  });

  it("reports each bad row with a line number and a usable reason", () => {
    // A user can act on "line 3 has no account code". They cannot act on a total that is
    // quietly short by four postings.
    const { rejected } = parseCeeData(withBadRows);
    expect(rejected).toHaveLength(4);
    expect(rejected.map((r) => r.line)).toEqual([3, 4, 5, 6]);
    expect(rejected[0].reason).toContain("date");
    expect(rejected[1].reason).toContain("account code");
    expect(rejected[2].reason).toContain("amount");
    expect(rejected[3].reason).toContain("transaction reference");
  });

  it("never defaults a missing amount to zero", () => {
    // A zero posting is a real thing, so a defaulted one would join the totals as truth.
    const { ledger } = parseCeeData(withBadRows);
    expect(ledger.lines.some((l) => l.amount === 0)).toBe(false);
  });
});

describe("dates", () => {
  it("reads day-first, as the source writes them", () => {
    // Month-first turns 07/01/25 into July and moves a transaction across a quarter.
    expect(toIsoDate("07/01/25")).toBe("2025-01-07");
    expect(toIsoDate("30/06/26")).toBe("2026-06-30");
  });

  it("accepts four-digit years", () => {
    expect(toIsoDate("30/06/2026")).toBe("2026-06-30");
  });

  it("accepts an ISO date, which is unambiguous whatever the source convention", () => {
    expect(toIsoDate("2025-07-01")).toBe("2025-07-01");
  });

  it("rejects impossible dates rather than rolling them forward", () => {
    expect(toIsoDate("31/02/25")).toBeNull();
    expect(toIsoDate("00/01/25")).toBeNull();
    expect(toIsoDate("01/13/25")).toBeNull();
    expect(toIsoDate("")).toBeNull();
  });
});
