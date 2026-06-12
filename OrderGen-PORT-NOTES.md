# OrderGen → InventoryOS Port Notes

Source studied: `github.com/originalkiser/order-generator` (~8,200 LOC client-side
React/Vite SPA). This documents how the original works and how each behavior is
ported into the InventoryOS Orders module. **The calculation math is preserved
exactly** (see `src/lib/orderEngine.ts`); only the plumbing is adapted
(localStorage/sessionStorage → Supabase, single-file wizard → module files, its
bundled parser → the shared `fileParser`/`ColumnMapper`).

Original wizard flow: `Upload | Manual` → `Map` → `UoM` → `MinRules` → `Review` → `Export`.

## (a) Spreadsheet upload + unused-row / header-alignment detection
- Original `UploadStep.jsx` parses CSV/XLSX, then scans for the real header row
  (skips banner/blank/junk rows) and aligns columns.
- **Port:** use the existing shared `src/lib/fileParser.ts` + `columnDetect.ts`
  (`detectHeaderRow` → skips junk rows, picks the header candidate). Verified it
  reproduces order-gen's intent: both skip leading non-data rows and key off the
  first row that looks like headers. **Discrepancy:** order-gen also had a
  "Totals row" filter (`isTotalRow` in calc.js) that drops grand/sub-total lines;
  the shared parser does not, so `orderEngine.isTotalRow()` is ported verbatim and
  applied during generation to exclude total rows.

## (b) Column mapping
- Original `MapStep.jsx`: maps file headers → core fields
  (`location, product, on_hand, leadtime, daily_usage, category, cost`), remembers
  mappings in localStorage keyed by a header fingerprint, and auto-suggests via
  `findBestSavedMapping` (needs ≥2 column matches).
- **Port:** reuse the shared `ColumnMapper` (per-field InverseToggle). Saved
  mappings live in **`order_profiles.config.mapping`** (Supabase) instead of
  localStorage; a loaded Profile prefills the mapper.

## (c) Order-generation algorithm (`utils/calc.js`, preserved verbatim)
- `calcOrder(row, targetDays, factor, onHandOverride)` =
  `ceil( max(0, (daily_usage*(leadtime+targetDays) − on_hand) * factor) )`.
- `computeSuggested(...)` supports two modes:
  - **days_supply** — pure `calcOrder` to cover lead + target days.
  - **min_max** — if `on_hand ≤ min` OR projected-at-delivery
    (`on_hand − usage*lead`) `< min`, order up to `max` (`ceil((max−on_hand)/ohFactor)`);
    else 0. Zero-usage rows honor a `zeroUsageFill` of none/min/max.
- `applyOnHandConstraints(...)` enforces per-row min/max-on-hand-after (raises to
  min, caps to max unless ignored).
- **InventoryOS mapping:** the min/max model is driven by `location_order_configs`:
  `order_trigger` → min (reorder point), `capacity` → max (target level),
  `order_limit` → max-order cap. `trigger_reason` records why a line was ordered
  (below trigger / projected below trigger / zero-stock fill).

## (d) Flexible MINIMUM ORDER QUANTITY rules engine (`applyMinOrderRules`)
- Original rule shape `{ id, scope, minQty, location?, field?, colValue? }`.
- Scopes + **precedence: `column_value` (2) > `location` (1) > `global` (0)**.
  Only the single highest-precedence matching rule applies; a minimum is applied
  **only when `orderQty > 0`** (never forces an order on a zero-need line).
- `applyProductRule` adds `minQty / maxQty / caseSize (round-up) / maxOnHandAfter`.
- **Port:** persisted in **`order_min_rules`** (`applies_to` jsonb carries
  scope+location/field/value; `bulk_minimum`/`individual_minimum`, `uom`,
  `package_type`, `rule_logic` carry case size etc.). `orderEngine.applyMinOrderRules`
  keeps the exact precedence + ">0 only" + case-round math. Bulk vs individual
  minimum: individual minimum is the per-line floor; bulk minimum + package_type
  drive case-size rounding ("package-type callouts").

## (e) Named PROFILE system (localStorage → Supabase)
- Original `utils/profile.js`: named snapshots of all settings in localStorage
  (`loadProfileList/snapshotCurrentToProfile/getProfileSnapshot`), with a current
  profile pointer and a profile gate on first load.
- **Port:** **`order_profiles`** (`name`, `scope`, `config` jsonb). `config`
  stores `{ mapping, generationParams, minRuleIds }`. Save current New-Order
  setup under a name; load to prefill. No gate (multi-tenant auth already scopes).

## (f) Document uploads at BOTH start and export stages
- Original attached supporting docs as in-memory data URLs at the Upload step and
  again at the Export step (account info / product info / template files).
- **Port:** **`order_documents`** (`stage` = 'start' | 'export', `storage_path`)
  backed by the Supabase **`order-documents`** storage bucket. Files persist
  (unlike the original's volatile data URLs) and attach to the saved session.

## (g) Export format / logic (`ExportStep.jsx`)
- Original: a **custom column-layout builder** — user picks which fields/headers
  appear and in what order; `resolveCell(col,row)` produces each cell. Formats:
  **xlsx / csv / txt**. Optional **vendor grouping**: one sheet per vendor, or one
  file per vendor, or a single sheet. Zero-qty lines optionally excluded.
- **Port:** `orderEngine.buildExport(session, lineItems, columns)` returns
  `{ headers, rows }` in the chosen column order; the UI writes CSV (shared
  `exportTableToCsv`) or xlsx (SheetJS, already a dep). Vendor grouping preserved
  as an option. The export payload is saved to `order_sessions.export_data` and
  the session marked `exported` for later pending logic.

## (h) Full calc.js parity (added later — source @ 5b15edf)
The remaining calc.js functions are now ported into `src/lib/orderEngine.ts`
(math verbatim) and wired through `generateOrder`:
- **`getUsageMultiplier`** — product/category/global % usage adjustment.
  Exposed as a global "Usage Adjust %" in the New Order params.
- **`getUomConversion`** — order/on-hand unit factors via the **`uom_mappings`**
  table (phase8) + per-product **`global_products.order_uom`**; prefix/suffix
  pack rules supported in the engine. Managed in the new "UoM Conversions"
  config tab. Identity (factor 1) when unconfigured, so prior math is unchanged.
- **`buildPendingIndex` / `autoPendingColMap`** — upload a pending-order file in
  the params step; matching product+location qty is subtracted into `final_qty`
  (suggested_qty stays the raw suggestion, `pending_qty` records the offset).
- **`applyOnHandConstraints`** — per-row min/max on-hand-after, driven by the
  optional `min_on_hand`/`max_on_hand` mapped columns (config trigger/capacity
  still drive the min_max suggestion; days_supply is not re-capped by them).
- **`calcDaysOnHand`** — shown as "Days OH" in review.
- **`detectPrefixSuffixPatterns`** — ported (engine helper; auto-detect UI TBD).

## Field reference (InventoryOS config tables feeding the engine)
- `location_order_configs`: `order_trigger`, `capacity`, `order_limit` (per
  location+product).
- `product_id_mappings`: `old_product_id` → `new_product_id`, applied **before**
  matching (`resolveProductIds`).
- `global_products` / `vendor_parts`: `unit_of_measure`, `package_type`,
  `bulk_minimum`, `individual_minimum`.
