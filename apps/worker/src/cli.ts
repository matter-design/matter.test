/**
 * Run a site check from the terminal without Postgres or Redis.
 *   pnpm check https://example.com --max 50 --only seo,links,security
 * Writes a JSON report to ./artefacts/<host>-<timestamp>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CHECK_CATEGORIES, type CheckCategory } from "@mattertest/core";
import { runSiteCheck } from "@mattertest/checks";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: "string", default: "50" },
    only: { type: "string" },
    "no-robots": { type: "boolean", default: false },
  },
});

const url = positionals[0];
if (!url) {
  console.error("usage: pnpm check <url> [--max 50] [--only seo,links,security,accessibility,crawl] [--no-robots]");
  process.exit(1);
}

const categories = (values.only?.split(",").map((s) => s.trim()) ?? [...CHECK_CATEGORIES]) as CheckCategory[];
const browser = await chromium.launch();
try {
  const started = Date.now();
  const result = await runSiteCheck(browser, {
    baseUrl: url,
    categories,
    maxPages: Number(values.max),
    respectRobots: !values["no-robots"],
    onProgress: (m) => console.log(`· ${m}`),
  });
  const bySev = result.findings.reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  const byCat = result.findings.reduce<Record<string, number>>((a, f) => ((a[f.category] = (a[f.category] ?? 0) + 1), a), {});
  console.log(`\nplatform: ${result.platform} (${result.platformEvidence.join(", ") || "no signals"})`);
  console.log(`pages: ${result.pages.length} · templates: ${JSON.stringify(result.templates)}`);
  console.log(`findings: ${result.findings.length} · by severity ${JSON.stringify(bySev)} · by category ${JSON.stringify(byCat)}`);
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const dir = process.env.ARTEFACT_DIR ?? "./artefacts";
  await mkdir(dir, { recursive: true });
  const file = `${dir}/${new URL(url).host}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(result, null, 2));
  console.log(`report: ${file}`);
} finally {
  await browser.close();
}
