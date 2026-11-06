"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { environments, runs, tasks } from "@mattertest/db";
import { db, siteCheckQueue } from "@/lib/server";

const Input = z.object({ environmentId: z.string().uuid(), maxPages: z.coerce.number().int().min(1).max(5000).default(200) });

/** Create a site-check task + run and put it on the queue for the worker. */
export async function startSiteCheck(formData: FormData) {
  const { environmentId, maxPages } = Input.parse(Object.fromEntries(formData));
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId));
  if (!env) throw new Error("Environment not found");

  const [task] = await db
    .insert(tasks)
    .values({ projectId: env.projectId, kind: "site-check", trigger: "manual", title: `Site check: ${env.name}`, params: { maxPages } })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id, environmentId: env.id }).returning();

  await siteCheckQueue().add("site-check", {
    taskId: task!.id,
    runId: run!.id,
    environmentId: env.id,
    baseUrl: env.baseUrl,
    categories: ["crawl", "links", "seo", "security", "accessibility"],
    maxPages,
  });
  revalidatePath(`/projects/${env.projectId}`);
}
