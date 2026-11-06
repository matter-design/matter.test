/**
 * Turn a saved CLI result into a client PDF:
 *   pnpm report ./artefacts/shop.example.com-2026-11-06T....json --client "Northwind Outdoor" --project "Store launch"
 * Writes the PDF next to the JSON unless --out is given.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CHECK_CATEGORIES } from "@mattertest/core";
import type { SiteCheckResult } from "@mattertest/checks";
import { buildReport, renderReportPdf } from "@mattertest/report";
import { reportInputFromResult, type CliReportMeta } from "./report";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { client: { type: "string" }, project: { type: "string" }, out: { type: "string" } },
});
const file = positionals[0];
if (!file) {
  console.error('usage: pnpm report <result.json> [--client "Client name"] [--project "Project name"] [--out report.pdf]');
  process.exit(1);
}

const saved = JSON.parse(await readFile(file, "utf8")) as SiteCheckResult & { meta?: CliReportMeta };
// Results saved before meta was added: fall back to what the result itself shows.
const meta: CliReportMeta = saved.meta ?? { baseUrl: saved.pages[0]?.url ?? "https://unknown.invalid/", categories: [...CHECK_CATEGORIES], finishedAt: new Date().toISOString() };
const out = values.out ?? file.replace(/\.json$/i, "") + ".pdf";

const browser = await chromium.launch();
try {
  await writeFile(out, await renderReportPdf(browser, buildReport(reportInputFromResult({ ...saved, perf: saved.perf ?? [] }, meta, values))));
  console.log(`report: ${out}`);
} finally {
  await browser.close();
}
