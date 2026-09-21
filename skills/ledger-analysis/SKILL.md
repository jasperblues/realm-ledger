---
name: ledger-analysis
description: General ledger questions — spending by category, revenue by client, counterparties, trends over time. Activate BEFORE answering anything about money from the books; it carries the views, the sign convention, and the rules that keep the numbers honest.
---

# Ledger analysis

An imported general ledger: `LedgerAccount` (the chart of accounts), `LedgerTransaction` (one
accounting event), `LedgerEntry` (a single posting), and `LedgerCoverage` (which periods have
actually been imported).

**Activating this skill loads nothing.** It gives you the views and the rules; it does not fetch,
import, or check any data. Never say the ledger "has been loaded" or "is ready" on activation —
an import takes tens of seconds, and announcing it as done while it is still running produces a
flat contradiction two turns later, when a query is refused because the import is in flight. Say
what you can do, then find out what is actually there with `ledger_coverage`.

## Use the views

**Run them with `view_run`, naming the view.** Call `view_run` with NO arguments first and it
lists every view with its parameters, which is also how to check a name before using it.

```
view_run                                    // lists them
view_run { name: "ledger_coverage" }
view_run { name: "spend_by_category", from: "2025-07-01", to: "2026-06-30" }
```

**Inside a script it is `gateway.view.run(...)`, not `gateway.view_run(...)`.** A tool named
`x_y` is reached as `gateway.x.y` in `execute_javascript` — the same way `kg_query` is
`gateway.kg.query`. Observed: a correct aggregation script failed twice on
`gateway.view_run is not a world tool`, and the model then added 65 postings up by hand in prose
and got a total that did not match the one it had quoted a line earlier.

```js
const result = await gateway.view.run({
  name: 'spend_by_supplier_in_category',
  params: JSON.stringify({ category: 'Staff Amenities', from, to }),
});
```

**There is no `gateway.<something>.<view>()`.** A view is not a gateway namespace, and
`ledger-analysis` is the name of THIS SKILL, not of a callable thing. Observed, on a world whose
ledger had imported cleanly: a model wrote `await gateway.ledger_analysis.ledger_coverage()`, got
`gateway.ledger_analysis is not a world tool`, and reported to the user that their books had no
coverage periods — turning a failed call into a finding about their data. The table below names
the views; this is how they are reached, and the two belong together.

Run them by name rather than writing the Cypher yourself. The aggregation is done once, inside
the view, precisely so it cannot be fanned out and over-counted: join a posting to its
transaction and then to a counterparty by hand, and every posting multiplies.

**The parameter names are here because they are not guessable.** A view refuses an argument it
does not declare, so `find_category { name: … }` fails outright — its parameter is `term`. Dates are
ISO `yyyy-mm-dd` and inclusive.

| Question | View | Parameters |
|---|---|---|
| where does the money go | `spend_by_category` | `from`, `to`, `limit`(25) |
| what makes up that total | `spend_in_category` | **`category`** (required), `from`, `to`, `limit`(200) |
| break a category down by supplier | `spend_by_supplier_in_category` | **`category`** (required), `from`, `to`, `limit`(50) |
| who pays us, and how concentrated is it | `revenue_by_client` | `from`, `to`, `limit`(25) |
| is this category growing | `category_trend` | **`category`** (required), `from`, `to` |
| who do we transact with most | `top_counterparties` | `from`, `to`, `limit`(25) |
| what periods do we actually have | `ledger_coverage` | none |
| the user named a category in their own words | `find_category` FIRST, then the view above | **`term`** (not `name`), `limit`(15) |

**Never add up rows yourself.** `spend_in_category` returns individual postings; totalling them
in prose is arithmetic over dozens of numbers with nothing checking it, and it has produced a
breakdown that disagreed with its own stated total. If a question asks for a total or a grouping,
there is a view that has already done it — and if the answer must be computed, compute it in a
script, never in the reply.

`category` takes the account name `find_category` returned, not the user's word for it. That is
the whole reason to call `find_category` first: books that say "Travel & Accommodation" will not
match "Travel", and a guessed name returns zero rows that read exactly like zero spend.

**A refused call tells you how to fix it.** `view_run` names the declared parameters in its error
— "unknown param(s) 'name' — declared params: term, limit". Read it and retry with the right ones;
do not fall back to hand-written Cypher, and do not report the failure as a finding about the
user's books. `view_run` with no arguments lists every view and its parameters if you need them.

## Aggregating

Every posting carries what a total needs, so an aggregate is a GROUP BY over `LedgerEntry` with no
join and no traversal:

```cypher
MATCH (e:LedgerEntry)
WHERE e.accountName = 'Staff Amenities' AND e.date >= $from AND e.date <= $to
RETURN e.counterparty AS supplier, sum(e.amount) AS total, count(e) AS postings
ORDER BY total DESC
```

`accountName`, `accountType` and `counterparty` are ON the posting. There are no edges between
postings, accounts and transactions — do not write `HAS_ACCOUNT` or any other relationship; it does
not exist and the query will be rejected. If a result is empty, suspect the query before concluding
there is no data: an aggregate that cannot be expressed comes back empty and reads exactly like
"you never spent anything on this".

`counterparty` is already canonical — one party has one name across invoice and bank spellings.
Group by it directly. `counterpartyKey` is the match key if you need certainty; `counterpartyNarration`
is the raw text it was read from, which is how you show which spellings were merged.

## Cardinal rules

0. **NEVER parse the export file. Query the imported data.** Once a ledger has been imported, the
   file and the graph hold the same figures — and the file is the wrong one. Reading the export
   with `attachment_read` and parsing it (in `execute_javascript` or anywhere else) copies bulk
   text you cannot re-emit intact: most of it is silently dropped, the remainder parses cleanly,
   and you report totals that are wrong by an order of magnitude with nothing flagging it. This
   has happened: 170 transactions reported from a file holding 810, income out by 10x. If the
   answer needs ledger figures, it comes from a view or a query over the imported data. If the
   data is not there, say so — do not fall back to the file.

0.5. **Resolve a category name before you use it — never guess it.** The user says "travel"; the
   books say "Travel & Accommodation". An exact-match filter on a guessed name returns zero rows
   and reads exactly like "you spent nothing". Call `find_category` first and use what it returns.

   If it returns NOTHING, the books have no such category. Say so. Do NOT then search supplier
   names for related-sounding words: that is how a restaurant called SEA FUEL was counted as a
   motor vehicle expense, and how a keyword list ('fuel', 'car', 'uber') becomes a category total
   that no accountant would recognise. A category total comes from an ACCOUNT, always.

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

5. **A counterparty is the OTHER side, and it is absent when unknown.** `counterparty` is read
   from the transaction's asset leg — on a sale the income line describes the work done and the
   receivable line names the client. It is absent when the transaction has no readable other side.
   Absent means unknown, never "none", and never a reason to fall back to the posting's own text.

6. **Say when you merged spellings.** One party often appears several ways: an invoice line and a
   bank feed's own string. These are combined under one name, which is what makes a concentration
   figure correct — and it must be visible. When a counterparty total matters, say how many
   narration variants it came from and offer to list them.

7. **The narration is evidence, not a conclusion.** `narration` is the bookkeeper's or bank
   feed's own text. `counterpartyName` is a best-effort reading of it and is absent when it
   could not be read confidently — absent means unknown, not none.

8. **Don't offer tax or compliance opinions.** You can report what the books say — totals,
   concentration, trends. Whether that satisfies a rule is for their accountant, and a
   confident wrong answer here is expensive.

9. **A call that failed is not a finding.** "The query errored" and "your books have no data for
   that period" are different sentences, and only one of them is about the user's business. If a
   view will not run, say the call failed and what it said — the error names what is available and
   is usually enough to get it right on the retry. Observed: a script error reading
   `gateway.ledger_analysis is not a world tool` was reported to the user as their ledger having
   no coverage periods, on a world that had just imported 2,340 postings covering a full year.
   An absence reported as fact sends somebody looking for records that were never missing.

## Worked shape

Asking "how much did I spend on staff amenities last financial year":

1. `ledger_coverage` — confirm the year is covered.
2. `spend_by_category` for the window — find the account and its total.
3. `spend_in_category` if they want the detail behind it.

Report the total, the number of postings, and the period it covers. If coverage is partial, say
so in the same sentence as the number, not afterwards.

## Presenting a breakdown

**A breakdown with more than about three rows is a markdown table, not a list of bullets.**
Ledger answers are columnar by nature — a name, an amount, a count — and a bulleted line per row
puts those columns at a different horizontal position on every line, so nothing can be compared by
eye and the amounts cannot be scanned down. A table is what makes "which supplier dominates this
category" answerable at a glance, which is usually the real question behind asking for a
breakdown.

Right-align amounts, and keep the columns in the order the question asked about: what it is, how
much, how many postings.

```markdown
| Supplier | Amount | Postings |
|---|---:|---:|
| SP ALT BREW 4035 DARRA | 566.10 | 3 |
| SQ *RENEGADE ROASTER S | 551.40 | 13 |
```

A SINGLE figure is not a table. "You spent 3,629.47 across 65 postings" is a sentence, and
wrapping one number in a grid makes the reader work harder for less. The same goes for two or
three rows, where a sentence still reads faster than a header row.

Keep the total out of the table's rows — state it before or after. A total sitting in the same
column as the parts it sums is a row somebody will read as another supplier.
