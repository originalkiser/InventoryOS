# InventoryOS — Session Handoff

**Project:** InventoryOS (Strickland Brothers internal ops platform)
**Repo:** https://github.com/originalkiser/InventoryOS
**Branch:** `main`
**Supabase project:** `fbrguyigmqrzsowfusoi` (fbrguyigmqrzsowfusoi.supabase.co)
**User:** mkiser97@gmail.com
**Stack:** React 18 + TypeScript 5 + Vite 5 + TailwindCSS 3 + Supabase JS v2 (multi-schema)
**Live at:** https://originalkiser.github.io/InventoryOS/ (GitHub Pages — see In Progress below)

> Architecture rules, the schema reference, and coding patterns live in **`CLAUDE.md`** and are
> kept current there — that's the file to read for "how does this app work." This file is a
> point-in-time snapshot of **what's actually in progress and what just shipped**, for picking
> up work without re-deriving recent history from git log.

---

## In progress

### Cloudflare Pages migration (started 2026-09-10, not cut over)

Moving off GitHub Pages, mainly to get real apex-domain support for a newly purchased domain
(GitHub Pages apex domains need 4 hardcoded `A` records with no reliable CNAME; a subdomain is
one CNAME either way). See `CLAUDE.md`'s **Deployment** section for the full technical detail.

Status:
1. ✅ `public/_redirects` (`/*  /index.html  200`) pushed to `main` — additive, GitHub Pages
   ignores it, ready for whenever a Cloudflare Pages project builds this repo.
2. ⬜ **Blocked / needs redo:** the first Cloudflare project was created as a **Worker**
   (`wrangler deploy`) instead of classic **Pages**, because Cloudflare's unified dashboard
   defaulted the "connect a repo" flow into Workers. That failed — Workers' static-asset path
   auto-configures a Vite plugin that requires Vite ≥6, and this repo is on Vite 5. **Do not
   upgrade Vite to fix this** — recreate the project under the Pages product instead, or
   override its deploy command to `npx wrangler pages deploy dist --project-name=<name>`.
3. ⬜ Point a domain at the Pages project (subdomain recommended over apex — see CLAUDE.md)
4. ⬜ Update Supabase Auth → Site URL / Redirect URLs to the new domain (only the
   password-reset email flow needs this; nothing else uses an auth redirect)
5. ⬜ Once traffic has moved: retire the GitHub Pages workflow, `public/404.html`, the
   `index.html` decode script, and the `vite.config.ts` `GITHUB_ACTIONS` base-path conditional

---

## Recently shipped (2026-09-10 session)

### Menu Board module — built end to end
New module: `src/modules/marketing/menuboard/` + `marketing.menu_board_packages` /
`menu_board_quart_defaults` / `menu_board_quart_overrides` / `menu_board_shares`. Full
architecture is documented in `CLAUDE.md`'s Menu Board module-notes entry. Highlights:
- Live per-shop pricing board recreating the printed lobby sign, sourced from `core.locations`'
  existing price columns — no separate price-entry system
- Draggable layout editor; printed-board price typography (small `$`, big dollars, superscript
  cents, "PLUS TAX")
- PDF-reader-style viewer: zoom, Single/Stacked/Side-by-side page layout
- Shareable public links (no auth) — locked to one shop or open (viewer picks); pretty URLs
  (`/menu-board/<shop>-<hash>`), legacy token URLs (`/m/<uuid>`) still supported
- Direct PDF download per shop, rebuilt fresh from live data on every visit (canvas-drawn, not
  a DOM screenshot — html2canvas couldn't reproduce the price layout)
- "Shop Links" tab: one board link + one PDF-download link per active shop, in a
  sortable/filterable/exportable table (Owner, Regional Director, Market, Area Manager, emails)

### Sidebar section access — every section now grantable
`Droptop` and `Data Connections` sidebar sections had no `platform.departments` row, so a
`department_user` could never be granted access to them. Fixed, and made self-extending: the
admin Manage User modal's checkboxes are now derived from the sidebar itself (`Sidebar.tsx`'s
`ASSIGNABLE_SECTIONS`), and granting a section auto-creates its department row on first use —
no migration needed for sections added after this.

### Hotfix: `platform.user_profiles` RLS infinite recursion
The `UPDATE` policy sub-selected `user_profiles` from inside its own policy — Postgres 17
treats that as infinite recursion the moment an admin edits *another* user (editing your own
profile short-circuits around it, which is why this sat unnoticed since the `2026-09-03` RLS
refactor that introduced it). This had been silently blocking the entire admin "edit another
user" flow. Fixed by swapping in the existing `is_admin()` SECURITY DEFINER helper.

---

## Known gotchas worth re-reading in `CLAUDE.md` before touching these areas

- **RLS self-reference** — never sub-`SELECT` a table from inside its own policy (Supabase
  architecture section).
- **Schema location drift** — `tasks`, `issues`, `vendors`/`vendor_parts`, `uom_mappings`,
  `global_products` have all moved schemas at least once; verify against
  `information_schema.tables` if a query returns suspiciously empty results instead of trusting
  this doc or a migration comment.
- **Menu Board art positions** are pixel-tied to the current `MenuBoard-01/02.png` — re-measure
  (or drag-adjust via "Edit layout") if that art is ever re-exported.

---

## Common code patterns

```ts
// Schema access
const sb = supabase as any
sb.schema('marketing').from('menu_board_shares').select('*')

// Toast
import toast from 'react-hot-toast'
toast.success('Saved')

// Table hook — sort + Excel-style per-column filter + CSV/XLSX export come free
const { table, globalFilter, setGlobalFilter } = useTable(data, columns)
<DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="My Export" />

// Role check
import { isAdminOrDeveloper } from '@/lib/roles'
isAdminOrDeveloper(profile?.role)
```

See `CLAUDE.md` for the full architecture reference, schema map, brand rules, and Claude Code
operating rules.
