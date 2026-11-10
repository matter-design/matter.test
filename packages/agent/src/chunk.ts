import type { ChunkLocator } from "@mattertest/core";
import type { Block, Cue } from "./parse";

export type Chunk = { position: number; sectionPath: string | null; locator: ChunkLocator; text: string };

export type ChunkOptions = {
  /** Most characters in a chunk (about 350 tokens at the default, which fits the embedding model's 512-token window). */
  maxChars?: number;
  /** Characters repeated from the end of a split paragraph at the start of the next chunk. */
  overlap?: number;
};

const DEFAULTS = { maxChars: 1500, overlap: 150 };

/** Split text longer than max at sentence ends (or spaces), repeating `overlap` characters between pieces. */
export function splitLong(text: string, max: number, overlap: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const window = text.slice(start, end);
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("\n"));
      const space = window.lastIndexOf(" ");
      const cut = sentence > max * 0.5 ? sentence + 1 : space > max * 0.5 ? space : window.length;
      end = start + cut;
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    // Step back by the overlap, to a word boundary.
    let next = Math.max(start + 1, end - overlap);
    const sp = text.indexOf(" ", next);
    if (sp > 0 && sp < end) next = sp + 1;
    start = next;
  }
  return out.filter(Boolean);
}

/**
 * A document whose sections all sit under one top heading (its title) gets that heading dropped from section paths:
 * "5.2 Invalid codes" reads better than "Checkout brief › 5. Promo codes › 5.2 Invalid codes" everywhere.
 */
function dropTitle(blocks: Block[]): Block[] {
  const tops = new Set(blocks.map((b) => b.headings[0] ?? ""));
  if (tops.size !== 1 || !blocks.some((b) => b.headings.length > 1)) return blocks;
  return blocks.map((b) => ({ ...b, headings: b.headings.slice(1) }));
}

const sectionOf = (b: Block) => (b.headings.length ? b.headings.join(" › ") : null);

/**
 * Pack document blocks into chunks. A chunk never spans two sections, so each one cites cleanly ("Checkout › Promo codes").
 * PDF chunks without headings are labelled by page.
 */
export function chunkBlocks(blocks: Block[], opts: ChunkOptions = {}): Chunk[] {
  const { maxChars, overlap } = { ...DEFAULTS, ...opts };
  blocks = dropTitle(blocks);
  const chunks: Chunk[] = [];
  type Open = { section: string | null; page?: number; parts: string[]; len: number };
  let cur: Open | null = null;
  const flush = () => {
    const c = cur as Open | null;
    if (c?.parts.length) chunks.push({ position: chunks.length, sectionPath: c.section ?? (c.page ? `Page ${c.page}` : null), locator: c.page ? { page: c.page } : {}, text: c.parts.join("\n\n") });
    cur = null;
  };
  for (const b of blocks) {
    const section = sectionOf(b);
    for (const piece of splitLong(b.text, maxChars, overlap)) {
      const open = cur as Open | null;
      if (open && (open.section !== section || open.len + piece.length + 2 > maxChars)) flush();
      const target: Open = (cur as Open | null) ?? { section, page: b.page, parts: [], len: 0 };
      cur = target;
      target.parts.push(piece);
      target.len += piece.length + 2;
    }
  }
  flush();
  return chunks;
}

/** 125 → "02:05", 3725 → "1:02:05". */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export type CueChunkOptions = {
  /** Longest window, seconds. */
  windowSec?: number;
  /** After this many seconds, a pause this long ends the chunk early. */
  minSec?: number;
  pauseSec?: number;
  maxChars?: number;
};

/**
 * Pack transcript cues into time windows (about 2 minutes, ending early at a pause once past a minute),
 * labelled with their time range ("04:10–06:05") so a citation can jump to that point in the video.
 * Untimed transcripts are packed like paragraphs and labelled "Part N".
 */
export function chunkCues(cues: Cue[], opts: CueChunkOptions = {}): Chunk[] {
  const { windowSec = 120, minSec = 60, pauseSec = 3, maxChars = DEFAULTS.maxChars } = opts;
  if (cues.length && cues.every((c) => Number.isNaN(c.start))) {
    return chunkBlocks(cues.map((c) => ({ headings: [], text: c.text })), { maxChars }).map((c, i) => ({ ...c, sectionPath: `Part ${i + 1}` }));
  }
  const timed = cues.filter((c) => !Number.isNaN(c.start)).sort((a, b) => a.start - b.start);
  const chunks: Chunk[] = [];
  let group: Cue[] = [];
  let len = 0;
  const flush = () => {
    if (!group.length) return;
    const startSec = Math.floor(group[0]!.start);
    const endSec = Math.ceil(Math.max(...group.map((c) => c.end)));
    chunks.push({ position: chunks.length, sectionPath: `${clock(startSec)}–${clock(endSec)}`, locator: { startSec, endSec }, text: group.map((c) => c.text).join(" ") });
    group = [];
    len = 0;
  };
  for (const c of timed) {
    if (group.length) {
      const first = group[0]!.start;
      const last = group[group.length - 1]!;
      const elapsed = c.start - first;
      const pause = c.start - last.end;
      if (elapsed >= windowSec || len + c.text.length > maxChars || (elapsed >= minSec && pause >= pauseSec)) flush();
    }
    group.push(c);
    len += c.text.length + 1;
  }
  flush();
  return chunks;
}
