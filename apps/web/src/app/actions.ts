"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { CheckCategory } from "@mattertest/core";
import { baselines, environments, findings, runs, tasks } from "@mattertest/db";
import { db, siteCheckQueue } from "@/lib/server";

/** What "Start check" runs. Stored on the task so the report knows which areas were covered. */
const CATEGORIES: CheckCategory[] = ["crawl", "links", "seo", "security", "accessibility", "performance", "platform", "visual"];

const Input = z.object({ environmentId: z.string().uuid(), maxPages: z.coerce.number().int().min(1).max(5000).default(200) });

/** Create a site-check task + run and put it on the queue for the worker. */
export async function startSiteCheck(formData: FormData) {
  const { environmentId, maxPages } = Input.parse(Object.fromEntries(formData));
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId));
  if (!env) throw new Error("Environment not found");

  const [task] = await db
    .insert(tasks)
    .values({ projectId: env.projectId, kind: "site-check", trigger: "manual", title: `Site check: ${env.name}`, params: { maxPages, categories: CATEGORIES, perfThrottle: "mobile" } })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id, environmentId: env.id }).returning();

  await siteCheckQueue().add("site-check", {
    taskId: task!.id,
    runId: run!.id,
    environmentId: env.id,
    baseUrl: env.baseUrl,
    categories: CATEGORIES,
    maxPages,
  });
  revalidatePath(`/projects/${env.projectId}`);
}

/**
 * Approve a visual change: this run's screenshot becomes the baseline for that page, browser and viewport,
 * and the finding is closed. The old baseline stays in the table as history.
 */
export async function acceptVisualChange(formData: FormData) {
  const findingId = z.string().uuid().parse(formData.get("findingId"));
  const [f] = await db.select().from(findings).where(eq(findings.id, findingId));
  if (!f || f.rule !== "visual.changed") throw new Error("Not a visual change");
  const ev = (f.evidence ?? {}) as { currentUri?: string; browser?: string; viewport?: string };
  if (!ev.currentUri || !ev.browser || !ev.viewport) throw new Error("Finding has no screenshot to approve");
  const [run] = await db.select({ environmentId: runs.environmentId }).from(runs).where(eq(runs.id, f.lastRunId));
  if (!run?.environmentId) throw new Error("Run has no environment");
  await db.insert(baselines).values({ environmentId: run.environmentId, url: f.url, browser: ev.browser, viewport: ev.viewport, imageUri: ev.currentUri, approvedBy: "web" });
  await db.update(findings).set({ state: "fixed", updatedAt: new Date() }).where(eq(findings.id, f.id));
  revalidatePath(`/projects/${f.projectId}`);
}
