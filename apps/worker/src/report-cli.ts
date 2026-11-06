/**
 * Turn a saved CLI result into a client PDF:
 *   pnpm report ./artefacts/shop.example.com-2026-11-06T....json --client "Northwind Outdoor" --project "Store launch"
 * Writes the PDF next to the JSON unless --out is given.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CHECK_CATEGORIES } from "@mattertest/core";
import type { SiteCheckResult } from "@mattertest/checks";
import { buildReport, renderReportHtml, renderReportPdf } from "@mattertest/report";
import { reportInputFromResult, type CliReportMeta } from "./report";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { client: { type: "string" }, project: { type: "string" }, out: { type: "string" }, html: { type: "boolean", default: false } },
});
// pnpm runs this from apps/worker; resolve paths from the folder the user typed the command in.
const here = process.env.INIT_CWD ?? process.cwd();
const file = positionals[0] ? resolve(here, positionals[0]) : undefined;
if (!file) {
  console.error('usage: pnpm report <result.json> [--client "Client name"] [--project "Project name"] [--out report.pdf] [--html]');
  process.exit(1);
}

const saved = JSON.parse(await readFile(file, "utf8")) as SiteCheckResult & { meta?: CliReportMeta };
// Results saved before meta was added: fall back to what the result itself shows.
const meta: CliReportMeta = saved.meta ?? { baseUrl: saved.pages[0]?.url ?? "https://unknown.invalid/", categories: [...CHECK_CATEGORIES], finishedAt: new Date().toISOString() };
const out = values.out ? resolve(here, values.out) : file.replace(/\.json$/i, "") + ".pdf";

const browser = await chromium.launch();
try {
  const model = buildReport(await reportInputFromResult({ ...saved, perf: saved.perf ?? [], visual: saved.visual ?? null }, meta, values));
  await writeFile(out, await renderReportPdf(browser, model));
  console.log(`report: ${out}`);
  // --html also writes the HTML the PDF is printed from, for previewing the layout in a browser.
  if (values.html) {
    await writeFile(out.replace(/\.pdf$/i, "") + ".html", renderReportHtml(model));
    console.log(`html: ${out.replace(/\.pdf$/i, "")}.html`);
  }
} finally {
  await browser.close();
}
