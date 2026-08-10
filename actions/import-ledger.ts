// src/parse/dates.ts
function inferOrder(samples) {
  let sawDayFirstEvidence = false;
  let sawMonthFirstEvidence = false;
  let sawIso = false;
  let sawSlashed = false;
  for (const raw of samples) {
    const value = raw.trim();
    if (ISO.test(value)) {
      sawIso = true;
      continue;
    }
    const m = value.match(SLASHED);
    if (!m) continue;
    sawSlashed = true;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12 && second <= 12) sawDayFirstEvidence = true;
    if (second > 12 && first <= 12) sawMonthFirstEvidence = true;
  }
  if (sawDayFirstEvidence && sawMonthFirstEvidence) return "contradictory";
  if (sawDayFirstEvidence) return "day-first";
  if (sawMonthFirstEvidence) return "month-first";
  if (sawSlashed) return "ambiguous";
  if (sawIso) return "iso";
  return "none";
}
function parseWith(value, order) {
  const text = value.trim();
  const iso = text.match(ISO);
  if (iso) return validate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (order === "iso") return null;
  const m = text.match(SLASHED);
  if (!m) return null;
  const first = Number(m[1]);
  const second = Number(m[2]);
  const day = order === "day-first" ? first : second;
  const month = order === "day-first" ? second : first;
  return validate(expandYear(m[3]), month, day);
}
function expandYear(text) {
  const n = Number(text);
  return text.length === 2 ? 2e3 + n : n;
}
function validate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  const check = /* @__PURE__ */ new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime())) return null;
  if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return iso;
}
function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}
var ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
var SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

// src/parse/myob-ceedata.ts
function parseCeeData(text) {
  const lines = text.split(/\r?\n/);
  const rejected = [];
  const header = findHeader(lines, rejected);
  const accounts = lines.map((raw, i) => parseAccount(raw, i + 1, rejected)).filter((a) => a !== null);
  const clarifications = checkDateOrder(
    lines.filter((l) => l.startsWith("TR~")).map((l) => l.split("~")[2] ?? ""),
    rejected
  );
  const journal = lines.map((raw, i) => parseLine(raw, i + 1, rejected)).filter((l) => l !== null);
  return {
    ledger: {
      coverage: {
        entity: header.entity,
        from: header.from,
        to: header.to,
        source: SOURCE
      },
      accounts,
      lines: journal
    },
    rejected,
    clarifications
  };
}
var SOURCE = "myob-ceedata";
var SIGNATURE = "CDS1~";
function claimsCeeData(text) {
  return text.startsWith(SIGNATURE);
}
function findHeader(lines, rejected) {
  const index = lines.findIndex((l) => l.startsWith(SIGNATURE));
  if (index < 0) {
    rejected.push({
      line: 0,
      reason: "no CDS1 header, so the file does not declare which period it covers; an import cannot safely supersede an earlier one",
      raw: ""
    });
    return { entity: "", from: "", to: "" };
  }
  const fields = lines[index].split("~");
  return {
    entity: (fields[1] ?? "").trim(),
    from: toIsoDate(fields[2] ?? "") ?? "",
    to: toIsoDate(fields[3] ?? "") ?? ""
  };
}
function parseAccount(raw, lineNumber, rejected) {
  if (!raw.startsWith("AC~")) return null;
  const f = raw.split("~");
  const code = (f[1] ?? "").trim();
  const name = (f[2] ?? "").trim();
  if (!code) {
    rejected.push({ line: lineNumber, reason: "account row has no code", raw: truncate(raw) });
    return null;
  }
  return {
    code,
    name,
    // CeeData carries no classification, only the code. The leading digit is MYOB's own
    // convention and is the only signal present; the richer chart-of-accounts export
    // supplies real types and supersedes this when both are imported.
    type: typeFromCode(code),
    header: false,
    active: true
  };
}
function parseLine(raw, lineNumber, rejected) {
  if (!raw.startsWith("TR~")) return null;
  const f = raw.split("~");
  const date = toIsoDate((f[2] ?? "").trim());
  const accountCode = (f[3] ?? "").trim();
  const transactionRef = (f[4] ?? "").trim();
  const amountText = (f[5] ?? "").trim();
  const amount = Number(amountText);
  if (!date) {
    rejected.push({ line: lineNumber, reason: `unreadable date '${f[2] ?? ""}'`, raw: truncate(raw) });
    return null;
  }
  if (!accountCode) {
    rejected.push({ line: lineNumber, reason: "posting has no account code", raw: truncate(raw) });
    return null;
  }
  if (amountText === "" || Number.isNaN(amount)) {
    rejected.push({ line: lineNumber, reason: `unreadable amount '${amountText}'`, raw: truncate(raw) });
    return null;
  }
  if (!transactionRef) {
    rejected.push({
      line: lineNumber,
      reason: "posting has no transaction reference, so it cannot be tied to its counterpart",
      raw: truncate(raw)
    });
    return null;
  }
  return {
    transactionRef,
    date,
    accountCode,
    amount,
    description: (f[7] ?? "").trim(),
    lineId: (f[1] ?? "").trim() || void 0
  };
}
var DATE_ORDER = "day-first";
function toIsoDate(value) {
  return parseWith(value, DATE_ORDER);
}
function checkDateOrder(dates, rejected) {
  const inferred = inferOrder(dates);
  if (inferred === "contradictory") {
    rejected.push({
      line: 0,
      reason: "the file mixes day-first and month-first dates, so some transactions would land in the wrong period whichever reading is used",
      raw: ""
    });
    return [];
  }
  if (inferred === "ambiguous") {
    return [dateOrderQuestion(
      "every date in this file falls in the first twelve days of a month, so the file itself does not reveal which order it uses"
    )];
  }
  if (inferred !== "day-first" && inferred !== "none") {
    rejected.push({
      line: 0,
      reason: `dates look ${inferred}, but this export is read day-first; transactions would be placed in the wrong period`,
      raw: ""
    });
  }
  return [];
}
function dateOrderQuestion(reason) {
  return {
    id: "date-order",
    question: "Are the dates in this file day-first or month-first?",
    reason,
    assumed: "read as day-first, which is what this export normally uses",
    options: [
      {
        id: "day-first",
        label: "Day first (31/12/25)",
        consequence: "what MYOB normally writes; transactions keep the periods you expect"
      },
      {
        id: "month-first",
        label: "Month first (12/31/25)",
        consequence: "some transactions move to a different month, and possibly a different quarter"
      }
    ]
  };
}
function typeFromCode(code) {
  switch (code.charAt(0)) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "income";
    case "5":
      return "cost-of-sales";
    case "6":
      return "expense";
    case "8":
      return "other-income";
    case "9":
      return "other-expense";
    default:
      return "unknown";
  }
}
function truncate(raw) {
  return raw.length > 120 ? `${raw.slice(0, 120)}\u2026` : raw;
}

// src/parse/counterparty.ts
var NOISE = new RegExp(
  String.raw`\s+(fees?|funds?\s+transfer|short\s+payment|payment|transfer|rcti|refund\w*|` + String.raw`invoice|inv|ref|receipt|deposit|dishonour\w*)\b.*$`,
  "i"
);
var TRAILING_REFERENCE = /\s+[A-Z]*\d[\d-]{3,}\w*\s*$/;
var TRAILING_DATE = /\s+\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s*$/;
var TRAILING_LOCALE = /\s+(AUS|AU|NZL|NZ|USA|US|GBR|UK|SGP|SG)\s*$/i;
var LEADING_DOCUMENT = /^(sale|purchase|payment|receipt)\s*;\s*/i;
var COMPANY_SUFFIX = /\b(pty|ltd|limited|pte|inc|incorporated|llc|plc|co|company)\b/gi;
function stripNarration(raw) {
  let out = raw.replace(LEADING_DOCUMENT, "").replace(NOISE, "");
  for (let i = 0; i < MAX_TRAILING_PASSES; i++) {
    const before = out;
    out = out.replace(TRAILING_REFERENCE, "").replace(TRAILING_DATE, "").replace(TRAILING_LOCALE, "");
    if (out === before) break;
  }
  return out.replace(/\s+/g, " ").replace(/[;,.\s]+$/, "").trim();
}
var MAX_TRAILING_PASSES = 4;
function counterpartyKey(raw) {
  return stripNarration(raw).replace(COMPANY_SUFFIX, "").replace(/[^a-z0-9]+/gi, "").toUpperCase();
}
function isCounterpartySide(account) {
  return account?.type === "asset" || account?.type === "liability";
}
function counterpartyLegFor(line, linesByRef, accounts) {
  const siblings = linesByRef.get(line.transactionRef) ?? [];
  const other = siblings.filter(
    (l) => l !== line && isCounterpartySide(accounts.get(l.accountCode)) && l.description.trim()
  );
  if (other.length === 0) return null;
  const invoice = other.find((l) => LEADING_DOCUMENT.test(l.description));
  if (invoice) return { narration: invoice.description.trim(), source: "invoice" };
  const bank = other[0];
  const sameText = bank.description.trim() === line.description.trim();
  return { narration: bank.description.trim(), source: sameText ? "same-leg" : "bank" };
}
function resolveCounterparties(ledger) {
  const accounts = new Map(ledger.accounts.map((a) => [a.code, a]));
  const linesByRef = /* @__PURE__ */ new Map();
  for (const line of ledger.lines) {
    const at = linesByRef.get(line.transactionRef);
    if (at) at.push(line);
    else linesByRef.set(line.transactionRef, [line]);
  }
  const found = /* @__PURE__ */ new Map();
  const variants = /* @__PURE__ */ new Map();
  for (const line of ledger.lines) {
    const leg = counterpartyLegFor(line, linesByRef, accounts);
    if (!leg) continue;
    found.set(line, leg);
    const key = counterpartyKey(leg.narration);
    if (!key) continue;
    const at = variants.get(key);
    if (at) at.push(leg);
    else variants.set(key, [leg]);
  }
  const display = /* @__PURE__ */ new Map();
  for (const [key, seen] of variants) {
    const invoice = seen.find((v) => v.source === "invoice");
    const chosen = invoice ? stripNarration(invoice.narration) : seen.map((v) => stripNarration(v.narration)).sort((a, b) => b.length - a.length)[0];
    display.set(key, chosen);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [line, leg] of found) {
    const key = counterpartyKey(leg.narration);
    if (!key) continue;
    out.set(line, {
      name: display.get(key) ?? stripNarration(leg.narration),
      key,
      narration: leg.narration,
      source: leg.source
    });
  }
  return out;
}

// src/handlers/import-ledger.ts
async function importLedger() {
  const { storageKey, filename } = signal.properties;
  const head = await gateway.attachment.head({
    storageKey,
    maxChars: SIGNATURE.length + 64
  });
  if (!claimsCeeData(head)) {
    return `Not a CeeData export (${filename}); leaving it alone.`;
  }
  const text = await gateway.attachment.read({ storageKey });
  const result = parseCeeData(text);
  const { ledger, rejected, clarifications } = result;
  if (!ledger.coverage.from || !ledger.coverage.to) {
    return `${filename} does not declare which period it covers, so it cannot be imported safely \u2014 a later export of the same period would double the totals rather than replace them.`;
  }
  const written = await writeLedger(ledger);
  return summarise(filename, result, written);
}
async function writeLedger(ledger) {
  const { entity, source } = ledger.coverage;
  await inBatches(ledger.accounts, (a) => ({
    // Keyed on the account code within one company's books: a code is unique per entity, and a
    // user may keep more than one set.
    key: `${source}:${entity}:${a.code}`,
    title: a.name,
    code: a.code,
    accountType: a.type,
    parentCode: a.parent ?? null,
    taxCode: a.taxCode ?? null,
    header: a.header,
    active: a.active,
    entity,
    source
  }), "LedgerAccount", "accounts");
  const transactions = [...groupByRef(ledger).values()];
  await inBatches(transactions, (t) => ({
    key: `${source}:${entity}:${t.reference}`,
    title: t.counterparty ?? t.narration,
    reference: t.reference,
    date: t.date,
    narration: t.narration,
    counterparty: t.counterparty,
    entity,
    source
  }), "LedgerTransaction", "transactions");
  const postings = await inBatches(postingRows(ledger), (r) => r, "LedgerEntry", "postings");
  await gateway.repository.createEntries({
    type: "LedgerCoverage",
    rows: [{
      key: `${source}:${entity}:${ledger.coverage.from}:${ledger.coverage.to}`,
      title: `${entity} ${ledger.coverage.from} to ${ledger.coverage.to}`,
      entity,
      fromDate: ledger.coverage.from,
      toDate: ledger.coverage.to,
      source,
      importedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lineCount: ledger.lines.length
    }]
  });
  return postings;
}
function postingRows(ledger) {
  const { entity, source } = ledger.coverage;
  const ordinals = /* @__PURE__ */ new Map();
  const accounts = new Map(ledger.accounts.map((a) => [a.code, a]));
  const counterparties = resolveCounterparties(ledger);
  return ledger.lines.map((l) => {
    const seen = ordinals.get(l.transactionRef) ?? 0;
    ordinals.set(l.transactionRef, seen + 1);
    const account = accounts.get(l.accountCode);
    const party = counterparties.get(l);
    return {
      key: `${source}:${entity}:${l.transactionRef}:${seen}`,
      title: l.description || `${l.accountCode} ${l.amount}`,
      amount: l.amount,
      date: l.date,
      accountCode: l.accountCode,
      // Carried on the posting, not left to a join. A question like "spend by supplier" is one
      // GROUP BY over these fields; without them the only path is a traversal, and this graph has
      // no edges between postings, accounts and transactions to traverse. A model asked to
      // aggregate invented `HAS_ACCOUNT`, got nothing, and reported the category as having no
      // data at all.
      accountName: account?.name ?? null,
      accountType: account?.type ?? null,
      counterparty: party?.name ?? null,
      counterpartyKey: party?.key ?? null,
      // The text the name was read from, so a report can show which spellings it merged rather
      // than asking anyone to trust the merge.
      counterpartyNarration: party?.narration ?? null,
      counterpartySource: party?.source ?? null,
      transactionRef: l.transactionRef,
      description: l.description,
      entity,
      source
    };
  });
}
function groupByRef(ledger) {
  const counterparties = resolveCounterparties(ledger);
  const byRef = /* @__PURE__ */ new Map();
  for (const line of ledger.lines) {
    const party = counterparties.get(line);
    const existing = byRef.get(line.transactionRef);
    if (!existing) {
      byRef.set(line.transactionRef, {
        reference: line.transactionRef,
        date: line.date,
        narration: party?.narration ?? line.description,
        counterparty: party?.name ?? null
      });
    } else if (!existing.counterparty && party) {
      existing.narration = party.narration;
      existing.counterparty = party.name;
    }
  }
  return byRef;
}
function parseWriteCounts(summary) {
  const created = /Created (\d+) new/.exec(summary);
  const updated = /[Uu]pdated (\d+) existing/.exec(summary);
  return {
    created: created ? Number(created[1]) : 0,
    updated: updated ? Number(updated[1]) : 0
  };
}
async function inBatches(items, toRow, type, label) {
  const total = { created: 0, updated: 0 };
  const batches = chunked(items, BATCH_SIZE);
  let done = 0;
  for (const chunk of batches) {
    const summary = await gateway.repository.createEntries({ type, rows: chunk.map(toRow) });
    const counts = parseWriteCounts(summary);
    total.created += counts.created;
    total.updated += counts.updated;
    done += chunk.length;
    if (batches.length > 1) await report(`imported ${done} of ${items.length} ${label}`);
  }
  return total;
}
async function report(message) {
  try {
    await gateway.progress?.report({ message });
  } catch {
  }
}
var BATCH_SIZE = 200;
function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function summarise(filename, result, written) {
  const { ledger, rejected, clarifications } = result;
  const { entity, from, to } = ledger.coverage;
  const { created, updated } = written;
  const scope = `for ${entity}, covering ${from} to ${to}, from ${filename}.`;
  const headline = created === 0 && updated > 0 ? `No new postings: all ${updated} in this file were already in your ledger, ${scope}` : updated === 0 ? `Imported ${created} postings and ${ledger.accounts.length} accounts ${scope}` : `Added ${created} new postings and refreshed ${updated} already present, across ${ledger.accounts.length} accounts, ${scope}`;
  const parts = [headline];
  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} row(s) could not be read: ` + rejected.slice(0, 3).map((r) => `line ${r.line} (${r.reason})`).join("; ") + (rejected.length > 3 ? `, and ${rejected.length - 3} more.` : ".")
    );
  }
  for (const c of clarifications) {
    parts.push(`${c.question} ${c.reason}. For now it was ${c.assumed}.`);
  }
  return parts.join(" ");
}

// src/handlers/import-ledger.entry.ts
console.log(await importLedger());
