/** Needs a migrated Postgres at DATABASE_URL; skipped otherwise. */
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { SiteCheckResult } from "@mattertest/checks";
import { clients, createDb, environments, findings, projects, runs, tasks } from "@mattertest/db";
import { persistSiteCheck } from "../src/persist";

const hasDb = !!process.env.DATABASE_URL;
const db = hasDb ? createDb() : (undefined as never);

afterAll(async () => {
  if (hasDb) await db.$client.end();
});

const result = (titles: string[]): SiteCheckResult => ({
  platform: "bigcommerce",
  platformEvidence: ["html:cdn"],
  pages: [{ url: "https://shop.test/", status: 200, headers: {}, depth: 0, links: [], images: [] }],
  templates: { home: 1 },
  perf: [
    { url: "https://shop.test/", template: "home", engine: "lighthouse", score: 62, insights: [{ id: "render-blocking-insight", title: "Render blocking requests" }], interaction: { target: "button[aria-expanded] → button Menu", latency: 240 }, ttfb: 120, fcp: 900, lcp: 3100, lcpElement: "img.hero", cls: 0.02, tbt: 150, load: 2000, requests: 40, transferBytes: 900_000, jsBytes: 300_000, imageBytes: 400_000, renderBlocking: [], heavyImages: [] },
  ],
  visual: {
    browsers: ["chromium", "webkit"],
    viewports: ["mobile"],
    skippedBrowsers: [{ browser: "firefox", reason: "not installed" }],
    captures: [{ url: "https://shop.test/", template: "home", browser: "chromium", viewport: "mobile", status: "changed", diffRatio: 0.031, overflowPx: 12, jsErrors: [], brokenImages: [] }],
  },
  findings: titles.map((t) => ({ category: "seo", rule: `seo.${t}`, severity: "medium", title: t, url: "https://shop.test/" })),
});

describe.skipIf(!hasDb)("persistSiteCheck", () => {
  it("dedupes findings across runs and sets the platform", async () => {
    const slug = `t-${Date.now()}`;
    const [c] = await db.insert(clients).values({ name: "Test", slug }).returning();
    const [p] = await db.insert(projects).values({ clientId: c!.id, name: "P" }).returning();
    const [e] = await db.insert(environments).values({ projectId: p!.id, name: "production", baseUrl: "https://shop.test" }).returning();
    const newRun = async () => {
      const [t] = await db.insert(tasks).values({ projectId: p!.id, kind: "site-check", title: "check" }).returning();
      const [r] = await db.insert(runs).values({ taskId: t!.id, environmentId: e!.id }).returning();
      return r!.id;
    };

    const run1 = await newRun();
    await persistSiteCheck(db, run1, result(["title-missing", "h1-missing"]));
    const run2 = await newRun();
    await persistSiteCheck(db, run2, result(["title-missing"]));

    const rows = await db.select().from(findings).where(eq(findings.projectId, p!.id));
    expect(rows).toHaveLength(2);
    const title = rows.find((r) => r.rule === "seo.title-missing")!;
    expect(title.occurrences).toBe(2);
    expect(title.firstRunId).toBe(run1);
    expect(title.lastRunId).toBe(run2);

    const [r2] = await db.select().from(runs).where(eq(runs.id, run2));
    expect(r2!.status).toBe("done");
    expect(r2!.summary).toMatchObject({ findings: 1, possiblyFixed: 1 });

    const [proj] = await db.select().from(projects).where(eq(projects.id, p!.id));
    expect(proj!.platform).toBe("bigcommerce");
  });
});
