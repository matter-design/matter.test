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
| Findings deduped across runs by fingerprint; reopened if they come back | Done |
| Web app: project list, project page, start a check, runs, open findings | Done (basic) |
| Performance (Lighthouse / web-vitals), visual + cross-browser, platform packs, reports | Next |
| Doc ingestion → plan / scenarios / cases (Claude Agent SDK) | Phase 3 |
| Self-healing sanity runner | Phase 4 |

## Run it locally

Needs Node 22+, pnpm 10, Docker.

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
```

Writes a JSON report to `./artefacts/`.

## Layout

```
apps/
  web/        Next.js app (App Router, server actions)
  worker/     BullMQ worker + CLI; persists results
packages/
  core/       shared enums, Zod schemas, finding fingerprint
  db/         Drizzle schema, migrations, seed
  checks/     deterministic check engine (Playwright, axe-core, cheerio)
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
- Security checks are passive: they read headers and cookies, and request a fixed short list of commonly exposed files. No payloads.
- Site credentials are referenced from a secret store, never stored in Postgres.
- Environments default to no side effects (no orders, no form submissions).
