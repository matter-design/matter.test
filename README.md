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
| Web app: project list, project page, start a check, runs, open findings | Done (basic) |
| Client PDF report: summary, "fix these first", speed per page type, accessibility by WCAG criterion, platform/SEO/links/security, appendix; plain-English why/fix per issue; client branding | Done |
| Visual + cross-browser: Chromium, Firefox and WebKit at phone/tablet/desktop; screenshot diffs against approved baselines; sideways scroll, browser-specific JS errors and images, missing viewport tag; approve changes in the web app; grid and before/after in the report | Done |
| Shopify pack: templates from markup, password page, myshopify.com canonicals/links, theme placeholder text, unbuyable or $0 products, missing Product schema, duplicate collection product URLs, indexable filter/cart URLs, robots.txt defaults, app script load | Done |
| WordPress pack (+ WooCommerce products): templates from body classes, search engines discouraged, sample content and tagline, staging-host canonicals/links, PHP errors on pages, robots.txt blocking theme files, plugin load, version disclosure; probes REST user list, XML-RPC, debug.log, uploads listing, readme.html | Done |
| Laravel / Next.js packs | Next |
| Doc ingestion → plan / scenarios / cases (Claude Agent SDK) | Phase 3 |
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

Open the sample project, change its environment URL in the DB to a site you are allowed to crawl, and press **Start check**.

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
