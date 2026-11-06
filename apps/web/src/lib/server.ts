import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type SiteCheckJob } from "@mattertest/core";
import { createDb, type Db } from "@mattertest/db";

const g = globalThis as unknown as { __db?: Db; __siteCheckQueue?: Queue<SiteCheckJob> };

/** One pool and one queue per server process (survives dev hot reloads). */
export const db = (g.__db ??= createDb());

export function siteCheckQueue() {
  return (g.__siteCheckQueue ??= new Queue<SiteCheckJob>(QUEUES.siteCheck, {
    connection: new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 3 }),
    defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  }));
}
