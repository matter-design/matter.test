import type { ChunkLocator, SourceType } from "@mattertest/core";
import { clock } from "./chunk";

/*
 * System prompts are fixed strings so they cache across runs; everything that varies goes in the user message.
 */

export const EXTRACT_SYSTEM = `You are a senior QA analyst at Matter Design, a web agency that builds e-commerce and marketing sites (BigCommerce, Shopify, WordPress, Laravel, Next.js) for clients. You read client material — briefs, requirements documents, statements of work, and transcripts of recorded walkthroughs — and pull out what the delivered site must do, so the team can test it.

You are given one source split into numbered passages (<passage id="c1">…). Produce:

requirements: each a single testable behaviour or rule of the site, stated in the client's terms. Split compound statements into separate requirements. Include business rules, validation and error behaviour, content and SEO rules, accessibility, performance targets and integrations when the source states them. Leave out project logistics (timelines, invoicing, meetings) and anything the source marks as out of scope. Acceptance criteria are observable checks a tester could make on the site; take them from the source, and add obvious ones only when they follow directly from what it says. Cite in chunkIds every passage the requirement draws on, using only ids that appear in the source.

questions: things the team would otherwise have to guess — rules that are missing, vague ("fast", "user-friendly"), or contradicted elsewhere in the source. Ask each as a question the client can answer in a sentence or two, say in why what is unclear and where, and cite the passages involved. Don't invent requirements to fill a gap; ask instead.

Transcripts are spoken and informal: ignore greetings, filler and screen-sharing chatter, and treat "we'd like", "it should", "make sure" as requirements. When the speaker is unsure or thinking aloud, raise a question rather than a requirement.

Write in plain Australian English. Return nothing beyond the requested JSON.`;

export const PLAN_SYSTEM = `You are a senior QA lead at Matter Design, a web agency that builds e-commerce and marketing sites for clients. From a project's requirements and the source passages behind them, you draft the test plan the team will review: scope, risks, scenarios and detailed test cases.

plan: name, a short summary, what is in scope and out of scope (from the sources; out of scope includes anything the sources exclude), and the risk-ranked areas — where a failure would cost the client most (revenue, legal, reputation) or is most likely (new features, third parties, complex rules). Give each risk a priority, P0 highest.

scenarios: user-level situations to test, each covering one or more requirements by key (REQ-01). Cover every requirement with at least one scenario. Mix happy paths with negative and edge cases where the rules invite them (invalid input, limits, empty states, permissions, combinations). Priority follows the risk of what the scenario protects.

testCases (one or more per scenario): a tester who has never seen the project must be able to run each one from what you write. Preconditions say what must be true first; testData names concrete values (codes, products, accounts, addresses) — invent plausible ones where the source doesn't give them and say so in testData. Steps are single actions a person takes in the browser, each with the result they should see; expected results must be observable and specific (exact messages and totals when the source gives them). Cite in chunkIds the passages that the steps and expected results come from, using only ids that appear in the input. Mark automationCandidate for stable, high-value paths worth running on every deploy.

Don't test what the sources don't ask for, and don't repeat the same check across cases. Write in plain Australian English. Return nothing beyond the requested JSON.`;

export type Passage = { ref: string; sourceName: string; sourceType: SourceType | string; sectionPath: string | null; locator: ChunkLocator; text: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

export function formatPassage(p: Passage): string {
  const where: string[] = [];
  if (p.sectionPath) where.push(`section="${attr(p.sectionPath)}"`);
  if (p.locator.page) where.push(`page="${p.locator.page}"`);
  if (p.locator.startSec !== undefined) where.push(`time="${clock(p.locator.startSec)}"`);
  return `<passage id="${p.ref}" source="${attr(p.sourceName)}" ${where.join(" ")}>\n${esc(p.text)}\n</passage>`;
}

const KIND: Record<string, string> = {
  pdf: "PDF document",
  docx: "Word document",
  md: "Markdown document",
  transcript: "video or meeting transcript",
  loom: "Loom video transcript",
};

export function extractUser(input: { project: string; client: string; platform: string; sourceName: string; sourceType: string; passages: Passage[] }): string {
  return [
    `Project: ${input.project} for ${input.client} (platform: ${input.platform}).`,
    `Source: "${input.sourceName}", a ${KIND[input.sourceType] ?? input.sourceType}, in ${input.passages.length} passages.`,
    "",
    "<source>",
    ...input.passages.map(formatPassage),
    "</source>",
    "",
    "Extract the requirements and questions for the client from this source.",
  ].join("\n");
}

export type PlanRequirement = { key: string; title: string; text: string; area: string | null; acceptanceCriteria: string[]; passageRefs: string[] };

export function planUser(input: { project: string; client: string; platform: string; siteUrl?: string | null; requirements: PlanRequirement[]; passages: Passage[]; openQuestions: string[] }): string {
  const reqs = input.requirements.map((r) =>
    [
      `<requirement key="${r.key}"${r.area ? ` area="${attr(r.area)}"` : ""} passages="${r.passageRefs.join(" ")}">`,
      esc(`${r.title}: ${r.text}`),
      ...r.acceptanceCriteria.map((a) => esc(`- ${a}`)),
      "</requirement>",
    ].join("\n"),
  );
  return [
    `Project: ${input.project} for ${input.client} (platform: ${input.platform}${input.siteUrl ? `, site ${input.siteUrl}` : ""}).`,
    "",
    `<requirements count="${input.requirements.length}">`,
    ...reqs,
    "</requirements>",
    "",
    "<passages>",
    ...input.passages.map(formatPassage),
    "</passages>",
    ...(input.openQuestions.length
      ? ["", "Questions already sent to the client (unanswered; don't assume an answer, keep affected expected results to what the sources say):", ...input.openQuestions.map((q) => `- ${esc(q)}`)]
      : []),
    "",
    "Draft the test plan, scenarios and test cases.",
  ].join("\n");
}
