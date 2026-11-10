import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type ConfluenceJob, type IngestJob, type PlanJob, type SiteCheckJob } from "@mattertest/core";
import { createDb, type Db } from "@mattertest/db";

const g = globalThis as unknown as { __db?: Db; __siteCheckQueue?: Queue<SiteCheckJob>; __agentQueue?: Queue<IngestJob | PlanJob | ConfluenceJob> };

/** One pool and one queue per server process (survives dev hot reloads). */
export const db = (g.__db ??= createDb());

export function siteCheckQueue() {
  return (g.__siteCheckQueue ??= new Queue<SiteCheckJob>(QUEUES.siteCheck, {
    connection: new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 3 }),
    defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  }));
}

/** Agent jobs: "ingest" (IngestJob), "plan" (PlanJob) and "confluence" (ConfluenceJob). */
export function agentQueue() {
  return (g.__agentQueue ??= new Queue<IngestJob | PlanJob | ConfluenceJob>(QUEUES.agent, {
    connection: new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 3 }),
    defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  }));
}
