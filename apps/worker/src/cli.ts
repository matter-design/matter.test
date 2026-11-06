/**
 * Run a site check from the terminal without Postgres or Redis.
 *   pnpm check https://example.com --max 50 --only seo,links,security
 *   pnpm check https://example.com --pdf --client "Northwind Outdoor" --project "Store launch"
 * Writes a JSON result to ./artefacts/<host>-<timestamp>.json, and the client PDF next to it with --pdf.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CHECK_CATEGORIES, type CheckCategory } from "@mattertest/core";
import { rate, runSiteCheck } from "@mattertest/checks";
import { buildReport, renderReportPdf } from "@mattertest/report";
import { reportInputFromResult, type CliReportMeta } from "./report";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: "string", default: "50" },
    only: { type: "string" },
    "no-robots": { type: "boolean", default: false },
    "no-throttle": { type: "boolean", default: false },
    desktop: { type: "boolean", default: false },
    "no-lighthouse": { type: "boolean", default: false },
    pdf: { type: "boolean", default: false },
    client: { type: "string" },
    project: { type: "string" },
  },
});

const url = positionals[0];
if (!url) {
  console.error("usage: pnpm check <url> [--max 50] [--only crawl,links,seo,security,accessibility,performance,platform] [--no-robots] [--desktop | --no-throttle] [--no-lighthouse] [--pdf --client <name> --project <name>]");
  process.exit(1);
}

const categories = (values.only?.split(",").map((s) => s.trim()) ?? [...CHECK_CATEGORIES]) as CheckCategory[];
const perfThrottle = values["no-throttle"] ? "none" : values.desktop ? "desktop" : "mobile";
const browser = await chromium.launch();
try {
  const started = Date.now();
  const result = await runSiteCheck(browser, {
    baseUrl: url,
    categories,
    maxPages: Number(values.max),
    respectRobots: !values["no-robots"],
    perfThrottle,
    perfEngine: values["no-lighthouse"] ? "browser" : "lighthouse",
    onProgress: (m) => console.log(`· ${m}`),
  });
  const bySev = result.findings.reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  const byCat = result.findings.reduce<Record<string, number>>((a, f) => ((a[f.category] = (a[f.category] ?? 0) + 1), a), {});
  console.log(`\nplatform: ${result.platform} (${result.platformEvidence.join(", ") || "no signals"})`);
  console.log(`pages: ${result.pages.length} · templates: ${JSON.stringify(result.templates)}`);
  console.log(`findings: ${result.findings.length} · by severity ${JSON.stringify(bySev)} · by category ${JSON.stringify(byCat)}`);
  for (const m of result.perf) {
    const v = (k: "lcp" | "cls" | "tbt", x: number | null) => (x === null ? "n/a" : `${k === "cls" ? x : k === "tbt" ? `${x}ms` : (x / 1000).toFixed(2) + "s"} (${rate(k, x)})`);
    const score = m.score === null ? "" : `score ${m.score} · `;
    const click = m.interaction ? ` · click ${m.interaction.latency}ms (${rate("interaction", m.interaction.latency)})` : "";
    console.log(`perf [${m.template}] ${m.url}  ${score}LCP ${v("lcp", m.lcp)} · CLS ${v("cls", m.cls)} · TBT ${v("tbt", m.tbt)} · ${(m.transferBytes / 1e6).toFixed(1)} MB${click}`);
  }
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const dir = process.env.ARTEFACT_DIR ?? "./artefacts";
  await mkdir(dir, { recursive: true });
  const file = `${dir}/${new URL(url).host}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const meta: CliReportMeta = { baseUrl: url, categories, finishedAt: new Date().toISOString(), perfThrottle };
  await writeFile(file, JSON.stringify({ ...result, meta }, null, 2));
  console.log(`result: ${file}`);
  if (values.pdf) {
    const pdf = file.replace(/\.json$/, ".pdf");
    await writeFile(pdf, await renderReportPdf(browser, buildReport(reportInputFromResult(result, meta, values))));
    console.log(`client report: ${pdf}`);
  }
} finally {
  await browser.close();
}
