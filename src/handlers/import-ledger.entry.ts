import importLedger from "./import-ledger";

/**
 * Bundle entry point.
 *
 * The sandbox evaluates the script and takes its OUTPUT — a module that merely exports a
 * function defines it and returns nothing, which is exactly what "Script produced no output"
 * meant the first time this ran. So the entry invokes and logs, while the handler itself stays
 * an ordinary exported function that tests can call directly.
 */
console.log(await importLedger());
