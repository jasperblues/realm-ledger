import { describe, it, expect } from "vitest";
import { parseCeeData } from "../src/parse/myob-ceedata";

/**
 * The guard that matters most in this adapter, and the one with no visible symptom.
 *
 * Every other parse failure announces itself: a bad amount is rejected, a missing account
 * code is rejected. A file read under the wrong date convention parses perfectly — every
 * row valid, totals balancing — and simply puts transactions in the wrong periods. Nothing
 * downstream can detect it, so the parser has to.
 */
describe("date-order guard", () => {
  const header = "CDS1~Acme Pty Ltd~01/07/25~30/06/26";

  const withDates = (dates: string[]) =>
    [header, ...dates.map((d, i) => `TR~${i}~${d}~6-4390~REF${i}~10.00~~thing~`)].join("\n");

  it("stays quiet when the file agrees with the declared convention", () => {
    const { rejected } = parseCeeData(withDates(["30/06/26", "03/07/25", "01/01/26"]));
    expect(rejected).toHaveLength(0);
  });

  it("asks the user when the file cannot settle the question either way", () => {
    // All dates in the first twelve days of a month, so nothing in the file distinguishes
    // the readings. Not a fault in the file — it is simply silent — so this is a question,
    // not a rejection.
    const { rejected, clarifications } = parseCeeData(withDates(["01/02/26", "03/04/26"]));

    expect(rejected).toHaveLength(0);
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0].id).toBe("date-order");
    expect(clarifications[0].options.map((o) => o.id)).toEqual(["day-first", "month-first"]);
  });

  it("the question states what was assumed, so an unanswered import is still usable", () => {
    // An import that blocks forever on a prompt nobody sees is worse than one that
    // proceeds on a stated assumption.
    const { ledger, clarifications } = parseCeeData(withDates(["01/02/26", "03/04/26"]));

    expect(clarifications[0].assumed).toContain("day-first");
    expect(ledger.lines).toHaveLength(2);
    expect(ledger.lines[0].date).toBe("2026-02-01");
  });

  it("each option says what choosing it would mean for the data", () => {
    const { clarifications } = parseCeeData(withDates(["01/02/26", "03/04/26"]));
    const monthFirst = clarifications[0].options.find((o) => o.id === "month-first");

    expect(monthFirst?.consequence).toContain("different month");
  });

  it("does not ask when the file answers the question itself", () => {
    const { clarifications } = parseCeeData(withDates(["30/06/26", "03/07/25"]));
    expect(clarifications).toHaveLength(0);
  });

  it("objects when the file is evidently month-first", () => {
    // Would otherwise import silently wrong books: every row parses, nothing fails.
    const { rejected } = parseCeeData(withDates(["07/30/25", "01/02/26"]));
    const fileLevel = rejected.find((r) => r.line === 0);
    expect(fileLevel?.reason).toContain("month-first");
    expect(fileLevel?.reason).toContain("wrong period");
    // The offending row also fails on its own terms: read day-first, 07/30/25 has no
    // thirtieth month. Both facts are worth reporting — one names the file's problem, the
    // other points at a line.
    expect(rejected.some((r) => r.line > 0 && r.reason.includes("unreadable date"))).toBe(true);
  });

  it("objects when the file mixes conventions", () => {
    const { rejected } = parseCeeData(withDates(["30/06/25", "07/30/25"]));
    expect(rejected.some((r) => r.reason.includes("mixes"))).toBe(true);
  });

  it("the objection does not discard the rows it can read", () => {
    // A warning about the file is not a reason to throw away its contents; the user needs
    // both the data and the caveat.
    const { ledger, rejected } = parseCeeData(withDates(["07/30/25", "01/02/26"]));
    expect(rejected.some((r) => r.line === 0)).toBe(true);
    expect(ledger.lines.length).toBeGreaterThan(0);
  });
});
