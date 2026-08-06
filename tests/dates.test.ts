import { describe, it, expect } from "vitest";
import { inferOrder, parseWith, readerFor } from "../src/parse/dates";

describe("reading under a known order", () => {
  it("reads the same value differently depending on the source's convention", () => {
    // The entire reason this module exists. Both readings are valid dates; only one is
    // right, and nothing downstream can tell which.
    expect(parseWith("07/01/25", "day-first")).toBe("2025-01-07");
    expect(parseWith("07/01/25", "month-first")).toBe("2025-07-01");
  });

  it("accepts ISO whatever the declared order", () => {
    // A source that emits an unambiguous date is not ambiguous just because its usual
    // convention is something else; rejecting it would throw away good data.
    expect(parseWith("2025-07-01", "day-first")).toBe("2025-07-01");
    expect(parseWith("2025-07-01", "month-first")).toBe("2025-07-01");
    expect(parseWith("2025-07-01", "iso")).toBe("2025-07-01");
  });

  it("an ISO-only reader rejects slashed dates rather than guessing", () => {
    expect(parseWith("07/01/25", "iso")).toBeNull();
  });

  it("expands two-digit years into this century", () => {
    expect(parseWith("30/06/26", "day-first")).toBe("2026-06-30");
    expect(parseWith("30/06/2026", "day-first")).toBe("2026-06-30");
  });

  it("rejects impossible dates rather than rolling them forward", () => {
    // Left to Date, 31 February silently becomes 2 or 3 March — a real-looking date in the
    // wrong month, which is exactly the failure this module exists to prevent.
    expect(parseWith("31/02/25", "day-first")).toBeNull();
    expect(parseWith("29/02/25", "day-first")).toBeNull();
    expect(parseWith("29/02/24", "day-first")).toBe("2024-02-29");
  });

  it("rejects out-of-range components and junk", () => {
    expect(parseWith("00/01/25", "day-first")).toBeNull();
    expect(parseWith("01/13/25", "day-first")).toBeNull();
    expect(parseWith("", "day-first")).toBeNull();
    expect(parseWith("last tuesday", "day-first")).toBeNull();
  });

  it("readerFor carries its order", () => {
    expect(readerFor("month-first").read("07/01/25")).toBe("2025-07-01");
  });
});

describe("inferring the order from a file", () => {
  it("a value above 12 in the first position can only be a day", () => {
    expect(inferOrder(["03/07/25", "30/06/26", "01/01/25"])).toBe("day-first");
  });

  it("a value above 12 in the second position can only be a month position", () => {
    expect(inferOrder(["07/30/25", "01/01/25"])).toBe("month-first");
  });

  it("reports contradiction rather than resolving it by majority", () => {
    // A source emitting two conventions is broken in a way the user needs to know about.
    // Picking the more common one would hide it and place some transactions wrongly.
    expect(inferOrder(["30/06/25", "07/30/25"])).toBe("contradictory");
  });

  it("admits when a file genuinely cannot settle it", () => {
    // Every date in the first twelve days of a month. Rare across a year, common in a
    // short sample, and unresolvable from the data alone.
    expect(inferOrder(["01/02/25", "03/04/25", "05/06/25"])).toBe("ambiguous");
  });

  it("recognises an ISO file", () => {
    expect(inferOrder(["2025-07-01", "2025-12-31"])).toBe("iso");
  });

  it("says nothing when there is nothing to judge", () => {
    expect(inferOrder([])).toBe("none");
    expect(inferOrder(["", "not a date"])).toBe("none");
  });
});
