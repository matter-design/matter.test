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

export const sources = pgTable("sources", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(), // pdf | docx | md | confluence | jira-epic | figma | url
  name: text("name").notNull(),
  uri: text("uri"),
  contentHash: text("content_hash").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: created(),
});

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    sectionPath: text("section_path"),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
  },
  (t) => [index("source_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))],
);

export const requirements = pgTable("requirements", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  key: text("key").notNull(), // REQ-01
  text: text("text").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
  sourceChunkIds: jsonb("source_chunk_ids").$type<string[]>().notNull().default([]),
  createdAt: created(),
});

export const testPlans = pgTable("test_plans", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"), // draft | approved
  body: jsonb("body").$type<{ scope: string[]; outOfScope: string[]; risks: unknown[] }>(),
  createdAt: created(),
});

export const scenarios = pgTable("scenarios", {
  id: id(),
  planId: uuid("plan_id").notNull().references(() => testPlans.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  priority: text("priority").notNull(), // P0..P3
  kind: text("kind").notNull(), // happy | negative | edge
  requirementIds: jsonb("requirement_ids").$type<string[]>().notNull().default([]),
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
  specPath: text("spec_path"),
  reviewState: text("review_state").notNull().default("needs-review"),
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
