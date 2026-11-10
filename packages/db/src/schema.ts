import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import {
  type ChunkLocator,
  CHECK_CATEGORIES,
  FINDING_STATES,
  PLATFORMS,
  SEVERITIES,
  TASK_KINDS,
  TASK_STATUSES,
  TASK_TRIGGERS,
} from "@mattertest/core";

export const platformEnum = pgEnum("platform", PLATFORMS);
export const categoryEnum = pgEnum("check_category", CHECK_CATEGORIES);
export const severityEnum = pgEnum("severity", SEVERITIES);
export const taskKindEnum = pgEnum("task_kind", TASK_KINDS);
export const taskTriggerEnum = pgEnum("task_trigger", TASK_TRIGGERS);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const findingStateEnum = pgEnum("finding_state", FINDING_STATES);

const id = () => uuid("id").primaryKey().defaultRandom();
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const clients = pgTable("clients", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  branding: jsonb("branding").$type<{ logoUrl?: string; primary?: string; accent?: string }>(),
  createdAt: created(),
});

export const projects = pgTable("projects", {
  id: id(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  name: text("name").notNull(),
  platform: platformEnum("platform").notNull().default("custom"),
  jiraKey: text("jira_key"),
  slackChannel: text("slack_channel"),
  /** Most pages a site check crawls. Set per project. */
  crawlMaxPages: integer("crawl_max_pages").notNull().default(200),
  /** The team's standing instructions to the agent when it reads sources and drafts plans (focus, scope, priorities). */
  agentInstructions: text("agent_instructions"),
  status: text("status").notNull().default("onboarding"),
  createdAt: created(),
});

/** Secrets live in a vault; we only keep a reference. */
export const authProfiles = pgTable("auth_profiles", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(), // none | basic | storage-state | storefront-password | test-account
  secretRef: text("secret_ref"),
  createdAt: created(),
});

export const environments = pgTable("environments", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(), // production | staging | uat
  baseUrl: text("base_url").notNull(),
  authProfileId: uuid("auth_profile_id").references(() => authProfiles.id),
  /** When false, sanity runs stop before side effects (orders, form submits). */
  allowSideEffects: boolean("allow_side_effects").notNull().default(false),
  createdAt: created(),
});

/** A Confluence page source: which page and version was read, and the page it was added through. */
export type ConfluenceSourceMeta = {
  pageId: string;
  version: number;
  webUrl: string;
  /** The page the team added; equal to pageId unless this page was read as a child page. */
  rootPageId: string;
  /** On the added page only: whether its child pages are read too. */
  includeChildren?: boolean;
};

export type SourceMeta = {
  pages?: number;
  durationSec?: number;
  chunks?: number;
  title?: string;
  owner?: string;
  transcriptFrom?: "loom" | "upload";
  confluence?: ConfluenceSourceMeta;
  /** What the team told the agent about this source when adding it ("old v1 brief, only section 4 still applies"). */
  note?: string;
};

export const sources = pgTable(
  "sources",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    type: text("type").notNull(), // SOURCE_TYPES: pdf | docx | md | transcript | loom | confluence (later: jira-epic | figma | url)
    name: text("name").notNull(),
    /** The original link (Loom share URL, Confluence page URL); null for uploads. */
    uri: text("uri"),
    /** Stored file under the artefact folder: the upload, a transcript attached to a Loom source, or a Confluence page's HTML as read. */
    fileUri: text("file_uri"),
    contentHash: text("content_hash").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("queued"), // SOURCE_STATUSES
    error: text("error"),
    /** Facts shown in the Sources list: pages, duration, chunk count, Loom title and owner, Confluence page and version. */
    meta: jsonb("meta").$type<SourceMeta>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: created(),
  },
  (t) => [index("sources_project_idx").on(t.projectId)],
);

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    /** Order within the source, from 0. */
    position: integer("position").notNull().default(0),
    sectionPath: text("section_path"),
    locator: jsonb("locator").$type<ChunkLocator>().notNull().default({}),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
  },
  (t) => [
    index("source_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("source_chunks_source_idx").on(t.sourceId, t.position),
  ],
);

const reviewed = () => ({
  reviewState: text("review_state").notNull().default("needs-review"), // REVIEW_STATES
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const requirements = pgTable(
  "requirements",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // REQ-01
    title: text("title").notNull().default(""),
    text: text("text").notNull(),
    area: text("area"),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    sourceChunkIds: jsonb("source_chunk_ids").$type<string[]>().notNull().default([]),
    ...reviewed(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("requirements_project_key_idx").on(t.projectId, t.key)],
);

export type PlanRisk = { area: string; risk: "high" | "medium" | "low"; why: string; priority: "P0" | "P1" | "P2" | "P3" };

/** A requirement the plan treats as critical (it must get a negative scenario as well as a positive one), and why. */
export type CriticalRequirement = { key: string; why: string };
/** A scenario the plan should have but doesn't, after the gap-filling pass. */
/** Key is a requirement (REQ-01) or a user story (US-01). */
export type CoverageGap = { key: string; missing: "positive" | "negative" };

export type PlanBody = { summary?: string; scope: string[]; outOfScope: string[]; risks: PlanRisk[]; critical?: CriticalRequirement[]; gaps?: CoverageGap[] };

export const testPlans = pgTable("test_plans", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  /** The plan task that drafted it (its run holds tokens and cost). */
  taskId: uuid("task_id").references(() => tasks.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"), // draft | approved | rejected | superseded
  body: jsonb("body").$type<PlanBody>(),
  sourceIds: jsonb("source_ids").$type<string[]>().notNull().default([]),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: created(),
});

/**
 * A user story in a plan: who wants what and why, grouping the requirements a person meets together.
 * Business scenarios are examples of a story (positive, negative, edge).
 */
export const userStories = pgTable("user_stories", {
  id: id(),
  planId: uuid("plan_id").notNull().references(() => testPlans.id, { onDelete: "cascade" }),
  key: text("key").notNull(), // US-01, numbered across the project's plan versions
  title: text("title").notNull(),
  /** "As a …" */
  actor: text("actor").notNull(),
  /** "I want to …" */
  want: text("want").notNull(),
  /** "so that …" */
  soThat: text("so_that").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
  /** Requirement keys (REQ-01) the story covers. */
  requirementIds: jsonb("requirement_ids").$type<string[]>().notNull().default([]),
  priority: text("priority").notNull(), // P0..P3
  critical: boolean("critical").notNull().default(false),
  /** What a failure would cost, for critical stories. */
  criticalWhy: text("critical_why"),
  position: integer("position").notNull().default(0),
  ...reviewed(),
});

export const scenarios = pgTable("scenarios", {
  id: id(),
  planId: uuid("plan_id").notNull().references(() => testPlans.id, { onDelete: "cascade" }),
  /** SC-007, numbered across the project like test cases; null on plans drafted before scenario ids. */
  key: text("key"),
  title: text("title").notNull(),
  priority: text("priority").notNull(), // P0..P3
  kind: text("kind").notNull(), // happy (positive) | negative | edge
  /** Who the scenario is about: "Guest shopper", "Store manager". */
  actor: text("actor"),
  /** The business situation, in the client's terms: what the actor is trying to do and under what conditions. */
  situation: text("situation"),
  /** The business outcome that shows it worked (or failed safely). */
  outcome: text("outcome"),
  /** The user story this scenario is an example of. */
  storyId: uuid("story_id").references(() => userStories.id, { onDelete: "set null" }),
  /** Requirement keys (REQ-01) this scenario covers. */
  requirementIds: jsonb("requirement_ids").$type<string[]>().notNull().default([]),
  position: integer("position").notNull().default(0),
});

export const testCases = pgTable("test_cases", {
  id: id(),
  scenarioId: uuid("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  key: text("key").notNull(), // TC-014
  title: text("title").notNull(),
  preconditions: text("preconditions").notNull().default(""),
  testData: text("test_data").notNull().default(""),
  steps: jsonb("steps").$type<{ action: string; expected: string }[]>().notNull(),
  type: text("type").notNull().default("manual"), // manual | automated
  automationCandidate: boolean("automation_candidate").notNull().default(false),
  specPath: text("spec_path"),
  /** Passages the case was drafted from (besides its scenario's requirements). */
  sourceChunkIds: jsonb("source_chunk_ids").$type<string[]>().notNull().default([]),
  /** True once a person changed the agent's draft. */
  edited: boolean("edited").notNull().default(false),
  ...reviewed(),
  createdAt: created(),
});

/** Gaps and contradictions the agent found in the client's material, instead of guessing. */
export const clientQuestions = pgTable("client_questions", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  why: text("why").notNull().default(""),
  sourceChunkIds: jsonb("source_chunk_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("open"), // open | answered | dismissed
  answer: text("answer"),
  createdAt: created(),
});

export const locatorMaps = pgTable("locator_maps", {
  id: id(),
  testCaseId: uuid("test_case_id").notNull().references(() => testCases.id, { onDelete: "cascade" }),
  stepNo: integer("step_no").notNull(),
  strategies: jsonb("strategies").$type<{ kind: string; value: string }[]>().notNull(),
  fingerprint: jsonb("fingerprint").$type<Record<string, unknown>>().notNull(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    kind: taskKindEnum("kind").notNull(),
    trigger: taskTriggerEnum("trigger").notNull().default("manual"),
    status: taskStatusEnum("status").notNull().default("queued"),
    title: text("title").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    assignee: text("assignee"),
    parentTaskId: uuid("parent_task_id"),
    createdAt: created(),
  },
  (t) => [index("tasks_project_status_idx").on(t.projectId, t.status)],
);

export const runs = pgTable("runs", {
  id: id(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  environmentId: uuid("environment_id").references(() => environments.id),
  status: taskStatusEnum("status").notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  agentTraceRef: text("agent_trace_ref"),
  createdAt: created(),
});

export const pages = pgTable(
  "pages",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    status: integer("status"),
    template: text("template"),
    depth: integer("depth").notNull().default(0),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("pages_run_url_idx").on(t.runId, t.url)],
);

export const checkResults = pgTable("check_results", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  category: categoryEnum("category").notNull(),
  url: text("url").notNull(),
  metric: text("metric").notNull(),
  value: jsonb("value"),
  pass: boolean("pass"),
});

export const findings = pgTable(
  "findings",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    firstRunId: uuid("first_run_id").notNull().references(() => runs.id),
    lastRunId: uuid("last_run_id").notNull().references(() => runs.id),
    category: categoryEnum("category").notNull(),
    rule: text("rule").notNull(),
    severity: severityEnum("severity").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    detail: text("detail"),
    wcag: text("wcag"),
    selector: text("selector"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint").notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    state: findingStateEnum("state").notNull().default("new"),
    jiraIssueKey: text("jira_issue_key"),
    createdAt: created(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("findings_project_fp_idx").on(t.projectId, t.fingerprint)],
);

export const healEvents = pgTable("heal_events", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  testCaseId: uuid("test_case_id").notNull().references(() => testCases.id),
  stepNo: integer("step_no").notNull(),
  oldLocator: text("old_locator").notNull(),
  newLocator: text("new_locator").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  assertionHeld: boolean("assertion_held").notNull(),
  reasoning: text("reasoning"),
  decision: text("decision").notNull().default("pending"), // auto | pending | approved | rejected
  prUrl: text("pr_url"),
  createdAt: created(),
});

export const artefacts = pgTable("artefacts", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // screenshot | trace | har | video | report
  uri: text("uri").notNull(),
  createdAt: created(),
});

export const baselines = pgTable("baselines", {
  id: id(),
  environmentId: uuid("environment_id").notNull().references(() => environments.id),
  url: text("url").notNull(),
  viewport: text("viewport").notNull(),
  browser: text("browser").notNull(),
  imageUri: text("image_uri").notNull(),
  approvedBy: text("approved_by"),
  createdAt: created(),
});
