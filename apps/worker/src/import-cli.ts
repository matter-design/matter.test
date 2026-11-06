/**
 * Load a terminal check (`pnpm check … ` JSON) into the database, so it shows in the web app
 * without checking the site again. Creates the client, project and environment if needed.
 *
 *   pnpm import-run artefacts/<file>.json --client Debras --project "Debras website" [--env production]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { SiteCheckResult } from "@mattertest/checks";
import { clients, createDb, environments, projects, runs, tasks } from "@mattertest/db";
import { persistSiteCheck } from "./persist";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const clientName = flag("client");
const projectName = flag("project");
const envName = flag("env") ?? "production";
if (!file || !clientName || !projectName) {
  console.error('usage: pnpm import-run <result.json> --client <name> --project <name> [--env production]');
  process.exit(1);
}

const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const data = JSON.parse(await readFile(path, "utf8")) as SiteCheckResult & {
  meta?: { baseUrl?: string; categories?: string[]; finishedAt?: string; perfThrottle?: string };
};
const baseUrl = data.meta?.baseUrl ?? data.pages[0]?.url;
if (!baseUrl) throw new Error("result has no base URL");

const slug = clientName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "client";
const db = createDb();

const { runId, projectId } = await db.transaction(async (tx) => {
  const client = (await tx.select().from(clients).where(eq(clients.slug, slug)))[0] ?? (await tx.insert(clients).values({ name: clientName, slug }).returning())[0]!;
  const project =
    (await tx.select().from(projects).where(and(eq(projects.clientId, client.id), eq(projects.name, projectName))))[0] ??
    (await tx.insert(projects).values({ clientId: client.id, name: projectName, status: "active" }).returning())[0]!;
  const env =
    (await tx.select().from(environments).where(and(eq(environments.projectId, project.id), eq(environments.name, envName))))[0] ??
    (await tx.insert(environments).values({ projectId: project.id, name: envName, baseUrl: new URL(baseUrl).toString() }).returning())[0]!;
  const finishedAt = data.meta?.finishedAt ? new Date(data.meta.finishedAt) : new Date();
  const [task] = await tx
    .insert(tasks)
    .values({
      projectId: project.id,
      kind: "site-check",
      trigger: "manual",
      status: "done",
      title: `Site check: ${env.name}`,
      params: { categories: data.meta?.categories ?? [], perfThrottle: data.meta?.perfThrottle ?? "mobile", importedFrom: file },
    })
    .returning();
  const [run] = await tx.insert(runs).values({ taskId: task!.id, environmentId: env.id, status: "running", startedAt: finishedAt }).returning();
  return { runId: run!.id, projectId: project.id };
});

await persistSiteCheck(db, runId, data);
if (data.meta?.finishedAt) await db.update(runs).set({ finishedAt: new Date(data.meta.finishedAt) }).where(eq(runs.id, runId));

console.log(`imported ${data.findings.length} findings into project ${projectId} (run ${runId})`);
process.exit(0);
