import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * A run of text from a document, with the headings above it.
 * Documents become blocks; the chunker packs blocks into chunks without crossing a heading.
 */
export type Block = { headings: string[]; text: string; page?: number };

/** A line of speech from a transcript, timed in seconds. */
export type Cue = { start: number; end: number; text: string };

const HEADING_MD = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Markdown: headings (#…######) set the section; paragraphs and list items become blocks. Code fences are kept whole. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const stack: string[] = [];
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    const text = para.join("\n").trim();
    if (text) blocks.push({ headings: [...stack], text });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      para.push(line);
      continue;
    }
    if (fence) {
      para.push(line);
      continue;
    }
    const h = line.match(HEADING_MD);
    if (h) {
      flush();
      const level = h[1]!.length;
      stack.length = Math.min(stack.length, level - 1);
      while (stack.length < level - 1) stack.push("");
      stack.push(stripInline(h[2]!));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A new list item starts a new block so long lists split cleanly.
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line) && para.length && !/^\s*([-*+]|\d+[.)])\s+/.test(para[0]!)) flush();
    para.push(line);
  }
  flush();
  return blocks.map((b) => ({ ...b, headings: b.headings.filter(Boolean) }));
}

function stripInline(s: string) {
  return s.replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** DOCX via mammoth's HTML. */
export async function parseDocx(buf: Buffer): Promise<Block[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  return parseHtml(html);
}

/**
 * HTML (mammoth's DOCX output, Confluence's rendered pages): h1–h6 set the section; p, li, pre, blockquote and
 * table cells become blocks. Scripts, styles and comments are dropped.
 */
export function parseHtml(html: string): Block[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
  const blocks: Block[] = [];
  // Open headings by level, so an h2 after an h2 replaces it even when the page has no h1.
  const stack: { level: number; text: string }[] = [];
  const re = /<(h[1-6]|p|li|td|th|pre|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of clean.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    const inner = m[2]!.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "");
    const text =
      tag === "pre"
        ? decode(inner).trim()
        : decode(inner)
            .replace(/[ \t\u00a0]+/g, " ")
            .replace(/ *\n+ */g, "\n")
            .trim();
    if (!text) continue;
    if (tag[0] === "h" && tag !== "th") {
      const level = Number(tag[1]);
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: text.replace(/\n/g, " ") });
      continue;
    }
    blocks.push({ headings: stack.map((h) => h.text), text: tag === "li" ? `- ${text}` : text });
  }
  return blocks;
}

/** A short line that looks like a numbered heading ("5.2 Promo codes", "3. Checkout"). */
const NUMBERED_HEADING = /^(\d+(?:\.\d+){0,3})\.?\s+([A-Z][^.!?]{1,80})$/;

/**
 * PDF via pdf.js text: one block per paragraph, tagged with its page.
 * PDFs carry no heading structure, so numbered heading lines ("5.2 Promo codes") set the section.
 */
export async function parsePdf(buf: Uint8Array): Promise<{ blocks: Block[]; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const blocks: Block[] = [];
  let section: string[] = [];
  text.forEach((pageText, i) => {
    const page = i + 1;
    let para: string[] = [];
    const flush = () => {
      const t = para.join(" ").replace(/\s+/g, " ").trim();
      if (t) blocks.push({ headings: [...section], text: t, page });
      para = [];
    };
    for (const raw of pageText.split(/\n/)) {
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      const h = line.match(NUMBERED_HEADING);
      if (h) {
        flush();
        const depth = h[1]!.split(".").length;
        section = [...section.slice(0, depth - 1), `${h[1]} ${h[2]}`];
        continue;
      }
      para.push(line);
      // pdf.js often puts a whole paragraph per line; end the paragraph at a sentence end.
      if (/[.!?:]$/.test(line) && para.join(" ").length > 300) flush();
    }
    flush();
  });
  return { blocks, pages: totalPages };
}

/** "01:02:03.500", "02:03,5", "1:02" → seconds. */
export function toSeconds(ts: string): number {
  const parts = ts.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const CUE_TIME = /^((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

/** WebVTT or SRT captions → cues. Voice tags and styling are dropped; NOTE and STYLE blocks are skipped. */
export function parseCaptions(src: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of src.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const i = lines.findIndex((l) => CUE_TIME.test(l));
    if (i < 0) continue;
    const m = lines[i]!.match(CUE_TIME)!;
    const text = lines
      .slice(i + 1)
      .join(" ")
      .replace(/<v\s+([^>]+)>/g, "$1: ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start: toSeconds(m[1]!), end: toSeconds(m[2]!), text: decode(text) });
  }
  return cues;
}

const LINE_TS = /^\[?((?:\d+:)?\d{1,2}:\d{2})\]?\s*[-–:]?\s*(.*)$/;

/**
 * Plain-text transcript. Lines that start with a timestamp ("0:04 text", "[01:02] text") become timed cues
 * (each ends where the next starts). Without timestamps the text is returned as one untimed cue per paragraph.
 */
export function parseTextTranscript(src: string): Cue[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const timed = lines.map((l) => l.match(LINE_TS));
  if (timed.filter(Boolean).length >= Math.max(1, lines.length / 2)) {
    const cues: Cue[] = [];
    for (const m of timed) {
      if (!m) continue;
      const text = m[2]!.trim();
      if (!text) continue;
      cues.push({ start: toSeconds(m[1]!), end: toSeconds(m[1]!), text });
    }
    cues.forEach((c, i) => (c.end = cues[i + 1]?.start ?? c.start + 5));
    return cues;
  }
  return src
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ start: NaN, end: NaN, text }));
}

/** Any transcript file: captions if it has `-->` cue timings, else plain text. */
export function parseTranscript(src: string): Cue[] {
  return /-->/.test(src) ? parseCaptions(src) : parseTextTranscript(src);
}
