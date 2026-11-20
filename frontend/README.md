# Commerce Lab frontend

React 19 + TypeScript SPA, built with Vite. The design, architecture and test strategy are in [docs/frontend](../docs/frontend/README.md); this file covers working in this directory.

## Requirements

Node **24.20.0** and npm **11.19.0** (enforced by `engine-strict`). Install with `npm ci` only; `package-lock.json` is the installed tree. Pins and their reasons are in [toolchain.json](../docs/frontend/toolchain.json).

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Vite on `http://localhost:5173`, calling the API at `VITE_API_BASE_URL` (default `http://localhost:8080/api/v1`) |
| `npm run build` | Type check, then build into `dist/` |
| `npm run build:same-origin` | Build with `/api/v1` resolved against the page origin (what the image and the S3 publish use) |
| `npm run typecheck` / `npm test` | `tsc --noEmit` / Vitest |
| `npm run test:e2e` | Every Playwright test against real Go and PostgreSQL |
| `npm run test:e2e:{auth,storefront,checkout,admin,harness,smoke}` | One browser group; append `-- --grep "title"` to narrow it |
| `npm run test:e2e:https` | The HTTPS group (needs `bash scripts/certs.sh`) |
| `npm run test:e2e:failed` | Rerun the last failures |
| `npm run design:dev` | The design preview with synthetic data, on port 5174 |

Browser tests need PostgreSQL running, the root `.env`, Go and goose installed, and ports 5173+*n* and 18080+*n* free for each worker. See [docs/frontend/TESTING.md](../docs/frontend/TESTING.md).

## Conventions

- `VITE_*` values are public and baked in at build time; never put a secret in them. Override locally in `.env.local`.
- Use `localhost` on both the frontend and the API: mixing it with `127.0.0.1` breaks `SameSite=Strict` cookies.
- Add shadcn components with the local CLI (`npx shadcn add … --dry-run` first) and review the diff; see [primitives/README.md](src/shared/ui/primitives/README.md).
- `../fixtures/public` is Vite's public directory, so product images are served from `/fixtures/v1/`.
