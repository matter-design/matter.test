import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { repoRoot } from "@mattertest/core";

/** The team's standing QA rules, sent with every extraction and plan. */
export type QaGuidelines = { text: string; /** First 12 hex characters of the text's SHA-256: which version a run used. */ version: string; path: string };

/** Where the guide lives: QA_GUIDELINES_PATH (relative to the repo root) or docs/qa-guidelines.md. */
export function guidelinesPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.QA_GUIDELINES_PATH || "docs/qa-guidelines.md";
  return isAbsolute(p) ? p : resolve(repoRoot(), p);
}

/** Drop HTML comments (the editing notes at the top) and surplus blank lines. */
export function cleanGuidelines(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Longest guide sent to the model (characters); anything longer is cut, so a runaway file can't blow up every prompt. */
export const GUIDELINES_MAX = 20_000;

/**
 * Read the guide fresh on every job, so edits apply on the next run without a restart. Null when the file
 * is missing or empty: the agent then works from its built-in instructions alone.
 */
export async function loadGuidelines(path = guidelinesPath()): Promise<QaGuidelines | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let text = cleanGuidelines(raw);
  if (!text) return null;
  if (text.length > GUIDELINES_MAX) text = `${text.slice(0, GUIDELINES_MAX)}\n\n[The rest of the guide was cut: it's over ${GUIDELINES_MAX} characters.]`;
  return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 12), path };
}
