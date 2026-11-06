/**
 * Render the sample report for design review:
 *   pnpm --filter @mattertest/report sample [out-prefix]
 * Writes <out-prefix>.html and <out-prefix>.pdf (default ./artefacts/sample-report).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { buildReport, renderReportHtml, renderReportPdf } from "../src/index";
import { sampleInput } from "./sample";

const out = process.argv[2] ?? "./artefacts/sample-report";
await mkdir(dirname(out), { recursive: true });
const model = buildReport(sampleInput());
await writeFile(`${out}.html`, renderReportHtml(model));
const browser = await chromium.launch();
try {
  await writeFile(`${out}.pdf`, await renderReportPdf(browser, model));
} finally {
  await browser.close();
}
console.log(`wrote ${out}.pdf`);
