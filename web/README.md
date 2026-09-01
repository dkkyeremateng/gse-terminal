# GES Pro Terminal — Web

Greenfield React + TypeScript dashboard for the ges-data-engine Go API.

Lives at `/web` alongside the existing `/ui` server-rendered pages — they coexist; this is the modern client built from scratch.

## Stack

- **Vite 8** + **React 19** + **TypeScript 5.7**
- **Tailwind CSS v4** with a dark-first design token system (light theme included)
- **shadcn/ui** primitives (vendored under `src/components/ui/`)
- **React Router 7** (data router)
- **TanStack Query 5** for server state
- **Zustand 5** for client state (auth)
- **React Hook Form + Zod** for forms
- **Recharts** + **lightweight-charts** for visualization
- **TanStack Table 8** for virtualized data tables
- **Lucide** icons, **Inter** + **JetBrains Mono** fonts (variable, self-hosted)
- **MSW 2** for fixture-driven design review (opt-in via `VITE_USE_MSW=true`)
- **openapi-typescript** generates types directly from the live backend's `/v1/openapi.json`
- **Vitest** + **Testing Library** for tests

## Getting started

```bash
cp .env.example .env.local      # adjust VITE_API_PROXY if needed
npm install                      # if you haven't already
npm run dev                      # http://localhost:5173
```

Make sure the Go backend is running on port `8080` before signing in. Vite proxies `/login`, `/auth/*`, `/v1/*`, `/ws`, etc. to it.

## Useful scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the dev server (proxies API to Go backend) |
| `npm run build` | Type-check + production build |
| `npm run preview` | Serve the production build locally |
| `npm run gen:api` | Regenerate `src/lib/api/types-generated.ts` from `/v1/openapi.json` |
| `npm run msw:init` | Install the MSW service worker into `public/` (one-time) |
| `npm run test` | Run Vitest in watch mode |
| `npm run lint` | Run ESLint |

## Folder structure

```
src/
  app/            router, layouts, providers, route guards
  routes/         page-level components, grouped by feature
  components/
    ui/           shadcn primitives (Button, Card, Input, …)
    domain/       PriceCell, KpiCard, TickerTape, …
    charts/       CandlestickChart, SectorHeatmap, …
    layout/       Sidebar, TopBar, RightRail, BottomNav
  features/       feature-scoped hooks/queries/types — RN-portable
    auth/, portfolio/, watchlist/, markets/, alerts/, news/, ai/, admin/
  lib/
    api/          fetch client, generated types, endpoint catalog
    ws/           WebSocket hook + event types
    hooks/        framework-agnostic hooks
    utils/        cn, formatters, date helpers
  mocks/          MSW handlers + fixtures (loaded only when VITE_USE_MSW=true)
  styles/         tokens.css (semantic CSS vars)
  test/           Vitest setup
```

## Design system

Dark-first OLED-friendly terminal. Tokens live in `src/styles/tokens.css` — components consume the semantic CSS variables only (e.g. `bg-background`, `text-foreground`, `text-gain`).

Tabular numerics use **JetBrains Mono** with `font-variant-numeric: tabular-nums` — apply via the `.tabular` class or `data-tabular` attribute. Always use this for prices, P&L, percent changes, and table figures to prevent digit-width jitter on live updates.

Status colors (`gain`, `loss`, `warning`) are paired with icons or arrows in components — never color alone.

## Feature gating

`useEntitlements()` returns `{ isAuthenticated, isPro, isAdmin }` from `/v1/me`. **Pro and admin features are hidden entirely** — sidebar items disappear, routes render `/404`. No upsell modals, no lock icons.

## React Native portability

Business logic (queries, mutations, formatters, auth) lives under `features/` and `lib/`. Only `components/` imports DOM/Tailwind. When the React Native shell is built later, `features/` is reused wholesale.
