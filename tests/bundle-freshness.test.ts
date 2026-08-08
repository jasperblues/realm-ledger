import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * The committed bundle must match its source.
 *
 * `actions/import-ledger.ts` is a build artifact that has to be committed: the host clones the
 * realm and the spec loader inlines that exact file, so it must be present in the repository
 * rather than produced later. That makes it the one file here that can silently go stale — edit
 * the handler or the parser, forget `npm run build`, and the realm ships behaviour that no test
 * covers, because every other test exercises the source.
 *
 * This rebuilds in memory and compares. It fails loudly rather than letting a stale artifact
 * through, and the fix it names is the one that works.
 */
describe("committed bundle", () => {
  it("is up to date with src", async () => {
    const root = resolve(__dirname, "..");

    const result = await build({
      entryPoints: [resolve(root, "src/handlers/import-ledger.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      logLevel: "silent",
    });

    const rebuilt = result.outputFiles[0].text;
    const committed = readFileSync(resolve(root, "actions/import-ledger.ts"), "utf8");

    expect(
      rebuilt === committed,
      "actions/import-ledger.ts is stale — run `npm run build` and commit the result",
    ).toBe(true);
  });
});
