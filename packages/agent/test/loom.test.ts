import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loomLinkAt, loomVideoId } from "@mattertest/core";
import { LoomTranscriptUnavailable, fetchLoomTranscript, phrasesToCues } from "../src/loom";
import { NeedsTranscript, readSource } from "../src/pipeline";

const ID = "0123456789abcdef0123456789abcdef";
const LINK = `https://www.loom.com/share/${ID}`;
const vtt = readFileSync(new URL("./fixtures/walkthrough.vtt", import.meta.url), "utf8");

/** A fake fetch that answers by URL, recording calls. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; body?: unknown }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return key ? routes[key]!(init) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const json = (j: unknown) => new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } });

describe("loomVideoId", () => {
  it("accepts share and embed links, with or without a title slug and query", () => {
    expect(loomVideoId(LINK)).toBe(ID);
    expect(loomVideoId(`https://loom.com/embed/${ID}?sid=abc`)).toBe(ID);
    expect(loomVideoId(`https://www.loom.com/share/checkout-walkthrough-${ID.toUpperCase()}`)).toBe(ID);
  });

  it("refuses other hosts, paths and junk", () => {
    expect(loomVideoId(`https://evil.example/share/${ID}`)).toBeNull();
    expect(loomVideoId(`https://www.loom.com/looms/videos`)).toBeNull();
    expect(loomVideoId(`javascript:alert(1)`)).toBeNull();
    expect(loomVideoId("not a url")).toBeNull();
  });

  it("links to a moment in the video", () => {
    expect(loomLinkAt(LINK, 250.7)).toBe(`${LINK}?t=250`);
    expect(loomLinkAt(LINK, undefined)).toBe(LINK);
  });
});

describe("fetchLoomTranscript", () => {
  it("reads the captions file named by Loom's transcript query, plus oEmbed metadata", async () => {
    const { f, calls } = fakeFetch({
      "https://www.loom.com/v1/oembed": () => json({ title: "PDP changes", author_name: "Sam", duration: 48.2 }),
      "https://www.loom.com/graphql": () => json({ data: { fetchVideoTranscript: { id: "t1", video_id: ID, source_url: null, captions_source_url: "https://cdn.loom.test/captions.vtt" } } }),
      "https://cdn.loom.test/captions.vtt": () => new Response(vtt),
    });
    const t = await fetchLoomTranscript(LINK, f);
    expect(t.video).toEqual({ id: ID, title: "PDP changes", owner: "Sam", durationSec: 48 });
    expect(t.cues).toHaveLength(5);
    const gql = calls.find((c) => c.url === "https://www.loom.com/graphql")!.body as { operationName: string; variables: { videoId: string } };
    expect(gql.operationName).toBe("FetchVideoTranscript");
    expect(gql.variables.videoId).toBe(ID);
  });

  it("falls back to the JSON transcript when there are no captions", async () => {
    const { f } = fakeFetch({
      "https://www.loom.com/graphql": () => json({ data: { fetchVideoTranscript: { captions_source_url: null, source_url: "https://cdn.loom.test/t.json" } } }),
      "https://cdn.loom.test/t.json": () => json({ phrases: [{ ts: 0, value: "Hi" }, { ts: 4.5, value: "Size guide in a drawer" }] }),
    });
    const t = await fetchLoomTranscript(LINK, f);
    expect(t.cues).toEqual([{ start: 0, end: 4.5, text: "Hi" }, { start: 4.5, end: 9.5, text: "Size guide in a drawer" }]);
    expect(t.video.title).toBeUndefined(); // oEmbed 404 is fine
  });

  it("reports private videos, errors and missing transcripts as unavailable", async () => {
    const cases = [
      () => json({ data: { fetchVideoTranscript: { message: "You don't have access" } } }),
      () => json({ errors: [{ message: "Bad request" }] }),
      () => new Response("down", { status: 503 }),
      () => json({ data: { fetchVideoTranscript: { captions_source_url: null, source_url: null } } }),
    ];
    for (const route of cases) {
      const { f } = fakeFetch({ "https://www.loom.com/graphql": route });
      await expect(fetchLoomTranscript(LINK, f)).rejects.toBeInstanceOf(LoomTranscriptUnavailable);
    }
  });

  it("reads phrase lists defensively", () => {
    expect(phrasesToCues(null)).toEqual([]);
    expect(phrasesToCues({ phrases: [{ ts: "x", value: "bad" }, { ts: 3, value: "  " }, { start: 1, text: "ok" }] })).toEqual([{ start: 1, end: 6, text: "ok" }]);
  });
});

describe("readSource for Loom", () => {
  it("asks for a transcript when Loom can't provide one", async () => {
    const { f } = fakeFetch({ "https://www.loom.com/graphql": () => json({ data: { fetchVideoTranscript: { message: "Private" } } }) });
    await expect(readSource({ type: "loom", link: LINK }, f)).rejects.toBeInstanceOf(NeedsTranscript);
  });

  it("uses an attached transcript file instead of calling Loom", async () => {
    const { f, calls } = fakeFetch({});
    const r = await readSource({ type: "loom", link: LINK, file: Buffer.from(vtt) }, f);
    expect(calls).toHaveLength(0);
    expect(r.meta).toMatchObject({ transcriptFrom: "upload", durationSec: 48 });
    expect(r.chunks[0]!.locator.startSec).toBe(0);
  });

  it("fails clearly on an empty document", async () => {
    await expect(readSource({ type: "md", file: Buffer.from("   \n\n") })).rejects.toThrow(/No text found/);
  });
});
