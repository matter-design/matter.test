import { loomVideoId } from "@mattertest/core";
import { parseCaptions, type Cue } from "./parse";

/**
 * Loom has no official transcript API. Public share pages load the transcript through Loom's own GraphQL endpoint,
 * which needs no sign-in for videos shared with "anyone with the link". That endpoint is undocumented and may change;
 * when it fails, or the video is workspace-only, the source asks for an uploaded transcript instead.
 */
const GRAPHQL = "https://www.loom.com/graphql";
const OEMBED = "https://www.loom.com/v1/oembed";

export type LoomVideo = { id: string; title?: string; owner?: string; durationSec?: number };
export type LoomTranscript = { video: LoomVideo; cues: Cue[] };

export class LoomTranscriptUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoomTranscriptUnavailable";
  }
}

type Fetch = typeof fetch;
const HEADERS = { "content-type": "application/json", accept: "application/json", "apollographql-client-name": "web" };

/** Title, owner and length from Loom's official oEmbed endpoint. Best effort: missing fields stay undefined. */
export async function loomOembed(link: string, f: Fetch = fetch): Promise<Partial<LoomVideo>> {
  try {
    const res = await f(`${OEMBED}?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return {};
    const j = (await res.json()) as { title?: string; author_name?: string; duration?: number };
    return { title: j.title || undefined, owner: j.author_name || undefined, durationSec: typeof j.duration === "number" ? Math.round(j.duration) : undefined };
  } catch {
    return {};
  }
}

const TRANSCRIPT_QUERY = `query FetchVideoTranscript($videoId: ID!, $password: String) {
  fetchVideoTranscript(videoId: $videoId, password: $password) {
    ... on VideoTranscriptDetails { id video_id source_url captions_source_url }
    ... on GenericError { message }
  }
}`;

/** Fetch the auto-generated transcript of a public Loom video as timed cues. Throws LoomTranscriptUnavailable when it can't. */
export async function fetchLoomTranscript(link: string, f: Fetch = fetch): Promise<LoomTranscript> {
  const id = loomVideoId(link);
  if (!id) throw new LoomTranscriptUnavailable("That isn't a Loom share link.");
  const meta = await loomOembed(link, f);
  const video: LoomVideo = { id, ...meta };

  let details: { captions_source_url?: string | null; source_url?: string | null; message?: string } | undefined;
  try {
    const res = await f(GRAPHQL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ operationName: "FetchVideoTranscript", variables: { videoId: id, password: null }, query: TRANSCRIPT_QUERY }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { fetchVideoTranscript?: typeof details }; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(j.errors[0]!.message);
    details = j.data?.fetchVideoTranscript ?? undefined;
  } catch (e) {
    throw new LoomTranscriptUnavailable(`Loom didn't return a transcript (${(e as Error).message}).`);
  }
  if (!details || details.message) throw new LoomTranscriptUnavailable(details?.message ? `Loom: ${details.message}` : "Loom has no transcript for this video, or it isn't shared publicly.");

  if (details.captions_source_url) {
    const res = await f(details.captions_source_url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const cues = parseCaptions(await res.text());
      if (cues.length) return { video, cues };
    }
  }
  if (details.source_url) {
    const res = await f(details.source_url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const cues = phrasesToCues(await res.json());
      if (cues.length) return { video, cues };
    }
  }
  throw new LoomTranscriptUnavailable("Loom has no transcript for this video yet, or it isn't shared publicly.");
}

/** Loom's JSON transcript: `{ phrases: [{ ts: seconds, value: text }] }` (shape undocumented; read defensively). */
export function phrasesToCues(j: unknown): Cue[] {
  const phrases = (j as { phrases?: unknown })?.phrases ?? (Array.isArray(j) ? j : []);
  if (!Array.isArray(phrases)) return [];
  const cues = phrases
    .map((p) => ({ start: Number((p as { ts?: unknown }).ts ?? (p as { start?: unknown }).start), text: String((p as { value?: unknown }).value ?? (p as { text?: unknown }).text ?? "").trim() }))
    .filter((p) => Number.isFinite(p.start) && p.text)
    .map((p) => ({ start: p.start, end: p.start, text: p.text }));
  cues.forEach((c, i) => (c.end = cues[i + 1]?.start ?? c.start + 5));
  return cues;
}
