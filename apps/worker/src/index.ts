import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { chromium } from "playwright";
import { QUEUES, SiteCheckJob } from "@mattertest/core";
import { runSiteCheck } from "@mattertest/checks";
import { createDb, runs, tasks } from "@mattertest/db";
import { dbBaselineStore } from "./baselines";
import { persistSiteCheck } from "./persist";

const db = createDb();
// Workers need maxRetriesPerRequest: null for blocking commands.
const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const browser = await chromium.launch();

const siteCheckWorker = new Worker(
  QUEUES.siteCheck,
  async (job) => {
    const data = SiteCheckJob.parse(job.data);
    await db.update(runs).set({ status: "running", startedAt: new Date() }).where(eq(runs.id, data.runId));
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, data.taskId));
    try {
      const result = await runSiteCheck(browser, {
        baseUrl: data.baseUrl,
        categories: data.categories,
        maxPages: data.maxPages,
        concurrency: Number(process.env.CRAWL_CONCURRENCY ?? 4),
        delayMs: Number(process.env.CRAWL_DELAY_MS ?? 250),
        userAgent: process.env.CRAWL_USER_AGENT,
        visual: { store: dbBaselineStore(db, data.environmentId, data.runId) },
        onProgress: (msg) => void job.log(msg),
      });
      await persistSiteCheck(db, data.runId, result);
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, data.taskId));
      return { pages: result.pages.length, findings: result.findings.length };
    } catch (e) {
      await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error: (e as Error).message } }).where(eq(runs.id, data.runId));
      await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, data.taskId));
      throw e;
    }
  },
  { connection, concurrency: 1 },
);

siteCheckWorker.on("completed", (job, r) => console.log(`[site-check] ${job.id} done`, r));
siteCheckWorker.on("failed", (job, err) => console.error(`[site-check] ${job?.id} failed`, err.message));
console.log("worker ready: listening on", QUEUES.siteCheck);

const shutdown = async () => {
  await siteCheckWorker.close();
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
