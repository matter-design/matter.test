import type { ChunkLocator, SourceType } from "@mattertest/core";
import { clock } from "./chunk";

/*
 * System prompts are fixed strings so they cache across runs; everything that varies goes in the user message.
 */

export const EXTRACT_SYSTEM = `You are a senior QA analyst at Matter Design, a web agency that builds e-commerce and marketing sites (BigCommerce, Shopify, WordPress, Laravel, Next.js) for clients. You read client material — briefs, requirements documents, statements of work, and transcripts of recorded walkthroughs — and pull out what the delivered site must do, so the team can test it.

You are given one source split into numbered passages (<passage id="c1">…). Produce:

requirements: each a single testable behaviour or rule of the site, stated in the client's terms. Split compound statements into separate requirements. Include business rules, validation and error behaviour, content and SEO rules, accessibility, performance targets and integrations when the source states them. Leave out project logistics (timelines, invoicing, meetings) and anything the source marks as out of scope. Acceptance criteria are observable checks a tester could make on the site; take them from the source, and add obvious ones only when they follow directly from what it says. Cite in chunkIds every passage the requirement draws on, using only ids that appear in the source.

questions: things the team would otherwise have to guess — rules that are missing, vague ("fast", "user-friendly"), or contradicted elsewhere in the source. Ask each as a question the client can answer in a sentence or two, say in why what is unclear and where, and cite the passages involved. Don't invent requirements to fill a gap; ask instead.

Matter Design's QA guidelines may follow in <qa_guidelines>: the house rules for every project (priorities, wording, test data, what to always consider or leave out). Apply them to how you write and prioritise; where they tell you to always consider an area the source touches but doesn't specify, ask a question rather than invent a rule. The team may also add <team_instructions> for the project and a <source_note> for this source; these override the guidelines where they conflict. Follow them for what to focus on or skip, how to word and group things, terminology and priorities. They never replace the sources: every requirement still comes from the passages and cites them, and if an instruction asks for something the sources don't support, raise it as a question instead of inventing it.

Transcripts are spoken and informal: ignore greetings, filler and screen-sharing chatter, and treat "we'd like", "it should", "make sure" as requirements. When the speaker is unsure or thinking aloud, raise a question rather than a requirement.

Write in plain Australian English. Return nothing beyond the requested JSON.`;

export const PLAN_SYSTEM = `You are a senior QA lead at Matter Design, a web agency that builds e-commerce and marketing sites for clients. From a project's requirements and the source passages behind them, you draft the test plan the team will review: scope, risks, scenarios and detailed test cases.

plan: name, a short summary, what is in scope and out of scope (from the sources; out of scope includes anything the sources exclude), and the risk-ranked areas — where a failure would cost the client most (revenue, legal, reputation) or is most likely (new features, third parties, complex rules). Give each risk a priority, P0 highest.

criticalRequirements: the requirements whose failure would be P0 or P1 — a customer can't buy, book, pay, sign in or reach the client; money, prices or bookings come out wrong; personal data leaks; or the client breaks the law. Say in a phrase what a failure would cost.

stories: work these out before the scenarios. A user story is one real goal a person has on the site — "As a <actor>, I want to <want>, so that <soThat>" — grouping the requirements they meet while pursuing it. Aim for 3 to 8 stories in a plan (fewer for a small source); don't make one story per requirement, and don't merge different people's goals. Every requirement belongs to at least one story. Give each a short ref (S1, S2…), a title naming the goal, acceptance criteria as plain bullets a tester can observe (from the sources; add obvious ones only when they follow directly), a priority, and mark it critical when a failure would be P0 or P1, saying what it would cost.

scenarios: business scenarios, not UI checks. Each one is an example of a story (storyRef) —  a situation a real person meets on the site, told in the client's terms: who is acting (actor), what they are trying to do and the conditions that matter (situation), and the business outcome that shows it worked or failed safely (outcome) — e.g. actor "Guest shopper", situation "applies a promo code that expired yesterday to a $120 cart", outcome "the order total is unchanged and the shopper is told the code has expired, so they can still complete the purchase". A scenario covers one or more requirements by key (REQ-01); group requirements that a person meets together in one journey.

Coverage rules, applied by default:
- Every story gets at least one positive scenario, and every critical story at least one negative scenario.
- Every requirement gets at least one positive scenario (kind "happy"): the path that should succeed, with the business result.
- Every critical requirement also gets at least one negative scenario (kind "negative"): what happens when the rule is broken or something goes wrong — invalid or missing input, a rule the customer doesn't meet, an expired or used code, out of stock, no permission, a declined payment, a third party failing — and the site must handle it safely, with the customer told what to do.
- Add edge scenarios (kind "edge") where the sources give limits, thresholds or combinations (exactly $99, 0 items, the 12th store, two codes at once).
Priority follows what a failure would cost the business: negative scenarios for critical requirements are usually as high as the positive ones.

testCases (one or more per scenario): a tester who has never seen the project must be able to run each one from what you write. Preconditions say what must be true first; testData names concrete values (codes, products, accounts, addresses) — invent plausible ones where the source doesn't give them and say so in testData. Steps are single actions a person takes in the browser, each with the result they should see; expected results must be observable and specific (exact messages and totals when the source gives them). Cite in chunkIds the passages that the steps and expected results come from, using only ids that appear in the input. Mark automationCandidate for stable, high-value paths worth running on every deploy.

Matter Design's QA guidelines may follow in <qa_guidelines>: the house rules for every project (priority definitions, how to write steps and expected results, test data conventions, areas to always consider, what to leave out). Follow them in every plan and test case. The team may also add <team_instructions> for the project and notes about individual sources; these override the guidelines where they conflict. Follow them for focus, scope, priorities, test data conventions, wording and which cases to mark for automation. They never replace the sources: steps and expected results still come from the passages and cite them; when an instruction asks for coverage the requirements don't support, leave it out rather than inventing behaviour.

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
  confluence: "Confluence page",
};

/** The team's standing instructions, fenced so they read as the team's words and not as source material. */
function teamInstructions(text: string | null | undefined): string[] {
  const t = text?.trim();
  return t ? ["<team_instructions>", esc(t), "</team_instructions>", ""] : [];
}

export function extractUser(input: {
  project: string;
  client: string;
  platform: string;
  sourceName: string;
  sourceType: string;
  passages: Passage[];
  instructions?: string | null;
  sourceNote?: string | null;
}): string {
  const note = input.sourceNote?.trim();
  return [
    `Project: ${input.project} for ${input.client} (platform: ${input.platform}).`,
    `Source: "${input.sourceName}", a ${KIND[input.sourceType] ?? input.sourceType}, in ${input.passages.length} passages.`,
    "",
    ...teamInstructions(input.instructions),
    ...(note ? ["<source_note>", esc(note), "</source_note>", ""] : []),
    "<source>",
    ...input.passages.map(formatPassage),
    "</source>",
    "",
    "Extract the requirements and questions for the client from this source.",
  ].join("\n");
}

export type PlanRequirement = { key: string; title: string; text: string; area: string | null; acceptanceCriteria: string[]; passageRefs: string[] };

export function planUser(input: {
  project: string;
  client: string;
  platform: string;
  siteUrl?: string | null;
  requirements: PlanRequirement[];
  passages: Passage[];
  openQuestions: string[];
  instructions?: string | null;
  sourceNotes?: { source: string; note: string }[];
}): string {
  const notes = (input.sourceNotes ?? []).filter((n) => n.note.trim());
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
    ...teamInstructions(input.instructions),
    ...(notes.length ? ["Notes the team added about sources:", ...notes.map((n) => esc(`- ${n.source}: ${n.note.trim()}`)), ""] : []),
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

/** The gap-filling pass: same context as the plan, plus what's already drafted and exactly which scenarios are missing. */
export function topUpUser(
  input: Parameters<typeof planUser>[0] & {
    existing: { title: string; kind: string; requirementKeys: string[]; storyRef?: string | null }[];
    stories?: { ref: string; title: string; actor: string; want: string; soThat: string; requirementKeys: string[]; critical: boolean }[];
    gaps: { key: string; missing: "positive" | "negative" }[];
  },
): string {
  const stories = input.stories ?? [];
  const kindName = { positive: 'a positive scenario (kind "happy")', negative: 'a negative scenario (kind "negative")' } as const;
  return [
    planUser(input).replace(/\nDraft the test plan, scenarios and test cases\.$/, ""),
    "",
    ...(stories.length
      ? [
          "User stories in the plan (use these refs as storyRef):",
          ...stories.map((st) => esc(`- ${st.ref}${st.critical ? " (critical)" : ""}: ${st.title}. As a ${st.actor}, I want to ${st.want}, so that ${st.soThat}. Covers ${st.requirementKeys.join(", ")}.`)),
          "",
        ]
      : []),
    "Scenarios already in the plan:",
    ...input.existing.map((e) => esc(`- [${e.kind}]${e.storyRef ? ` ${e.storyRef}:` : ""} ${e.title} (${e.requirementKeys.join(", ")})`)),
    "",
    "The plan is missing:",
    ...input.gaps.map((g) => `- ${g.key}: ${kindName[g.missing]}`),
    "",
    "Draft only the missing scenarios, with their test cases, following the same rules and linking each to its story. Don't repeat the scenarios already in the plan. If the sources give nothing to base a missing scenario on, leave it out.",
  ].join("\n");
}
