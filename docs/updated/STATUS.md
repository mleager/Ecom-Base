# Project status

**As of 2026-11-07.** Milestones 1–13 are complete. Milestone 14 (production serving and HTTPS) is next, followed by Milestone 15 (final release). Task list: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md).

## Milestones

| # | Milestone | Outcome | State |
|---|---|---|---|
| 1 | Core database and services | Schema, toolchain, identity, accounts, catalog, cart | Done |
| 2 | Transactional orders | Atomic T1: snapshots, reservations, idempotency, cart consumption | Done |
| 3 | Simulated payment | Processing claim, deterministic simulator, T2 settlement, cancellation, order HTTP | Done |
| 4 | Failure recovery | Recovery CLI, diagnostics, concurrency and crash tests | Done |
| 5 | Backend readiness | Architecture docs, runbooks, consolidated evidence | Done |
| 6 | Frontend design and API alignment | Routes, tooling pins, fixtures, product search and admin read APIs | Done |
| 7 | Frontend foundation and auth | Shell, typed API client, session lifecycle, protected routes | Done |
| 8 | Storefront and catalog | Product list and details, search, pagination | Done |
| 9 | Account, addresses, cart | Profile, password/email security, password reset, addresses, cart | Done |
| 10 | Checkout and orders | Checkout with recovery, order history, observation, cancellation | Done |
| 11 | Administration and hardening | Product and stock admin, accessibility, full browser regression | Done |
| 12 | Visual design | Shared dark visual system across all pages | Done |
| 13 | Shopping revision and guest checkout | Tailwind/shadcn UI, Quick View, mini-cart, guest purchase and recovery, admin search | Done (GAP-08 closed) |
| 14 | Production serving and HTTPS | API serves the SPA from one HTTPS origin; database TLS; production-mode smoke | **In progress** (1/10 tasks: decisions recorded). See [MILESTONE_14.md](MILESTONE_14.md) |
| 15 | Final baseline release | Application image, Compose deployment, release evidence, tag | **Not started**. See [MILESTONE_15.md](MILESTONE_15.md) |

## Current facts

| Item | Value |
|---|---|
| Schema / readiness version | 13 (migrations `00001`–`00013`), 21 tables plus goose metadata |
| OpenAPI | 1.7.0: 61 business operations (23 guest) + 3 operational routes (`/health/live`, `/health/ready`, `/metrics`) |
| Fixture data | Version 1: 36 products (34 active, 2 retired), 3 accounts |
| Frontend routes | 27 browser routes, including 4 guest routes |
| Browser tests | 348 Chromium tests across 46 spec files |
| Frontend unit/component tests | 1,366 across 46 suites |

## Environment (Ubuntu)

The project moved from Windows to Ubuntu. Current toolchain:

| Tool | Installed | Project pin | Notes |
|---|---|---|---|
| Go | 1.27.3 | `go 1.25.1` in `go.mod` | Works. `GOTOOLCHAIN=local` uses the installed newer Go; no download occurs. |
| goose | 3.28.0 | 3.27.1 | Installed CLI; migrations validate and apply. |
| sqlc | 1.31.1 | 1.31.1 | Matches. |
| Node / npm | 24.20.0 / 11.19.0 | Exact (`engine-strict`) | Node 24 is the system default. |
| PostgreSQL | `postgres:16-alpine` | Moving tag | Only container in use. |
| Playwright Chromium | Revision 1248 (pinned by Playwright 1.64.1) | — | Present in `.cache/playwright` and `~/.cache/ms-playwright`. |

Windows-only helpers moved to `scripts/win64/`. Bash entry points are `scripts/dev.sh`, `scripts/fixture.sh` and `scripts/connect.sh`.

## Verification on Ubuntu

| Gate | Result |
|---|---|
| `bash scripts/dev.sh check` (gofmt, sqlc vet/generate, goose validate, go vet, go test) | Pass |
| `bash scripts/dev.sh integration --race` | Pass (about 5 minutes) |
| `npm run typecheck`, `npm test`, `npm run build` | Pass (1,366 tests) |
| `npm run test:e2e` | Pass, 348/348 (about 19 minutes) |

The first Ubuntu e2e runs crashed late in the suite. The cause was an unstable CPU core on the host (logical CPUs 8–9), confirmed by pinning tests away from those cores. It was not a code or test defect. The old WSL clock-sync workaround described in older docs no longer applies.

## Known limits

Addressed by M14:

- Production mode needs HTTPS, verified database TLS and SMTP, but the server has no TLS listener.
- The API does not serve the built SPA, and unknown paths return JSON 404, so direct navigation to SPA routes (including email links) has no fallback.
- `VITE_API_BASE_URL` must be absolute and is fixed at build time.

Still open after M14:

- Verification is Chromium-only on one host. Other engines, assistive technology and physical devices are not certified.
- The largest JS chunk (about 433 kB) is close to Vite's default 500 kB warning threshold.

## Repository cleanup candidates

These files are leftovers from earlier work. Review them before release; nothing has been removed.

| File | Why |
|---|---|
| Root `package.json` | Uses caret ranges, which conflicts with the exact-pin policy in `frontend/` |
| `frontend/ui-design-temp.md`, `frontend/fix.md`, `frontend/tailwind-shadcn-versions.md` | Scratch notes. The TypeScript errors in `fix.md` do not reproduce with TS 7.0.2. |
| `scripts/.dev-rough.sh` | Draft script |
| `docs/api/openapi.m13.yaml` | M13 design draft, superseded by `openapi.yaml` 1.7.0 |
| `.codex/config.toml` | Tool config for another assistant; references Windows `shadcn.cmd` |
| `.cache/milestone*`, `.cache/playwright/winldd-*` | Old Windows-era logs and binaries in the ignored cache |
