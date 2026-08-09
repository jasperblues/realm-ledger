import { describe, it, expect } from "vitest";
import {
  counterpartyKey,
  resolveCounterparties,
  stripNarration,
} from "../src/parse/counterparty";
import type { Account, JournalLine, Ledger } from "../src/parse/model";

const account = (code: string, name: string, type: Account["type"]): Account => ({
  code,
  name,
  type,
  header: false,
  active: true,
});

const line = (
  ref: string,
  code: string,
  amount: number,
  description: string,
): JournalLine => ({ transactionRef: ref, date: "2026-02-01", accountCode: code, amount, description });

const ledgerOf = (lines: JournalLine[], accounts: Account[]): Ledger => ({
  coverage: { entity: "Acme Pty Ltd", source: "myob-ceedata", from: "2025-07-01", to: "2026-06-30" },
  accounts,
  lines,
});

const ACCOUNTS = [
  account("4-1400", "Sales - GST", "income"),
  account("1-1200", "Accounts Receivable", "asset"),
  account("1-1110", "Business Bank Account", "asset"),
  account("2-1212", "GST Collected", "liability"),
  account("6-4390", "Staff Amenities", "expense"),
];

describe("stripping a narration to the party", () => {
  it.each([
    ["Sale; Widget Co Pty Limited", "Widget Co Pty Limited"],
    ["WIDGET CO PTY LIMITED Fees 2177177", "WIDGET CO PTY LIMITED"],
    ["WIDGET CO PTY LIMITED Funds transfer 22 NOV 2387523", "WIDGET CO PTY LIMITED"],
    ["WIDGET CO PTY LIMITED Short Payment 2363252", "WIDGET CO PTY LIMITED"],
    ["Payroll Bureau P RCTI 2025-07-13 fr", "Payroll Bureau P"],
    ["Some Bank REFUNDINC000349720", "Some Bank"],
  ])("%s -> %s", (raw, expected) => {
    expect(stripNarration(raw)).toBe(expected);
  });

  it.each([
    // Card-terminal dates: one cafe became ten suppliers, so no supplier total meant anything.
    ["SQ *BEAN ROASTER S Suburbia 19/09", "SQ *BEAN ROASTER S Suburbia"],
    ["SQ *BEAN ROASTER S Suburbia 04/07", "SQ *BEAN ROASTER S Suburbia"],
    ["SQ *COFFEE CO Townsville 08/04/26", "SQ *COFFEE CO Townsville"],
    // Trailing country the feed appends on some lines and not others.
    ["GROCER 2705 WEST END AUS", "GROCER 2705 WEST END"],
    // Both artifacts stacked.
    ["SQ *BEAN ROASTER S Suburbia 19/09 AUS", "SQ *BEAN ROASTER S Suburbia"],
  ])("strips terminal noise: %s", (raw, expected) => {
    expect(stripNarration(raw)).toBe(expected);
  });

  it("keeps the store number and suburb — those are real distinctions", () => {
    // Two branches of one chain are separate lines in the books, and merging them would overstate
    // concentration at a single supplier just as splitting understated it.
    expect(counterpartyKey("GROCER 2705 WEST END AUS"))
      .not.toBe(counterpartyKey("GROCER 2552 MOOROOKA AUS"));
  });

  it("collapses one merchant written with and without a trailing country", () => {
    // "ROASTER S" and "ROASTERS" already collapse once punctuation goes; the country was the only
    // thing keeping these apart.
    expect(counterpartyKey("SQ *BEAN ROASTER S Suburbia 19/09"))
      .toBe(counterpartyKey("SQ *BEAN ROASTERS Suburbia AUS"));
  });

  it("keeps a name that merely contains a noise word", () => {
    // "Transfer" trailing is noise; "Transfer" inside a company name is the company's name.
    expect(stripNarration("Sale; Transfer Holdings Pty Ltd")).toBe("Transfer Holdings Pty Ltd");
  });
});

describe("matching one party across spellings", () => {
  it("collapses invoice and bank spellings to one key", () => {
    const key = counterpartyKey("Sale; Widget Co Pty Limited");
    expect(counterpartyKey("WIDGET CO PTY LIMITED Fees 2177177")).toBe(key);
    expect(counterpartyKey("WIDGET CO PTY LIMITED Short Payment 2363252")).toBe(key);
  });

  it("does not collapse different parties", () => {
    expect(counterpartyKey("Sale; Widget Co")).not.toBe(counterpartyKey("Sale; Gadget Co"));
  });
});

describe("reading the counterparty off the right leg", () => {
  it("takes the client from the receivable leg, not the timesheet", () => {
    // The defect this closes: the income leg describes the WORK. Grouping by it split one client
    // into a dozen timesheets and understated concentration.
    const l = ledgerOf(
      [
        line("INV1", "4-1400", -5000, "August 29th; August 28th; August 23rd"),
        line("INV1", "1-1200", 5500, "Sale; Widget Co Pty Limited"),
        line("INV1", "2-1212", -500, "Sale; Widget Co Pty Limited"),
      ],
      ACCOUNTS,
    );

    const income = l.lines[0];
    expect(resolveCounterparties(l).get(income)?.name).toBe("Widget Co Pty Limited");
  });

  it("handles a direct receipt where both legs carry the bank text", () => {
    const l = ledgerOf(
      [
        line("BNK1", "4-1400", -9000, "WIDGET CO PTY LIMITED Fees 2177177"),
        line("BNK1", "1-1110", 9000, "WIDGET CO PTY LIMITED Fees 2177177"),
      ],
      ACCOUNTS,
    );

    const party = resolveCounterparties(l).get(l.lines[0]);
    expect(party?.name).toBe("WIDGET CO PTY LIMITED");
    expect(party?.source).toBe("same-leg");
  });

  it("gives one client ONE name across invoice and bank receipts", () => {
    // The whole point: a later GROUP BY counterparty must not split the client again.
    const l = ledgerOf(
      [
        line("INV1", "4-1400", -203000, "timesheet"),
        line("INV1", "1-1200", 203000, "Sale; Widget Co Pty Limited"),
        line("BNK1", "4-1400", -9000, "WIDGET CO PTY LIMITED Fees 2177177"),
        line("BNK1", "1-1110", 9000, "WIDGET CO PTY LIMITED Fees 2177177"),
        line("BNK2", "4-1400", -1000, "WIDGET CO PTY LIMITED Short Payment 2363252"),
        line("BNK2", "1-1110", 1000, "WIDGET CO PTY LIMITED Short Payment 2363252"),
      ],
      ACCOUNTS,
    );

    const resolved = resolveCounterparties(l);
    const incomeLines = l.lines.filter((x) => x.accountCode === "4-1400");
    const names = new Set(incomeLines.map((x) => resolved.get(x)?.name));

    expect(names.size).toBe(1);
    // The invoice spelling wins — a human typed it.
    expect([...names][0]).toBe("Widget Co Pty Limited");

    const total = incomeLines.reduce((sum, x) => sum - x.amount, 0);
    expect(total).toBe(213000);
  });

  it("is absent rather than guessed when there is no other side", () => {
    // A guessed counterparty moves a concentration figure silently. Missing is recoverable.
    const l = ledgerOf([line("J1", "6-4390", 42.5, "COFFEE BEANS")], ACCOUNTS);

    expect(resolveCounterparties(l).get(l.lines[0])).toBeUndefined();
  });

  it("does not read a counterparty off another expense leg", () => {
    const l = ledgerOf(
      [
        line("J2", "6-4390", 42.5, "COFFEE BEANS"),
        line("J2", "4-1400", -42.5, "something else entirely"),
      ],
      ACCOUNTS,
    );

    expect(resolveCounterparties(l).get(l.lines[0])).toBeUndefined();
  });
});
