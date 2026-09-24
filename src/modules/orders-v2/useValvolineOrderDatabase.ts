// Valvoline Order Database (2026-09-24 request) — a real, permanent record
// of Valvoline order lines: history uploaded from Valvoline's own
// order-history export, orders placed directly with Valvoline that never
// went through SB Net, and every order this app itself finalizes for
// Valvoline going forward (see insertValvolineOrderFromFinalize, called
// from useOrderHistory.ts's finalizeDraft). Deliberately NOT for
// delivery-schedule inference — see ov2_location_schedules /
// DeliverySchedulesCard.tsx for that, unchanged — this is "what's already
// on order," so a new order can be checked against it before generating.
// Migration: 20260930bg_valvoline_order_lines.sql.
import { useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import toast from 'react-hot-toast'
import type { ParseResult } from '@/lib/fileParser'

const sb = () => supabase as any
const PAGE = 5000

export interface ValvolineOrderLineRow {
  id: string
  location_id: string | null
  shop_raw: string | null
  ship_to_account_number: string | null
  po_number: string
  po_date: string | null
  delivery_date: string | null
  line_number: number
  material_code: string | null
  product_id: string | null
  description: string | null
  quantity: number | null
  uom: string | null
  source: 'upload' | 'sbnet'
  created_at: string
}

// PostgREST caps an un-ranged select at 1000 rows regardless of a Max Rows
// setting past 1000 — same fix already applied at PoStatusPage.tsx/
// LocationLookupPage.tsx/useRdReports.ts for the same reason.
async function fetchAllRows(companyId: string): Promise<ValvolineOrderLineRow[]> {
  const out: ValvolineOrderLineRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb().schema('inventory').from('valvoline_order_lines')
      .select('*').eq('company_id', companyId).order('po_date', { ascending: false }).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as ValvolineOrderLineRow[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

// Strips a trailing packaging-variant suffix (e.g. "BB" bay box, "D" drum)
// down to a product's bare base code — e.g. "VRP020BB" -> "VRP020", same
// rule OrdersV2Export.tsx's own stripPackagingSuffix uses (duplicated
// rather than shared — each is a one-line local helper).
const stripPackagingSuffix = (id: string) => id.replace(/[A-Za-z]+$/, '')

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function parseDateCell(raw: string): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : toIsoDate(d)
}

/**
 * Auto-feed — called from finalizeDraft only when the finalized draft's own
 * vendor is Valvoline (isValvoline, useOrdersV2.ts). Same additive-only
 * upsert as an upload; po_number/line_number match exactly what Orders v2
 * Export's own per-shop line_number field and poNumber() already produce,
 * so a shop's own SB Net order and a later Valvoline-side export of the
 * same PO land on the same rows instead of duplicating.
 */
export async function insertValvolineOrderFromFinalize(
  companyId: string,
  finalizedLines: { location_id: string; product_id: string; qty: number; uom: string | null; po_number: string; line_number: number }[],
) {
  if (!finalizedLines.length) return
  const rows = finalizedLines.map((l) => ({
    company_id: companyId, location_id: l.location_id, po_number: l.po_number, line_number: l.line_number,
    product_id: l.product_id, quantity: l.qty, uom: l.uom, source: 'sbnet',
  }))
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb().schema('inventory').from('valvoline_order_lines')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'company_id,po_number,line_number', ignoreDuplicates: true })
    // Best-effort — never let the database feed block a real finalize.
    if (error) console.warn('[ValvolineOrderDatabase] insert from finalize failed:', error)
  }
}

export function useValvolineOrderDatabase() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [uploading, setUploading] = useState(false)

  const fetchAll = useCallback(async (): Promise<ValvolineOrderLineRow[]> => {
    if (!companyId) return []
    return fetchAllRows(companyId)
  }, [companyId])

  /**
   * Upload handler for FileUploadZone — matches Valvoline's own
   * order-history export shape (confirmed against a real file, 2026-09-24):
   * Customer Ship To Account Number / Customer PO Number / Customer PO Date
   * / Request Delivery Date / Line Number / Valvoline Material Code /
   * Quantity / Unit of Measure / Item Description / sboc_shop_number. Only
   * the first sheet is read (FileUploadZone's own parseFile already does
   * this) — the real master file's own "Orders" sheet is first, with 3
   * other lookup/pivot sheets after it that are never read.
   *
   * Additive only: (company_id, po_number, line_number) is the natural key
   * (upsert + ignoreDuplicates, same pattern as RD's own
   * insertDeliveryLedger in useRdReports.ts) — re-uploading the same file,
   * or one with overlapping rows, only ever adds rows never seen before.
   * Nothing already in the table is ever updated or removed by an upload.
   */
  const uploadHistory = useCallback(async (parsed: Pick<ParseResult, 'headers' | 'rows'>) => {
    if (!companyId) { toast.error('No company'); return }
    const h = parsed.headers
    const shopCol = h.find((x) => /sboc.?shop|shop.?num/i.test(x))
    const accountCol = h.find((x) => /ship\s*to.*account/i.test(x))
    const poCol = h.find((x) => /po\s*number/i.test(x))
    const poDateCol = h.find((x) => /po.*date/i.test(x))
    const deliveryDateCol = h.find((x) => /deliver.*date/i.test(x))
    const lineCol = h.find((x) => /line\s*number/i.test(x))
    const materialCol = h.find((x) => /material\s*code/i.test(x))
    const qtyCol = h.find((x) => /^quantity$/i.test(x.trim())) ?? h.find((x) => /quantity/i.test(x))
    const uomCol = h.find((x) => /unit\s*of\s*measure|^uom$/i.test(x))
    const descCol = h.find((x) => /item\s*description|^description$/i.test(x))
    if (!poCol || !lineCol) {
      toast.error('Need at least a PO Number column and a Line Number column')
      return
    }

    setUploading(true)
    try {
      // Valvoline Material Code -> our own base product id, via vendor_parts
      // (the same table Orders v2 Export already resolves against) —
      // best-effort only; a lot of real multi-year history uses older
      // material codes with no current vendor_parts row, which is expected
      // and fine (raw material_code/description are always kept regardless).
      const { data: vendorRows } = await sb().schema('inventory').from('vendors')
        .select('id').eq('company_id', companyId).ilike('name', '%valvoline%')
      const vendorIds = (vendorRows ?? []).map((v: { id: string }) => v.id)
      const { data: vpRows } = vendorIds.length
        ? await sb().schema('inventory').from('vendor_parts').select('part_number, our_part_number').in('vendor_id', vendorIds)
        : { data: [] }
      const vendorPartsByCode = new Map<string, string>(
        (vpRows ?? [])
          .filter((p: { part_number: string | null; our_part_number: string | null }) => p.part_number && p.our_part_number)
          .map((p: { part_number: string; our_part_number: string }): [string, string] => [p.part_number.toLowerCase(), p.our_part_number]),
      )

      const rows: Record<string, unknown>[] = []
      for (const r of parsed.rows) {
        const poNumber = (r[poCol] ?? '').trim()
        const lineRaw = (r[lineCol] ?? '').trim()
        const lineNumber = Number(lineRaw)
        if (!poNumber || !Number.isFinite(lineNumber)) continue
        const shopRaw = shopCol ? (r[shopCol] ?? '').trim() : ''
        const materialCode = materialCol ? (r[materialCol] ?? '').trim() : ''
        const mapped = materialCode ? vendorPartsByCode.get(materialCode.toLowerCase()) : undefined
        rows.push({
          company_id: companyId,
          location_id: shopRaw ? loc.resolveId(shopRaw) : null,
          shop_raw: shopRaw || null,
          ship_to_account_number: accountCol ? (r[accountCol] ?? '').trim() || null : null,
          po_number: poNumber,
          po_date: poDateCol ? parseDateCell(r[poDateCol] ?? '') : null,
          delivery_date: deliveryDateCol ? parseDateCell(r[deliveryDateCol] ?? '') : null,
          line_number: lineNumber,
          material_code: materialCode || null,
          product_id: mapped ? stripPackagingSuffix(mapped) : null,
          description: descCol ? (r[descCol] ?? '').trim() || null : null,
          quantity: qtyCol ? (Number(r[qtyCol]) || null) : null,
          uom: uomCol ? (r[uomCol] ?? '').trim() || null : null,
          source: 'upload',
        })
      }
      if (!rows.length) {
        toast.error('No usable rows found — need a PO Number and a Line Number on each row')
        return
      }

      const CHUNK = 1000
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sb().schema('inventory').from('valvoline_order_lines')
          .upsert(rows.slice(i, i + CHUNK), { onConflict: 'company_id,po_number,line_number', ignoreDuplicates: true })
        if (error) throw error
      }
      toast.success(`Processed ${rows.length} order line${rows.length === 1 ? '' : 's'} — rows already on file were skipped automatically`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [companyId, loc])

  return { uploading, fetchAll, uploadHistory }
}
