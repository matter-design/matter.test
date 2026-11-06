"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { CheckCategory } from "@mattertest/core";
import { baselines, clients, environments, findings, projects, runs, tasks } from "@mattertest/db";
import { requireUser } from "@/lib/auth";
import { db, siteCheckQueue } from "@/lib/server";

/** What "Start check" runs. Stored on the task so the report knows which areas were covered. */
const CATEGORIES: CheckCategory[] = ["crawl", "links", "seo", "security", "accessibility", "performance", "platform", "visual"];

const Input = z.object({ environmentId: z.string().uuid(), maxPages: z.coerce.number().int().min(1).max(5000).default(200) });

/** Create a site-check task + run and put it on the queue for the worker. */
export async function startSiteCheck(formData: FormData) {
  const user = await requireUser();
  const { environmentId, maxPages } = Input.parse(Object.fromEntries(formData));
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId));
  if (!env) throw new Error("Environment not found");

  const [task] = await db
    .insert(tasks)
    .values({ projectId: env.projectId, kind: "site-check", trigger: "manual", title: `Site check: ${env.name}`, params: { maxPages, categories: CATEGORIES, perfThrottle: "mobile", requestedBy: user.email } })
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
  const user = await requireUser();
  const findingId = z.string().uuid().parse(formData.get("findingId"));
  const [f] = await db.select().from(findings).where(eq(findings.id, findingId));
  if (!f || f.rule !== "visual.changed") throw new Error("Not a visual change");
  const ev = (f.evidence ?? {}) as { currentUri?: string; browser?: string; viewport?: string };
  if (!ev.currentUri || !ev.browser || !ev.viewport) throw new Error("Finding has no screenshot to approve");
  const [run] = await db.select({ environmentId: runs.environmentId }).from(runs).where(eq(runs.id, f.lastRunId));
  if (!run?.environmentId) throw new Error("Run has no environment");
  await db.insert(baselines).values({ environmentId: run.environmentId, url: f.url, browser: ev.browser, viewport: ev.viewport, imageUri: ev.currentUri, approvedBy: user.email });
  await db.update(findings).set({ state: "fixed", updatedAt: new Date() }).where(eq(findings.id, f.id));
  revalidatePath(`/projects/${f.projectId}`);
}

const NewProject = z.object({
  client: z.string().trim().min(1, "Client name is required").max(120),
  name: z.string().trim().min(1, "Project name is required").max(120),
  baseUrl: z
    .string()
    .trim()
    .url("Enter the full site address, e.g. https://www.example.com.au")
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address"),
  environment: z.string().trim().min(1).max(40).default("production"),
});

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "client";

/** Add a project (and its client, if new) with one environment, then open it. Platform is detected on the first check. */
export async function createProject(formData: FormData) {
  await requireUser();
  const input = NewProject.parse(Object.fromEntries(formData));
  const slug = slugify(input.client);
  const projectId = await db.transaction(async (tx) => {
    // Reuse the client if one with the same slug exists (e.g. a second project for an existing client).
    const [existing] = await tx.select().from(clients).where(eq(clients.slug, slug));
    const client = existing ?? (await tx.insert(clients).values({ name: input.client, slug }).returning())[0]!;
    const [project] = await tx.insert(projects).values({ clientId: client.id, name: input.name, status: "active" }).returning();
    await tx.insert(environments).values({ projectId: project!.id, name: input.environment, baseUrl: new URL(input.baseUrl).toString() });
    return project!.id;
  });
  revalidatePath("/");
  redirect(`/projects/${projectId}`);
}
