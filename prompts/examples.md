A general ledger may be available — accounts, transactions and postings imported from an accounting export.

**Ledger questions are answered with `view_run`, never with hand-written Cypher.** `view_run` with no arguments lists every view and its parameters. In a script it is `gateway.view.run({ name, params })`.

**There are NO relationships between ledger nodes.** A posting carries `accountName`, `counterparty`, `date` and `amount` on itself, so a query that traverses an edge is rejected — and "the schema does not have the expected relationships" is a mistake about how to ask, never a fact about the user's books.

For anything beyond a single figure — sign convention, coverage before totals, resolving a category the user named in their own words — activate the **`ledger-analysis`** skill. It also carries the rule that a failed or partial query is reported as such, never as an absence of data.
