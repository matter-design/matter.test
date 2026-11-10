# MatterTest

Internal agentic test management tool for Matter Design. It turns client docs into test assets, runs website checks on any storefront, keeps sanity suites green with self-healing locators, and logs every run against the project it belongs to.

Architecture and roadmap: see the *Agentic Test Management Tool — Architecture & Spec* doc. UI direction: the *MatterTest UI Prototype* canvas.

## What works today (Phase 1 + start of Phase 2)

| Area | Status |
| --- | --- |
| Monorepo, TypeScript, pnpm + Turborepo | Done |
| Postgres schema (all spec entities) + pgvector, migrations, seed | Done |
| Job queue (BullMQ on Redis), site-check worker | Done |
| Crawl: robots.txt, sitemap seeding, JS-rendered links, template grouping | Done |
| Link health: 4xx/5xx, broken images, redirect chains and loops | Done |
| SEO: title, description, canonical, noindex, H1, OG, JSON-LD validity, duplicate titles | Done |
| Security hygiene (passive): HTTPS, HSTS, CSP, nosniff, framing, cookie flags, exposed files | Done |
| Accessibility: axe-core at WCAG 2.2 AA, sampled per template | Done |
| Platform detection: BigCommerce, Shopify, WordPress, Laravel, Next.js | Done |
| Performance: Lighthouse per template (PSI mobile/desktop profiles), score, LCP/CLS/TBT/FCP/TTFB, insights, weight budgets, scripted lab interaction (INP stand-in), in-browser fallback | Done |
| BigCommerce pack: Stencil page-type templates, `[Sample]` catalogue, store-domain canonicals/links, maintenance mode, unbuyable or $0.00 PDPs, missing Product schema, indexable facet/cart URLs, robots.txt | Done |
| Findings deduped across runs by fingerprint; reopened if they come back | Done |
| Web app (UI pass 1, from the prototype): projects with search/filters and health, "Set up a project" dialog (staging URL, Jira/Slack, live platform detection, optional first check), project dashboard (health by category, fix-first list, runs), site check results (category filter, speed by page type, browser × device grid), finding detail with triage | Done |
| Health score: 0–100 per category and overall from the latest check's open findings, each issue type costing points by severity (more if widespread), performance from the median Lighthouse score; see `apps/web/src/lib/health.ts` | Done |
| Sign-in: Google, limited to the company Workspace domain; every page, action, report and screenshot protected; who started checks and approved baselines is recorded | Done |
| Client PDF report: summary, "fix these first", speed per page type, accessibility by WCAG criterion, platform/SEO/links/security, appendix; plain-English why/fix per issue; client branding | Done |
| Visual + cross-browser: Chromium, Firefox and WebKit at phone/tablet/desktop; screenshot diffs against approved baselines; sideways scroll, browser-specific JS errors and images, missing viewport tag; approve changes in the web app; grid and before/after in the report | Done |
| Shopify pack: templates from markup, password page, myshopify.com canonicals/links, theme placeholder text, unbuyable or $0 products, missing Product schema, duplicate collection product URLs, indexable filter/cart URLs, robots.txt defaults, app script load | Done |
| WordPress pack (+ WooCommerce products): templates from body classes, search engines discouraged, sample content and tagline, staging-host canonicals/links, PHP errors on pages, robots.txt blocking theme files, plugin load, version disclosure; probes REST user list, XML-RPC, debug.log, uploads listing, readme.html | Done |
| Laravel / Next.js packs | Next |
| Client docs → requirements → test plan, scenarios and test cases (Claude), with a Review inbox; see **Test assets** below | Done |
| Self-healing sanity runner | Phase 4 |

## Run it locally

Needs Node 22.19+ (Lighthouse 13), pnpm 10, Docker, and Playwright's browsers (`pnpm --filter @mattertest/checks exec playwright install chromium firefox webkit`).

```bash
cp .env.example .env
pnpm install
pnpm infra:up          # Postgres (with pgvector) + Redis
pnpm db:migrate
pnpm db:seed           # one sample project pointing at https://example.com
pnpm worker            # terminal 1: site-check worker
pnpm web               # terminal 2: http://localhost:3000
```

Sign in with your company Google account (see **Sign-in** below), add a project with **New project** (client, project name, site address), and press **Start check**.

### Sign-in

The web app only admits Google accounts in the company Workspace (`AUTH_ALLOWED_DOMAIN`, default `matterdesign.com.au`): the email must be verified and the account must belong to the Workspace, so a personal Gmail registered with a company address is refused. Sessions are a signed cookie valid for 12 hours.

1. In Google Cloud Console, create an OAuth client of type *Web application* with redirect URI `http://localhost:3000/auth/google/callback` (and the production URL later).
2. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a random `AUTH_SECRET` (`openssl rand -base64 48`) in `apps/web/.env.local`, with `APP_URL` set to the app's address.

For local work without Google, `AUTH_DISABLED=1` in `apps/web/.env.local` skips sign-in. It is ignored in production.

Every page goes through the proxy (`src/proxy.ts`); server actions, the report download and the screenshot route also check the session themselves.

### Quick check from the terminal (no DB, no Redis)

```bash
pnpm check https://shop.example.com --max 50
pnpm check https://shop.example.com --only seo,links,security
pnpm check https://shop.example.com --only performance,platform --no-throttle
```

Performance runs **Lighthouse** (pinned 13.5.0) on one sample page per template, configured like PageSpeed Insights: `mobile` by default, `--desktop` for the desktop profile, `--no-throttle` for fast local runs. It reports the performance score, LCP (with the LCP element), CLS, TBT, FCP, server response time, page/JS/image weight and the failing Lighthouse insights. Lighthouse uses Playwright's Chromium (override with `LIGHTHOUSE_CHROME_PATH`). If it can't start or fails on a page, that page is measured in the browser instead (`--no-lighthouse` forces this).

INP needs real users, so each sampled page also gets one **scripted lab interaction**: a menu toggle, accordion, gallery thumbnail or variant swatch, timed with the Event Timing API against INP thresholds. It never clicks add-to-cart or anything in a POST form, and every non-GET request and page navigation after load is aborted, so it can't change the store's state. Findings call it a lab interaction, not INP.

All of these are lab numbers from a single load. They are a regression signal, not the field data (CrUX) Google grades against. Metrics are stored per URL in `check_results` (category `performance`) so they can be trended across runs.

### Visual and cross-browser checks

One page per template is opened in Chromium, Firefox and WebKit (Safari's engine) at phone (390), tablet (820) and desktop (1440) widths. Each capture is:

- **Compared with its approved baseline.** The first run stores baselines; later runs flag pages where more than 0.2% of pixels changed or the height moved. Animations are disabled, lazy images are loaded first, and carousels, iframes, videos and chat widgets are masked so they don't cause false changes. Add `data-mt-mask` to anything else that changes on every load.
- **Checked for problems that need no baseline:** sideways scrolling (with the widest element), JS errors (flagged high when only some browsers hit them), images that load in some browsers but not others, and a missing viewport tag.

In the web app, a visual change shows approved / now / diff thumbnails and an **Approve change** button, which makes the new screenshot the baseline (older baselines are kept as history). From the CLI, `--update-baselines` accepts everything; `--browsers` and `--viewports` narrow the matrix:

```bash
pnpm check https://shop.example.com --only crawl,visual --browsers chromium,webkit --viewports mobile,desktop
```

Screenshots live under `artefacts/visual/` (or `ARTEFACT_DIR`), which the CLI, worker and web app share.

### Client report

`packages/report` turns a site-check result into an A4 PDF for the client, printed with Playwright's Chromium:

- Cover, summary (counts by severity and area, headline), then "Fix these first": the critical and high issues, each with why it matters and what to do.
- Speed by page type (Lighthouse score, LCP, CLS, TBT, tap response) with Google's colour bands and the biggest Lighthouse opportunities.
- Accessibility grouped by WCAG 2.2 criterion.
- Browsers and devices: a page-type × browser × device grid, and before/after crops of the biggest visual changes.
- Platform, SEO, links, failed pages and security.
- An appendix listing every affected URL per issue.

Repeated issues are grouped by rule, so 200 pages missing OG tags is one line, not 200. Wording lives in `src/copy.ts`; add an entry there when a new rule should read better for clients. Client branding (`clients.branding`: `primary`, `accent` hex colours and an https `logoUrl`) is applied; anything else is ignored.

In the web app, the latest finished site check on a project has a **Client PDF** link (`/runs/<id>/report`). Older runs are refused because findings only remember the last run they were seen in. Ignored and accepted-risk findings are left out. `pnpm --filter @mattertest/report sample` renders a sample report for design review.

Platform packs live in `packages/checks/src/packs/` and run when the detected platform has one (category `platform`, rules prefixed `bc.`, `shopify.` and `wp.`). A pack may also `probe` a short fixed list of well-known public paths with GET (the WordPress pack checks the REST user list, XML-RPC, debug.log, uploads listing and readme.html; usernames are counted, never stored). Shared helpers (product schema, temporary-domain canonicals, robots.txt rules) are in `packs/util.ts`. A pack can also name page templates from markup, which beats URL guessing on flat BigCommerce URLs.

Writes a JSON result to `./artefacts/`. Add `--pdf --client "Northwind Outdoor" --project "Store launch"` for the client PDF next to it, or render one later from a saved result:

```bash
pnpm report ./artefacts/shop.example.com-2026-11-06T03-00-00-000Z.json --client "Northwind Outdoor" --project "Store launch"
```

To show a terminal check in the web app without checking the site again, load it into the database. The client, project and environment are created if they don't exist yet:

```bash
pnpm import-run ./artefacts/shop.example.com-2026-11-06T03-00-00-000Z.json --client "Northwind Outdoor" --project "Store launch"
```

## Test assets (client docs → test cases)

Each project has **Test assets** and a **Review inbox** in the sidebar.

1. **Add a source** on Test assets: a PDF, Word (.docx) or Markdown brief or requirements document, a transcript file (.vtt, .srt, .txt), a **Loom share link**, or a **Confluence page link**. Files are stored under `artefacts/sources/<project>/`; uploading the same file twice is refused, and a changed file with the same name becomes version 2 (the old version's requirements drop out of planning).
2. The worker's `ingest` job reads it, splits it into passages (by heading for documents, about 2-minute windows for videos), embeds each passage, and asks Claude for the **requirements** (each citing the passages it came from) and **questions for the client** where the source is vague or contradicts itself.
3. A `plan` job then drafts a **test plan** (scope, out of scope, risk-ranked areas), **scenarios** and **test cases** with steps and expected results, again citing passages. Citations are checked against what Claude was shown; anything that can't be traced is dropped. Each new draft supersedes the previous draft; approved test cases stay approved.
4. In the **Review inbox**, approve, reject or edit (title, preconditions, test data, steps) each test case, requirement and the plan. **Traced to source** quotes the passage and links to it in the source view (or to that moment in the Loom video). Rejecting requirements and pressing **Draft the plan again** re-plans without them.

**User stories.** The plan works out user stories before scenarios: each is one real goal ("As a customer, I want to book a fitting at my store, so that the store expects me") grouping the requirements a person meets pursuing it, usually 3 to 8 per plan, with acceptance criteria as plain bullets and a priority. Scenarios are examples of a story, so the trace runs passage → requirement → story → scenario → test case. Test cases (TC-001), scenarios (SC-001) and stories (US-01) are numbered across the project and listed story by story; numbers continue after anything someone has reviewed (approved, rejected or edited), so a reviewed number is never reused, while unreviewed drafts that a new draft replaces free their numbers. Stories are reviewed in the Review inbox like everything else, and show on the **User stories** tab with their scenarios.

**Business scenarios and coverage.** Scenarios are written as business situations: who is acting, what they're trying to do, and the outcome the business needs. The plan marks its critical requirements (a failure would be P0 or P1: lost sales or bookings, wrong money, data, legal) and, by default, every story and requirement gets a positive scenario and every critical one a negative one too, with edge scenarios where the sources give limits. After drafting, the worker checks that coverage; anything missing gets one smaller follow-up call that drafts only those scenarios, and whatever is still missing is listed on the plan. The **Coverage** tab shows positive, negative and edge scenarios per requirement and flags the gaps.

**QA guidelines.** [`docs/qa-guidelines.md`](docs/qa-guidelines.md) holds Matter Design's house rules for every project: priority definitions, how to write steps and expected results, test data conventions, what to always consider and what to leave out. Claude gets it with every extraction and plan, after its built-in instructions (`packages/agent/src/prompts.ts`). Edit it like any doc and commit; the worker reads it fresh on each job, so no restart is needed. Each run records the guide's version (`guidelinesVersion` in the run summary). Set `QA_GUIDELINES_PATH` to use a different file.

**Instructions for the agent.** At the top of Test assets, the team can tell Claude how to read this project's sources and plan its tests: what to focus on or skip, priorities, terms, test data conventions. Each add form also takes an optional **note for the agent** about that one source ("v1 brief, only section 4 still applies"); a new version of a file keeps the last note unless a new one is given. Both go to Claude on every read and plan, and are kept on the run's summary. They steer, they don't add facts: everything still has to come from the sources and cite them. Changes apply from the next read or plan; use **Draft the plan again**, or **Read again** on a source (which replaces that source's requirements, so approvals on them are lost).

**Confluence.** Paste a page link (any of the usual shapes, including `/wiki/x/…` short links). Tick **Include child pages** to read the pages under it too, through folders, up to 50; each page becomes its own source, so an edit to one page only re-reads that page. The worker reads pages with one Atlassian account (`CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` in `.env`, falling back to the `JIRA_*` values), so that account needs access to the space. **Check Confluence for updates** compares each page's Confluence version: unchanged pages are skipped, a changed page becomes a new version (its old requirements drop out of planning), new child pages are added, and one new plan is drafted. Nothing re-reads on its own, so Claude only runs when someone asks.

**Loom.** Loom has no official transcript API. For videos shared with "anyone with the link", the worker reads the transcript the share page uses (an undocumented Loom endpoint that may change). For workspace-only videos, or if that fails, the source shows **Needs a transcript**: download it in Loom (⋯ › Download › Transcript) and attach it there.

**Model and cost.** Extraction and planning use `claude-opus-5-5` (override with `AGENT_MODEL`) with structured output, adaptive thinking at high effort, and server-side refusal fallbacks. Tokens and cost are stored on each run; the sidebar shows this month's agent spend against `AGENT_MONTHLY_BUDGET_USD` (default 150). Set `ANTHROPIC_API_KEY` in `.env`; without it, sources stop at "Claude isn't set up on the worker".

**Embeddings** run locally (`EMBEDDINGS=local`, the default) with `mixedbread-ai/mxbai-embed-large-v1` (1024 dimensions) through transformers.js: no key, and nothing leaves the machine for this step. The model (~340 MB) downloads to `.cache/models` on first use; `pnpm --filter @mattertest/agent fetch-model` does it up front. `EMBEDDINGS=off` stores passages without vectors (extraction still works; Claude reads the whole source).

Scanned PDFs (images of text) aren't read yet, and sources other than files, Loom and Confluence (Jira epics, Figma) come later.

## Layout

```
apps/
  web/        Next.js app (App Router, server actions)
  worker/     BullMQ worker + CLI; persists results
packages/
  core/       shared enums, Zod schemas, finding fingerprint
  db/         Drizzle schema, migrations, seed
  checks/     deterministic check engine (Playwright, axe-core, cheerio, Lighthouse)
    src/packs/  platform packs (BigCommerce, Shopify, WordPress)
  report/     client PDF report (HTML template printed with Chromium)
  agent/      doc ingestion: parsing (PDF, DOCX, Markdown, transcripts, Loom, Confluence), chunking, local embeddings,
              Claude extraction/planning prompts and schemas, citation checks
```

Internal packages are source-only TypeScript (no build step): the worker runs on `tsx`, the web app transpiles them.

## Tests

```bash
pnpm test        # unit tests + an end-to-end crawl of a local fixture store
pnpm typecheck
```

The worker's persistence test runs only when `DATABASE_URL` points at a migrated database.

## Guardrails built in

- Crawls respect robots.txt by default and stay on the client's host.
- Security checks are passive: they read headers and cookies, and request a fixed short list of commonly exposed files. No payloads. Platform-pack probes follow the same rule: GET only, fixed paths.
- Site credentials are referenced from a secret store, never stored in Postgres.
- Environments default to no side effects (no orders, no form submissions).
