"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { CheckCategory, Platform } from "@mattertest/core";
import { detectPlatform } from "@mattertest/checks/platform";
import { baselines, clients, environments, findings, projects, runs, tasks } from "@mattertest/db";
import { requireUser } from "@/lib/auth";
import { db, siteCheckQueue } from "@/lib/server";

/** What "Start check" runs. Stored on the task so the report knows which areas were covered. */
const CATEGORIES: CheckCategory[] = ["crawl", "links", "seo", "security", "accessibility", "performance", "platform", "visual"];
const DEFAULT_MAX_PAGES = 200;

type Env = typeof environments.$inferSelect;

/** Create a site-check task + run and put it on the queue. If the queue is unreachable the run is marked failed and the error rethrown. */
async function queueSiteCheck(env: Env, maxPages: number, requestedBy: string, title = `Site check: ${env.name}`) {
  const [task] = await db
    .insert(tasks)
    .values({ projectId: env.projectId, kind: "site-check", trigger: "manual", title, params: { maxPages, categories: CATEGORIES, perfThrottle: "mobile", requestedBy } })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id, environmentId: env.id }).returning();
  try {
    await siteCheckQueue().add("site-check", { taskId: task!.id, runId: run!.id, environmentId: env.id, baseUrl: env.baseUrl, categories: CATEGORIES, maxPages });
  } catch (e) {
    const message = "Could not reach the job queue (is Redis running?)";
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error: message } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
    throw new Error(message, { cause: e });
  }
  return run!.id;
}

const StartInput = z.object({ environmentId: z.string().uuid(), maxPages: z.coerce.number().int().min(1).max(5000).default(DEFAULT_MAX_PAGES) });

/** "Run site check" on the dashboard. */
export async function startSiteCheck(formData: FormData) {
  const user = await requireUser();
  const { environmentId, maxPages } = StartInput.parse(Object.fromEntries(formData));
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId));
  if (!env) throw new Error("Environment not found");
  await queueSiteCheck(env, maxPages, user.email);
  revalidatePath(`/projects/${env.projectId}`);
  revalidatePath("/");
}

/**
 * Approve the "now" screenshot of a visual change as the new baseline for that page/browser/viewport,
 * and close the finding. The old baseline stays in the table as history.
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
  revalidatePath(`/findings/${f.id}`);
}

const TRIAGE_STATES = ["open", "ignored", "accepted-risk"] as const;

/** Triage on the finding page: reopen, mark as a false positive, or accept the risk. */
export async function setFindingState(formData: FormData) {
  await requireUser();
  const findingId = z.string().uuid().parse(formData.get("findingId"));
  const state = z.enum(TRIAGE_STATES).parse(formData.get("state"));
  const [f] = await db.update(findings).set({ state, updatedAt: new Date() }).where(eq(findings.id, findingId)).returning({ projectId: findings.projectId });
  if (!f) throw new Error("Finding not found");
  revalidatePath(`/findings/${findingId}`);
  revalidatePath(`/projects/${f.projectId}`);
  revalidatePath("/");
}

const httpUrl = (label: string) =>
  z
    .string()
    .trim()
    .url(`Enter the full ${label}, e.g. https://www.example.com.au`)
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");

const NewProject = z.object({
  client: z.string().trim().min(1, "Client name is required").max(120),
  name: z.string().trim().min(1, "Project name is required").max(120),
  productionUrl: httpUrl("production address"),
  stagingUrl: z.union([z.literal(""), httpUrl("staging address")]).default(""),
  jiraKey: z
    .string()
    .trim()
    .max(20)
    .regex(/^([A-Z][A-Z0-9_]*)?$/, "Jira keys are capital letters and digits, e.g. NW")
    .default(""),
  slackChannel: z
    .string()
    .trim()
    .max(80)
    .regex(/^(#?[a-z0-9][a-z0-9._-]*)?$/, "Slack channels are lower case, e.g. #qa-northwind")
    .default(""),
  platform: z.string().optional(),
  runFirstCheck: z.literal("on").optional(),
});

export type NewProjectState = { error?: string; fields?: Partial<Record<keyof z.infer<typeof NewProject>, string>> };

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "client";

/**
 * Set up a project from the dialog: client (reused when the name matches an existing one), project,
 * production and optional staging environments, then optionally queue the first site check on production.
 */
export async function createProject(_prev: NewProjectState, formData: FormData): Promise<NewProjectState> {
  const user = await requireUser();
  const parsed = NewProject.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fields: NewProjectState["fields"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<NewProjectState["fields"]>;
      fields[key] ??= issue.message;
    }
    return { error: "Check the highlighted fields.", fields };
  }
  const input = parsed.data;
  const platform = PLATFORMS_DETECTABLE.has(input.platform as Platform) ? (input.platform as Platform) : "custom";
  const slug = slugify(input.client);

  const { projectId, production } = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(clients).where(eq(clients.slug, slug));
    const client = existing ?? (await tx.insert(clients).values({ name: input.client, slug }).returning())[0]!;
    const [dupe] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.clientId, client.id), eq(projects.name, input.name)));
    if (dupe) return { projectId: dupe.id, production: null, duplicate: true };
    const [project] = await tx
      .insert(projects)
      .values({
        clientId: client.id,
        name: input.name,
        platform,
        status: "onboarding",
        jiraKey: input.jiraKey || null,
        slackChannel: input.slackChannel ? (input.slackChannel.startsWith("#") ? input.slackChannel : `#${input.slackChannel}`) : null,
      })
      .returning();
    const [prod] = await tx.insert(environments).values({ projectId: project!.id, name: "production", baseUrl: new URL(input.productionUrl).toString() }).returning();
    if (input.stagingUrl) await tx.insert(environments).values({ projectId: project!.id, name: "staging", baseUrl: new URL(input.stagingUrl).toString() });
    return { projectId: project!.id, production: prod!, duplicate: false };
  });

  if (!production) return { error: `${input.client} already has a project called "${input.name}".`, fields: { name: "Choose a different name" } };

  let queued = "";
  if (input.runFirstCheck) {
    try {
      await queueSiteCheck(production, DEFAULT_MAX_PAGES, user.email, "First site check: production");
    } catch {
      queued = "?queue=failed";
    }
  }
  revalidatePath("/");
  redirect(`/projects/${projectId}${queued}`);
}

const PLATFORMS_DETECTABLE = new Set<Platform>(["bigcommerce", "shopify", "wordpress", "laravel", "nextjs"]);

export type DetectResult = { ok: true; platform: Platform; evidence: string[] } | { ok: false; reason: string };

/**
 * One GET of the production home page to name the platform while the dialog is open.
 * No crawling, no retries; a failure just means the platform is found on the first check.
 */
export async function detectSitePlatform(url: string): Promise<DetectResult> {
  await requireUser();
  const parsed = httpUrl("address").safeParse(url);
  if (!parsed.success) return { ok: false, reason: "Not a full http(s) address yet" };
  try {
    const res = await fetch(parsed.data, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "MatterTest/0.1 (platform detection)", accept: "text/html" },
    });
    const html = (await res.text()).slice(0, 1_500_000);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const signal = detectPlatform(html, headers);
    if (!res.ok && signal.platform === "custom") return { ok: false, reason: `The site answered ${res.status}` };
    return { ok: true, platform: signal.platform, evidence: signal.evidence };
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    return { ok: false, reason: timeout ? "The site took too long to answer" : "Could not reach the site" };
  }
}
