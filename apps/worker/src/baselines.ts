import { readFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { artefactPath } from "@mattertest/core";
import { baselines, type Db } from "@mattertest/db";
import { keySlug, type BaselineKey, type BaselineStore } from "@mattertest/checks";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function write(uri: string, png: Buffer) {
  const full = artefactPath(uri);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, png);
  return uri;
}

/**
 * Baselines per environment. Each approval is a new row; the newest row for a
 * (url, browser, viewport) is the current baseline, so history is kept.
 */
export function dbBaselineStore(db: Db, environmentId: string, runId: string): BaselineStore {
  return {
    async get(k: BaselineKey) {
      const [row] = await db
        .select()
        .from(baselines)
        .where(and(eq(baselines.environmentId, environmentId), eq(baselines.url, k.url), eq(baselines.browser, k.browser), eq(baselines.viewport, k.viewport)))
        .orderBy(desc(baselines.createdAt))
        .limit(1);
      if (!row) return null;
      try {
        return { uri: row.imageUri, png: await readFile(artefactPath(row.imageUri)) };
      } catch {
        return null; // file lost (e.g. new machine): treat as no baseline and re-create
      }
    },
    async create(k, png) {
      const uri = await write(`visual/${environmentId}/baselines/${keySlug(k)}-${Date.now()}.png`, png);
      await db.insert(baselines).values({ environmentId, url: k.url, browser: k.browser, viewport: k.viewport, imageUri: uri, approvedBy: "first run" });
      return uri;
    },
    saveRunImage: (k, kind, png) => write(`visual/${environmentId}/runs/${runId}/${keySlug(k)}.${kind}.png`, png),
  };
}
