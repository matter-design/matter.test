import { join } from "node:path";
import { repoRoot } from "@mattertest/core";

/** Turns text into vectors for `source_chunks.embedding` (1024 dimensions). */
export interface Embedder {
  readonly name: string;
  readonly dims: number;
  /** One vector per text, normalised to unit length. */
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBED_DIMS = 1024;

/** Default local model: 1024 dimensions, English, ~340 MB at 8-bit, downloaded from Hugging Face on first use. */
export const LOCAL_EMBED_MODEL = "mixedbread-ai/mxbai-embed-large-v1";

type Extractor = (texts: string[], opts: { pooling: "cls" | "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * Embeddings computed on this machine with transformers.js (ONNX runtime). No key and no network after the first
 * download; the model is cached under `<repo>/.cache/models` (or EMBED_CACHE_DIR).
 */
export function localEmbedder(model = process.env.EMBED_MODEL || LOCAL_EMBED_MODEL): Embedder {
  let extractor: Promise<Extractor> | null = null;
  const load = async () => {
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = process.env.EMBED_CACHE_DIR || join(repoRoot(), ".cache", "models");
    return (await t.pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as Extractor;
  };
  return {
    name: `local:${model}`,
    dims: EMBED_DIMS,
    async embed(texts) {
      extractor ??= load();
      const run = await extractor;
      const out: number[][] = [];
      // Small batches keep memory flat on a laptop.
      for (let i = 0; i < texts.length; i += 8) {
        const res = await run(texts.slice(i, i + 8), { pooling: "cls", normalize: true });
        out.push(...res.tolist());
      }
      for (const v of out) if (v.length !== EMBED_DIMS) throw new Error(`${model} returned ${v.length} dimensions; source_chunks needs ${EMBED_DIMS}`);
      return out;
    },
  };
}

/**
 * The embedder chosen by EMBEDDINGS: `local` (default) or `off` (chunks are stored without vectors;
 * extraction still works because Claude reads the whole source).
 */
export function embedderFromEnv(): Embedder | null {
  const mode = (process.env.EMBEDDINGS || "local").toLowerCase();
  if (mode === "off" || mode === "none") return null;
  if (mode === "local") return localEmbedder();
  throw new Error(`EMBEDDINGS=${mode} is not supported (use local or off)`);
}
