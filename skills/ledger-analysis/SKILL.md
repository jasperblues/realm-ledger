---
name: ledger-analysis
description: General ledger questions — spending by category, revenue by client, counterparties, trends over time. Activate BEFORE answering anything about money from the books; it carries the views, the sign convention, and the rules that keep the numbers honest.
---

# Ledger analysis

An imported general ledger: `LedgerAccount` (the chart of accounts), `LedgerTransaction` (one
accounting event), `LedgerEntry` (a single posting), and `LedgerCoverage` (which periods have
actually been imported).

## Use the views

Run them by name rather than writing the Cypher yourself. The aggregation is done once, inside
the view, precisely so it cannot be fanned out and over-counted: join a posting to its
transaction and then to a counterparty by hand, and every posting multiplies.

| Question | View |
|---|---|
| where does the money go | `spend_by_category` |
| what makes up that total | `spend_in_category` |
| who pays us, and how concentrated is it | `revenue_by_client` |
| is this category growing | `category_trend` |
| who do we transact with most | `top_counterparties` |
| what periods do we actually have | `ledger_coverage` |

## Cardinal rules

0. **NEVER parse the export file. Query the imported data.** Once a ledger has been imported, the
   file and the graph hold the same figures — and the file is the wrong one. Reading the export
   with `attachment_read` and parsing it (in `execute_javascript` or anywhere else) copies bulk
   text you cannot re-emit intact: most of it is silently dropped, the remainder parses cleanly,
   and you report totals that are wrong by an order of magnitude with nothing flagging it. This
   has happened: 170 transactions reported from a file holding 810, income out by 10x. If the
   answer needs ledger figures, it comes from a view or a query over the imported data. If the
   data is not there, say so — do not fall back to the file.

1. **Check coverage before reporting a total.** A period outside the imported windows has NO
   DATA, which is not the same as zero spend. Say "I don't have data for that period" and say
   which periods you do have. A zero reads as a fact, and a wrong fact about money is worse than
   an admitted gap.

2. **Never re-categorise.** The account on a posting was chosen by a human who knew what was
   bought; the graph does not. A furniture shop can sell a coffee machine and an electronics
   shop can sell CO2 canisters. Report the account the books use. You may group and summarise
   within a category — "most of this is coffee" — but never move a posting to a different one,
   and never infer the item from the merchant.

3. **Respect the sign convention.** Amounts are stored as the source records them: positive
   debit, negative credit. Income is therefore negative. `revenue_by_client` already negates;
   if you write your own query, negate once and say you have.

4. **Quote the rejected count when it is not zero.** "2,338 of 2,340 postings" is a different
   claim from "2,340 postings". `ledger_coverage` carries it.

5. **The narration is evidence, not a conclusion.** `narration` is the bookkeeper's or bank
   feed's own text. `counterpartyName` is a best-effort reading of it and is absent when it
   could not be read confidently — absent means unknown, not none.

6. **Don't offer tax or compliance opinions.** You can report what the books say — totals,
   concentration, trends. Whether that satisfies a rule is for their accountant, and a
   confident wrong answer here is expensive.

## Worked shape

Asking "how much did I spend on staff amenities last financial year":

1. `ledger_coverage` — confirm the year is covered.
2. `spend_by_category` for the window — find the account and its total.
3. `spend_in_category` if they want the detail behind it.

Report the total, the number of postings, and the period it covers. If coverage is partial, say
so in the same sentence as the number, not afterwards.
