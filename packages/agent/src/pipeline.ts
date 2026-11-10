import type { SourceType } from "@mattertest/core";
import { chunkBlocks, chunkCues, type Chunk } from "./chunk";
import { LoomTranscriptUnavailable, fetchLoomTranscript, type LoomVideo } from "./loom";
import { parseDocx, parseHtml, parseMarkdown, parsePdf, parseTranscript } from "./parse";
import { EXTRACT_SYSTEM, PLAN_SYSTEM, extractUser, planUser, type Passage, type PlanRequirement } from "./prompts";
import { Extraction, PlanDraft, resolveExtraction, resolvePlan, type ChunkRefs } from "./schemas";
import type { StructuredModel } from "./claude";

export type ReadInput = {
  type: SourceType;
  /** The uploaded file; for a Loom source a transcript the team attached; for a Confluence page its saved HTML. */
  file?: Buffer;
  /** Loom share link. */
  link?: string | null;
};

export type ReadResult = {
  chunks: Chunk[];
  meta: { pages?: number; durationSec?: number; title?: string; owner?: string; transcriptFrom?: "loom" | "upload" };
};

/** Raised when a Loom video's transcript can't be read from the link: the source waits for an uploaded transcript. */
export class NeedsTranscript extends Error {
  constructor(
    message: string,
    readonly video?: Partial<LoomVideo>,
  ) {
    super(message);
    this.name = "NeedsTranscript";
  }
}

const durationOf = (chunks: Chunk[]) => {
  const ends = chunks.map((c) => c.locator.endSec).filter((n): n is number => typeof n === "number");
  return ends.length ? Math.max(...ends) : undefined;
};

/** Turn a source into chunks. Throws NeedsTranscript for a Loom video without a readable transcript. */
export async function readSource(input: ReadInput, f: typeof fetch = fetch): Promise<ReadResult> {
  let chunks: Chunk[];
  const meta: ReadResult["meta"] = {};
  switch (input.type) {
    case "pdf": {
      const { blocks, pages } = await parsePdf(need(input.file));
      chunks = chunkBlocks(blocks);
      meta.pages = pages;
      break;
    }
    case "docx":
      chunks = chunkBlocks(await parseDocx(need(input.file)));
      break;
    case "md":
      chunks = chunkBlocks(parseMarkdown(need(input.file).toString("utf8")));
      break;
    case "confluence":
      chunks = chunkBlocks(parseHtml(need(input.file).toString("utf8")));
      break;
    case "transcript":
      chunks = chunkCues(parseTranscript(need(input.file).toString("utf8")));
      meta.durationSec = durationOf(chunks);
      break;
    case "loom": {
      if (input.file) {
        chunks = chunkCues(parseTranscript(input.file.toString("utf8")));
        meta.transcriptFrom = "upload";
      } else {
        if (!input.link) throw new Error("Loom source has no link");
        try {
          const t = await fetchLoomTranscript(input.link, f);
          chunks = chunkCues(t.cues);
          Object.assign(meta, { title: t.video.title, owner: t.video.owner, durationSec: t.video.durationSec, transcriptFrom: "loom" as const });
        } catch (e) {
          if (e instanceof LoomTranscriptUnavailable) throw new NeedsTranscript(e.message);
          throw e;
        }
      }
      meta.durationSec ??= durationOf(chunks);
      break;
    }
    default:
      throw new Error(`Can't read sources of type ${input.type as string}`);
  }
  if (!chunks.length) throw new Error("No text found in this source. Scanned PDFs (images of text) aren't supported yet.");
  return { chunks, meta };
}

function need(file: Buffer | undefined): Buffer {
  if (!file) throw new Error("The source file is missing");
  return file;
}

/** Short refs (c1, c2…) for the passages shown to the model, and the map back to chunk ids. */
export function refChunks<T extends { id: string }>(chunks: T[]): { refs: ChunkRefs; refOf: Map<string, string> } {
  const refs: ChunkRefs = new Map();
  const refOf = new Map<string, string>();
  chunks.forEach((c, i) => {
    refs.set(`c${i + 1}`, c.id);
    refOf.set(c.id, `c${i + 1}`);
  });
  return { refs, refOf };
}

export type StoredChunk = Chunk & { id: string };
export type ProjectContext = {
  project: string;
  client: string;
  platform: string;
  siteUrl?: string | null;
  /** The team's standing instructions to the agent for this project. */
  instructions?: string | null;
};

/** Ask Claude for the requirements and client questions in one source. */
export async function extractRequirements(model: StructuredModel, ctx: ProjectContext, source: { name: string; type: string; note?: string | null }, chunks: StoredChunk[]) {
  const { refs } = refChunks(chunks);
  const passages: Passage[] = chunks.map((c, i) => ({ ref: `c${i + 1}`, sourceName: source.name, sourceType: source.type, sectionPath: c.sectionPath, locator: c.locator, text: c.text }));
  const res = await model({
    schema: Extraction,
    system: EXTRACT_SYSTEM,
    user: extractUser({ ...ctx, sourceName: source.name, sourceType: source.type, sourceNote: source.note, passages }),
    effort: "high",
  });
  return { ...resolveExtraction(res.data, refs), usage: res.usage, model: res.model };
}

export type PlanInputRequirement = Omit<PlanRequirement, "passageRefs"> & { sourceChunkIds: string[] };
export type PlanInputChunk = StoredChunk & { sourceName: string; sourceType: string };

/**
 * Ask Claude for a plan, scenarios and test cases. The model sees every requirement and the passages they cite
 * (plus neighbouring passages for context, up to a budget), so its own citations can be checked.
 */
export async function draftPlan(
  model: StructuredModel,
  ctx: ProjectContext,
  requirements: PlanInputRequirement[],
  chunks: PlanInputChunk[],
  openQuestions: string[] = [],
  sourceNotes: { source: string; note: string }[] = [],
) {
  const { refs, refOf } = refChunks(chunks);
  const passages: Passage[] = chunks.map((c) => ({ ref: refOf.get(c.id)!, sourceName: c.sourceName, sourceType: c.sourceType, sectionPath: c.sectionPath, locator: c.locator, text: c.text }));
  const reqs: PlanRequirement[] = requirements.map((r) => ({ ...r, passageRefs: r.sourceChunkIds.map((id) => refOf.get(id)).filter((x): x is string => !!x) }));
  const res = await model({
    schema: PlanDraft,
    system: PLAN_SYSTEM,
    user: planUser({ ...ctx, requirements: reqs, passages, openQuestions, sourceNotes }),
    effort: "high",
  });
  return { ...resolvePlan(res.data, new Set(requirements.map((r) => r.key)), refs), usage: res.usage, model: res.model };
}
