import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { LocationDataSourceConfig } from '@/modules/locations/LocationDataSourceConfig'
import { createColumnHelper, type SortingFn, type VisibilityState } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { Location, ColumnMapping } from '@/types'
import { format } from 'date-fns'

// ── Sorting ───────────────────────────────────────────────────────────────────

const numericSort: SortingFn<Location> = (a, b, colId) => {
  const av = parseInt(String(a.getValue(colId) ?? ''), 10)
  const bv = parseInt(String(b.getValue(colId) ?? ''), 10)
  if (!isNaN(av) && !isNaN(bv)) return av - bv
  return String(a.getValue(colId)).localeCompare(String(b.getValue(colId)))
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

const v = (i: any) => (i.getValue() ?? '—') || '—'
const boolCell = (i: any) => {
  const val = i.getValue()
  return val === true ? '✓' : val === false ? '✗' : '—'
}
const dateCell = (i: any) => {
  const val = i.getValue()
  if (!val) return '—'
  try { return format(new Date(val), 'MMM d, yyyy') } catch { return String(val) }
}
const pctCell = (i: any) => {
  const val = i.getValue()
  return val != null ? `${val}%` : '—'
}
const dolCell = (i: any) => {
  const val = i.getValue()
  return val != null ? `$${val}` : '—'
}

// ── Filter hierarchy ──────────────────────────────────────────────────────────

const LOC_FILTER_HIERARCHY = [
  { field: 'owner',         label: 'Owner' },
  { field: 'region',        label: 'Region' },
  { field: 'market',        label: 'Market' },
  { field: 'area_manager',  label: 'Area Manager' },
  { field: 'director',      label: 'Regional Director' },
]
const LS_DROP_FILTERS = 'locations.tab.dropFilters'
const LS_HIDDEN_DROPS = 'locations.tab.hiddenDropdowns'

function locFieldValue(loc: any, field: string): string {
  return String((loc as any)[field] ?? '')
}

// ── Schema field map (upload + import) ───────────────────────────────────────

const SCHEMA_FIELDS = [
  // identity
  { name: 'name',         label: 'Name (Code)',      required: true },
  { name: 'shop_city',    label: 'Shop # / City',    required: true },
  { name: 'region',       label: 'Region' },
  { name: 'status',       label: 'Status' },
  { name: 'active',       label: 'Active Status (text)' },
  // staffing
  { name: 'owner',               label: 'Owner' },
  { name: 'market',              label: 'Market' },
  { name: 'area_manager',        label: 'Area Manager' },
  { name: 'am_phone',            label: 'AM Phone' },
  { name: 'am_email',            label: 'AM Email' },
  { name: 'director',            label: 'Regional Director' },
  { name: 'rd_email',            label: 'RD Email' },
  { name: 'marketing_manager',   label: 'Marketing Manager' },
  { name: 'mm_email',            label: 'MM Email' },
  { name: 'mm_cell',             label: 'MM Cell' },
  { name: 'hrbp',                label: 'HRBP' },
  // address
  { name: 'address',      label: 'Address' },
  { name: 'city',         label: 'City' },
  { name: 'state',        label: 'State' },
  { name: 'county',       label: 'County' },
  { name: 'zip',          label: 'Zip' },
  { name: 'store_phone',  label: 'Store Phone' },
  { name: 'store_email',  label: 'Store Email' },
  { name: 'location',     label: 'Location' },
  // operations
  { name: 'num_bays',              label: '# of Bays' },
  { name: 'pit_type',              label: 'Pit Type' },
  { name: 'store_type',            label: 'Store Type' },
  { name: 'classification',        label: 'Classification' },
  { name: 'groups',                label: 'Groups' },
  { name: 'entity_name',           label: 'Entity Name' },
  { name: 'brand_used',            label: 'Brand Used' },
  { name: 'developer',             label: 'Developer' },
  { name: 'landlord',              label: 'Landlord' },
  { name: 'num_days_open',         label: '# Days Open' },
  { name: 'manager_workweek',      label: 'Manager Workweek' },
  { name: 'second_asm_approved',   label: '2nd ASM Approved' },
  // dates
  { name: 'date_opened',           label: 'Date Opened' },
  { name: 'acquisition_date',      label: 'Acquisition Date' },
  { name: 'year_opened',           label: 'Year Opened' },
  { name: 'droptop_go_live',       label: 'Droptop Go-Live' },
  { name: 'last_price_change',     label: 'Last Price Change' },
  { name: 'review_pricing_date',   label: 'Review Pricing Date' },
  { name: 'last_day_of_business',  label: 'Last Day of Business' },
  // hours
  { name: 'monday_hours',    label: 'Monday Hours' },
  { name: 'tuesday_hours',   label: 'Tuesday Hours' },
  { name: 'wednesday_hours', label: 'Wednesday Hours' },
  { name: 'thursday_hours',  label: 'Thursday Hours' },
  { name: 'friday_hours',    label: 'Friday Hours' },
  { name: 'saturday_hours',  label: 'Saturday Hours' },
  { name: 'sunday_hours',    label: 'Sunday Hours' },
  { name: 'holiday_hours',   label: 'Holiday Hours' },
  // services
  { name: 'tire_rotations',        label: 'Tire Rotations' },
  { name: 'safety_inspections',    label: 'Safety Inspections' },
  { name: 'emissions_inspections', label: 'Emissions Inspections' },
  // financial
  { name: 'royalty_rate',               label: 'Royalty Rate' },
  { name: 'local_ad_percent',           label: 'Local Ad %' },
  { name: 'local_ad_dollar',            label: 'Local Ad $' },
  { name: 'brand_fund',                 label: 'Brand Fund' },
  { name: 'technology_fee',             label: 'Technology Fee' },
  { name: 'sales_quartile',             label: 'Sales Quartile' },
  { name: 'economy',                    label: 'Economy' },
  { name: 'premium_hm',                 label: 'Premium HM' },
  { name: 'premium_full_synthetic',     label: 'Premium Full Synthetic' },
  { name: 'premium_full_synthetic_hm',  label: 'Premium Full Syn HM' },
  { name: 'rp',                         label: 'RP' },
  { name: 'diesel_syn_blend',           label: 'Diesel Syn Blend' },
  { name: 'diesel_full_syn',            label: 'Diesel Full Syn' },
  { name: 'european',                   label: 'European' },
  { name: 'supply_fee',                 label: 'Supply Fee' },
  { name: 'disposal_fee',               label: 'Disposal Fee' },
  { name: 'oil_inflation_surcharge',    label: 'Oil Inflation Surcharge' },
  { name: 'planned_2023',              label: 'Planned 2023' },
  { name: 'planned_2024',              label: 'Planned 2024' },
  // integrations
  { name: 'valvoline_account_num',      label: 'Valvoline Account #' },
  { name: 'ai_shop_id',                 label: 'AI Shop ID' },
  { name: 'ai_username',                label: 'AI Username' },
  { name: 'partnerconnect_username',    label: 'PartnerConnect Username' },
  { name: 'google_review_url',          label: 'Google Review URL' },
  { name: 'google_review_qr_code',      label: 'Google Review QR Code' },
  { name: 'training_shops',             label: 'Training Shops' },
  { name: 'integration_manager_region', label: 'Integration Mgr Region' },
  { name: 'opus_serial_primary',        label: 'Opus Serial (Primary)' },
  { name: 'opus_serial_secondary',      label: 'Opus Serial (Secondary)' },
  { name: 'former_fz_store_num',        label: 'Former FZ Store #' },
  { name: 'tmcw_ql',                    label: 'TMCW QL' },
  { name: 'am_data_map',                label: 'AM Data Map' },
  { name: 'rd_data_map',                label: 'RD Data Map' },
  { name: 'droptop_num',                label: 'Droptop #' },
  { name: 'droptop_operation_id',       label: 'Droptop Operation ID' },
  { name: 'reladyne_delivery_day',      label: 'Reladyne Delivery Day' },
  { name: 'ai_call_center',             label: 'AI Call Center' },
  { name: 'ai_call_center_phone',       label: 'AI Call Center Phone' },
  { name: 'mighty_fz',                  label: 'Mighty FZ' },
  { name: 'camera_system',              label: 'Camera System' },
  { name: 'inspection_station_id',      label: 'Inspection Station ID' },
  { name: 'mighty_po_upload',           label: 'Mighty PO Upload' },
  // coordinates
  { name: 'latitude',   label: 'Latitude' },
  { name: 'longitude',  label: 'Longitude' },
]

const SCHEMA_FIELD_KEYS = new Set(SCHEMA_FIELDS.map((f) => f.name))

// Numeric fields that need Number() coercion on import/save
const NUMERIC_FIELD_KEYS = new Set([
  'num_bays', 'num_days_open', 'year_opened',
  'royalty_rate', 'local_ad_percent', 'local_ad_dollar', 'brand_fund', 'technology_fee',
  'economy', 'premium_hm', 'premium_full_synthetic', 'premium_full_synthetic_hm',
  'rp', 'diesel_syn_blend', 'diesel_full_syn', 'european',
  'supply_fee', 'disposal_fee', 'oil_inflation_surcharge',
  'planned_2023', 'planned_2024', 'latitude', 'longitude',
])

// Boolean fields (tri-state: true / false / null)
const BOOL_FIELD_KEYS = new Set([
  'tire_rotations', 'safety_inspections', 'emissions_inspections',
  'second_asm_approved', 'mighty_po_upload',
])

// Date fields — normalize to YYYY-MM-DD on import to avoid Postgres timezone errors
const DATE_FIELD_KEYS = new Set([
  'date_opened', 'acquisition_date', 'droptop_go_live',
  'last_price_change', 'review_pricing_date', 'last_day_of_business',
])

// ── Default column visibility: hide everything except key columns ─────────────

const INITIAL_COL_VISIBILITY: VisibilityState = {
  // keep visible: name, shop_city, region, status, owner, market, area_manager, director, active, updated_at
  // hide everything else
  am_phone: false, am_email: false, rd_email: false,
  marketing_manager: false, mm_email: false, mm_cell: false, hrbp: false,
  address: false, city: false, state: false, county: false, zip: false,
  store_phone: false, store_email: false, location: false,
  num_bays: false, pit_type: false, store_type: false, classification: false,
  groups: false, entity_name: false, brand_used: false, developer: false, landlord: false,
  num_days_open: false, manager_workweek: false, second_asm_approved: false,
  date_opened: false, acquisition_date: false, year_opened: false,
  droptop_go_live: false, last_price_change: false, review_pricing_date: false,
  last_day_of_business: false,
  monday_hours: false, tuesday_hours: false, wednesday_hours: false,
  thursday_hours: false, friday_hours: false, saturday_hours: false,
  sunday_hours: false, holiday_hours: false,
  tire_rotations: false, safety_inspections: false, emissions_inspections: false,
  royalty_rate: false, local_ad_percent: false, local_ad_dollar: false,
  brand_fund: false, technology_fee: false, sales_quartile: false,
  economy: false, premium_hm: false, premium_full_synthetic: false,
  premium_full_synthetic_hm: false, rp: false, diesel_syn_blend: false,
  diesel_full_syn: false, european: false, supply_fee: false, disposal_fee: false,
  oil_inflation_surcharge: false, planned_2023: false, planned_2024: false,
  valvoline_account_num: false, ai_shop_id: false, ai_username: false,
  partnerconnect_username: false, google_review_url: false, google_review_qr_code: false,
  training_shops: false, integration_manager_region: false,
  opus_serial_primary: false, opus_serial_secondary: false,
  former_fz_store_num: false, tmcw_ql: false,
  am_data_map: false, rd_data_map: false, droptop_num: false, droptop_operation_id: false,
  reladyne_delivery_day: false, ai_call_center: false, ai_call_center_phone: false,
  mighty_fz: false, camera_system: false, inspection_station_id: false,
  mighty_po_upload: false, latitude: false, longitude: false,
}

// ── Form state types ──────────────────────────────────────────────────────────

type FormVals = Record<string, string>
type FormBools = {
  active: boolean
  tire_rotations: boolean | null
  safety_inspections: boolean | null
  emissions_inspections: boolean | null
  second_asm_approved: boolean | null
  mighty_po_upload: boolean | null
}

const EMPTY_FORM_VALS: FormVals = {
  name: '', shop_city: '', region: '', status: '',
  owner: '', market: '', area_manager: '', am_phone: '', am_email: '', director: '', rd_email: '',
  marketing_manager: '', mm_email: '', mm_cell: '', hrbp: '',
  address: '', city: '', state: '', county: '', zip: '', store_phone: '', store_email: '', location: '',
  num_bays: '', pit_type: '', store_type: '', classification: '', groups: '', entity_name: '',
  brand_used: '', developer: '', landlord: '', num_days_open: '', manager_workweek: '',
  date_opened: '', acquisition_date: '', year_opened: '', droptop_go_live: '',
  last_price_change: '', review_pricing_date: '', last_day_of_business: '',
  monday_hours: '', tuesday_hours: '', wednesday_hours: '', thursday_hours: '',
  friday_hours: '', saturday_hours: '', sunday_hours: '', holiday_hours: '',
  royalty_rate: '', local_ad_percent: '', local_ad_dollar: '', brand_fund: '', technology_fee: '',
  sales_quartile: '', economy: '', premium_hm: '', premium_full_synthetic: '',
  premium_full_synthetic_hm: '', rp: '', diesel_syn_blend: '', diesel_full_syn: '', european: '',
  supply_fee: '', disposal_fee: '', oil_inflation_surcharge: '',
  planned_2023: '', planned_2024: '',
  valvoline_account_num: '', ai_shop_id: '', ai_username: '', partnerconnect_username: '',
  google_review_url: '', google_review_qr_code: '', training_shops: '', integration_manager_region: '',
  opus_serial_primary: '', opus_serial_secondary: '', former_fz_store_num: '', tmcw_ql: '',
  am_data_map: '', rd_data_map: '', droptop_num: '', droptop_operation_id: '',
  reladyne_delivery_day: '', ai_call_center: '', ai_call_center_phone: '',
  mighty_fz: '', camera_system: '', inspection_station_id: '',
  latitude: '', longitude: '',
}

const EMPTY_FORM_BOOLS: FormBools = {
  active: true,
  tire_rotations: null, safety_inspections: null, emissions_inspections: null,
  second_asm_approved: null, mighty_po_upload: null,
}

function locToFormVals(r: Location): FormVals {
  const n = (x: number | null | undefined) => (x != null ? String(x) : '')
  return {
    name: r.name ?? '',
    shop_city: r.shop_city ?? '',
    region: r.region ?? '',
    status: r.status ?? '',
    owner: r.owner ?? '',
    market: r.market ?? '',
    area_manager: r.area_manager ?? '',
    am_phone: r.am_phone ?? '',
    am_email: r.am_email ?? '',
    director: r.director ?? '',
    rd_email: r.rd_email ?? '',
    marketing_manager: r.marketing_manager ?? '',
    mm_email: r.mm_email ?? '',
    mm_cell: r.mm_cell ?? '',
    hrbp: r.hrbp ?? '',
    address: r.address ?? '',
    city: r.city ?? '',
    state: r.state ?? '',
    county: r.county ?? '',
    zip: r.zip ?? '',
    store_phone: r.store_phone ?? '',
    store_email: r.store_email ?? '',
    location: r.location ?? '',
    num_bays: n(r.num_bays),
    pit_type: r.pit_type ?? '',
    store_type: r.store_type ?? '',
    classification: r.classification ?? '',
    groups: r.groups ?? '',
    entity_name: r.entity_name ?? '',
    brand_used: r.brand_used ?? '',
    developer: r.developer ?? '',
    landlord: r.landlord ?? '',
    num_days_open: n(r.num_days_open),
    manager_workweek: r.manager_workweek ?? '',
    date_opened: r.date_opened ?? '',
    acquisition_date: r.acquisition_date ?? '',
    year_opened: n(r.year_opened),
    droptop_go_live: r.droptop_go_live ?? '',
    last_price_change: r.last_price_change ?? '',
    review_pricing_date: r.review_pricing_date ?? '',
    last_day_of_business: r.last_day_of_business ?? '',
    monday_hours: r.monday_hours ?? '',
    tuesday_hours: r.tuesday_hours ?? '',
    wednesday_hours: r.wednesday_hours ?? '',
    thursday_hours: r.thursday_hours ?? '',
    friday_hours: r.friday_hours ?? '',
    saturday_hours: r.saturday_hours ?? '',
    sunday_hours: r.sunday_hours ?? '',
    holiday_hours: r.holiday_hours ?? '',
    royalty_rate: n(r.royalty_rate),
    local_ad_percent: n(r.local_ad_percent),
    local_ad_dollar: n(r.local_ad_dollar),
    brand_fund: n(r.brand_fund),
    technology_fee: n(r.technology_fee),
    sales_quartile: r.sales_quartile ?? '',
    economy: n(r.economy),
    premium_hm: n(r.premium_hm),
    premium_full_synthetic: n(r.premium_full_synthetic),
    premium_full_synthetic_hm: n(r.premium_full_synthetic_hm),
    rp: n(r.rp),
    diesel_syn_blend: n(r.diesel_syn_blend),
    diesel_full_syn: n(r.diesel_full_syn),
    european: n(r.european),
    supply_fee: n(r.supply_fee),
    disposal_fee: n(r.disposal_fee),
    oil_inflation_surcharge: n(r.oil_inflation_surcharge),
    planned_2023: n(r.planned_2023),
    planned_2024: n(r.planned_2024),
    valvoline_account_num: r.valvoline_account_num ?? '',
    ai_shop_id: r.ai_shop_id ?? '',
    ai_username: r.ai_username ?? '',
    partnerconnect_username: r.partnerconnect_username ?? '',
    google_review_url: r.google_review_url ?? '',
    google_review_qr_code: r.google_review_qr_code ?? '',
    training_shops: r.training_shops ?? '',
    integration_manager_region: r.integration_manager_region ?? '',
    opus_serial_primary: r.opus_serial_primary ?? '',
    opus_serial_secondary: r.opus_serial_secondary ?? '',
    former_fz_store_num: r.former_fz_store_num ?? '',
    tmcw_ql: r.tmcw_ql ?? '',
    am_data_map: r.am_data_map ?? '',
    rd_data_map: r.rd_data_map ?? '',
    droptop_num: r.droptop_num ?? '',
    droptop_operation_id: r.droptop_operation_id ?? '',
    reladyne_delivery_day: r.reladyne_delivery_day ?? '',
    ai_call_center: r.ai_call_center ?? '',
    ai_call_center_phone: r.ai_call_center_phone ?? '',
    mighty_fz: r.mighty_fz ?? '',
    camera_system: r.camera_system ?? '',
    inspection_station_id: r.inspection_station_id ?? '',
    latitude: n(r.latitude),
    longitude: n(r.longitude),
  }
}

// ── Import helpers ────────────────────────────────────────────────────────────

function isActiveText(raw: string): boolean {
  const v = raw.trim().toLowerCase()
  if (v === '') return true
  return ['active', 'true', 'yes', 'y', '1', 'open'].includes(v)
}

function coerce(value: string, type: string): unknown {
  const v = value.trim()
  if (v === '') return null
  if (type === 'number') { const n = Number(v.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
  return v
}

function normalizeDate(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const d = new Date(t)
  if (isNaN(d.getTime())) return null
  return format(d, 'yyyy-MM-dd')
}

// ── Recommended custom column labels (for CustomFieldsEditor) ─────────────────

const RECOMMENDED = [
  { label: 'Delivery Day' },
  { label: 'Area Manager Phone' },
  { label: 'Regional Director Phone' },
]

// ── Form tabs ─────────────────────────────────────────────────────────────────

const FORM_TABS = [
  'Identity', 'Contact & People', 'Operations',
  'Pricing & Financial', 'Hours & Services', 'Integrations',
] as const
type FormTab = typeof FORM_TABS[number]

const col = createColumnHelper<Location>()

// ── Component ─────────────────────────────────────────────────────────────────

export function LocationsTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<Location>('locations', 'core')
  const { active: customFields, addField } = useCustomFields('locations')

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [formTab, setFormTab] = useState<FormTab>('Identity')

  // Contextual dropdown filter state
  const [dropFilters, setDropFilters] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(LS_DROP_FILTERS) ?? '{}') } catch { return {} }
  })
  const [hiddenDropdowns, setHiddenDropdowns] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(LS_HIDDEN_DROPS) ?? '[]')) } catch { return new Set() }
  })
  const [dropSettingsOpen, setDropSettingsOpen] = useState(false)
  const dropSettingsRef = useRef<HTMLDivElement>(null)

  useEffect(() => { localStorage.setItem(LS_DROP_FILTERS, JSON.stringify(dropFilters)) }, [dropFilters])
  useEffect(() => { localStorage.setItem(LS_HIDDEN_DROPS, JSON.stringify([...hiddenDropdowns])) }, [hiddenDropdowns])
  useEffect(() => {
    if (!dropSettingsOpen) return
    function onOut(e: MouseEvent) {
      if (dropSettingsRef.current && !dropSettingsRef.current.contains(e.target as Node)) setDropSettingsOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [dropSettingsOpen])

  // Form state
  const [formVals, setFormVals] = useState<FormVals>(EMPTY_FORM_VALS)
  const [formBools, setFormBools] = useState<FormBools>(EMPTY_FORM_BOOLS)
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const openAdd = useCallback(() => {
    setEditId(null)
    setFormVals(EMPTY_FORM_VALS)
    setFormBools(EMPTY_FORM_BOOLS)
    setCustomVals({})
    setFormTab('Identity')
    setAddOpen(true)
  }, [])

  const openEdit = useCallback((r: Location) => {
    setEditId(r.id)
    setFormVals(locToFormVals(r))
    setFormBools({
      active: r.active,
      tire_rotations: r.tire_rotations,
      safety_inspections: r.safety_inspections,
      emissions_inspections: r.emissions_inspections,
      second_asm_approved: r.second_asm_approved,
      mighty_po_upload: r.mighty_po_upload,
    })
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCustomVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setFormTab('Identity')
    setAddOpen(true)
  }, [])

  // ── Column definitions ──────────────────────────────────────────────────────

  const columns = useMemo(() => {
    const cols: any[] = [
      // Identity (always visible)
      col.accessor('name',       { header: 'Code',           sortingFn: numericSort, size: 80 }),
      col.accessor('shop_city',  { header: 'Shop # / City',  size: 160, cell: v }),
      col.accessor('region',     { header: 'Region',         size: 100, cell: v }),
      col.accessor('status',     { header: 'Status',         size: 90,  cell: v }),
      col.accessor('owner',      { header: 'Owner',          size: 110, cell: v }),
      col.accessor('market',     { header: 'Market',         size: 110, cell: v }),
      col.accessor('area_manager', { header: 'Area Manager', size: 130, cell: v }),
      col.accessor('director',   { header: 'Regional Director', size: 140, cell: v }),

      // Contact & people (hidden)
      col.accessor('am_phone',          { header: 'AM Phone',           cell: v }),
      col.accessor('am_email',          { header: 'AM Email',           cell: v }),
      col.accessor('rd_email',          { header: 'RD Email',           cell: v }),
      col.accessor('marketing_manager', { header: 'Marketing Manager',  cell: v }),
      col.accessor('mm_email',          { header: 'MM Email',           cell: v }),
      col.accessor('mm_cell',           { header: 'MM Cell',            cell: v }),
      col.accessor('hrbp',              { header: 'HRBP',               cell: v }),

      // Address (hidden)
      col.accessor('address',     { header: 'Address',     cell: v }),
      col.accessor('city',        { header: 'City',        cell: v }),
      col.accessor('state',       { header: 'State',       size: 70, cell: v }),
      col.accessor('county',      { header: 'County',      cell: v }),
      col.accessor('zip',         { header: 'Zip',         size: 80, cell: v }),
      col.accessor('store_phone', { header: 'Store Phone', cell: v }),
      col.accessor('store_email', { header: 'Store Email', cell: v }),
      col.accessor('location',    { header: 'Location',    cell: v }),

      // Operations (hidden)
      col.accessor('num_bays',           { header: '# Bays',        size: 80,  cell: v }),
      col.accessor('pit_type',           { header: 'Pit Type',               cell: v }),
      col.accessor('store_type',         { header: 'Store Type',             cell: v }),
      col.accessor('classification',     { header: 'Classification',         cell: v }),
      col.accessor('groups',             { header: 'Groups',                 cell: v }),
      col.accessor('entity_name',        { header: 'Entity Name',            cell: v }),
      col.accessor('brand_used',         { header: 'Brand Used',             cell: v }),
      col.accessor('developer',          { header: 'Developer',              cell: v }),
      col.accessor('landlord',           { header: 'Landlord',               cell: v }),
      col.accessor('num_days_open',      { header: '# Days Open', size: 100, cell: v }),
      col.accessor('manager_workweek',   { header: 'Mgr Workweek',           cell: v }),
      col.accessor('second_asm_approved',{ header: '2nd ASM',     size: 80,  cell: boolCell }),

      // Dates (hidden)
      col.accessor('date_opened',          { header: 'Date Opened',        cell: dateCell }),
      col.accessor('acquisition_date',     { header: 'Acquisition Date',   cell: dateCell }),
      col.accessor('year_opened',          { header: 'Year Opened', size: 90, cell: v }),
      col.accessor('droptop_go_live',      { header: 'Droptop Go-Live',    cell: dateCell }),
      col.accessor('last_price_change',    { header: 'Last Price Change',  cell: dateCell }),
      col.accessor('review_pricing_date',  { header: 'Review Pricing',     cell: dateCell }),
      col.accessor('last_day_of_business', { header: 'Last Day of Business', cell: dateCell }),

      // Hours (hidden)
      col.accessor('monday_hours',    { header: 'Mon Hours', cell: v }),
      col.accessor('tuesday_hours',   { header: 'Tue Hours', cell: v }),
      col.accessor('wednesday_hours', { header: 'Wed Hours', cell: v }),
      col.accessor('thursday_hours',  { header: 'Thu Hours', cell: v }),
      col.accessor('friday_hours',    { header: 'Fri Hours', cell: v }),
      col.accessor('saturday_hours',  { header: 'Sat Hours', cell: v }),
      col.accessor('sunday_hours',    { header: 'Sun Hours', cell: v }),
      col.accessor('holiday_hours',   { header: 'Holiday Hours', cell: v }),

      // Services (hidden)
      col.accessor('tire_rotations',        { header: 'Tire Rotations',     size: 110, cell: boolCell }),
      col.accessor('safety_inspections',    { header: 'Safety Inspections', size: 130, cell: boolCell }),
      col.accessor('emissions_inspections', { header: 'Emissions',          size: 100, cell: boolCell }),

      // Pricing / financial (hidden)
      col.accessor('royalty_rate',              { header: 'Royalty Rate',         size: 100, cell: pctCell }),
      col.accessor('local_ad_percent',          { header: 'Local Ad %',           size: 90,  cell: pctCell }),
      col.accessor('local_ad_dollar',           { header: 'Local Ad $',                      cell: dolCell }),
      col.accessor('brand_fund',                { header: 'Brand Fund',                      cell: pctCell }),
      col.accessor('technology_fee',            { header: 'Tech Fee',                        cell: dolCell }),
      col.accessor('sales_quartile',            { header: 'Sales Quartile',                  cell: v      }),
      col.accessor('economy',                   { header: 'Economy',                         cell: dolCell }),
      col.accessor('premium_hm',                { header: 'Premium HM',                      cell: dolCell }),
      col.accessor('premium_full_synthetic',    { header: 'Prem Full Syn',                   cell: dolCell }),
      col.accessor('premium_full_synthetic_hm', { header: 'Prem Full Syn HM',                cell: dolCell }),
      col.accessor('rp',                        { header: 'RP',                              cell: dolCell }),
      col.accessor('diesel_syn_blend',          { header: 'Diesel Syn Blend',                cell: dolCell }),
      col.accessor('diesel_full_syn',           { header: 'Diesel Full Syn',                 cell: dolCell }),
      col.accessor('european',                  { header: 'European',                        cell: dolCell }),
      col.accessor('supply_fee',                { header: 'Supply Fee',                      cell: dolCell }),
      col.accessor('disposal_fee',              { header: 'Disposal Fee',                    cell: dolCell }),
      col.accessor('oil_inflation_surcharge',   { header: 'Oil Surcharge',                   cell: dolCell }),
      col.accessor('planned_2023',              { header: 'Planned 2023',                    cell: v      }),
      col.accessor('planned_2024',              { header: 'Planned 2024',                    cell: v      }),

      // Integrations (hidden)
      col.accessor('valvoline_account_num',      { header: 'Valvoline #',              cell: v }),
      col.accessor('ai_shop_id',                 { header: 'AI Shop ID',               cell: v }),
      col.accessor('ai_username',                { header: 'AI Username',              cell: v }),
      col.accessor('partnerconnect_username',    { header: 'PartnerConnect',           cell: v }),
      col.accessor('google_review_url',          { header: 'Google Review URL',        cell: v }),
      col.accessor('google_review_qr_code',      { header: 'Google QR Code',           cell: v }),
      col.accessor('training_shops',             { header: 'Training Shops',           cell: v }),
      col.accessor('integration_manager_region', { header: 'Integ. Mgr Region',        cell: v }),
      col.accessor('opus_serial_primary',        { header: 'Opus Serial (Pri.)',        cell: v }),
      col.accessor('opus_serial_secondary',      { header: 'Opus Serial (Sec.)',        cell: v }),
      col.accessor('former_fz_store_num',        { header: 'Former FZ Store #',        cell: v }),
      col.accessor('tmcw_ql',                    { header: 'TMCW QL',                  cell: v }),
      col.accessor('am_data_map',                { header: 'AM Data Map',              cell: v }),
      col.accessor('rd_data_map',                { header: 'RD Data Map',              cell: v }),
      col.accessor('droptop_num',                { header: 'Droptop #',                cell: v }),
      col.accessor('droptop_operation_id',       { header: 'Droptop Op ID',            cell: v }),
      col.accessor('reladyne_delivery_day',      { header: 'Reladyne Delivery Day',    cell: v }),
      col.accessor('ai_call_center',             { header: 'AI Call Center',           cell: v }),
      col.accessor('ai_call_center_phone',       { header: 'AI CC Phone',              cell: v }),
      col.accessor('mighty_fz',                  { header: 'Mighty FZ',               cell: v }),
      col.accessor('camera_system',              { header: 'Camera System',            cell: v }),
      col.accessor('inspection_station_id',      { header: 'Inspection Station ID',    cell: v }),
      col.accessor('mighty_po_upload',           { header: 'Mighty PO Upload', size: 120, cell: boolCell }),

      // Coordinates (hidden)
      col.accessor('latitude',  { header: 'Latitude',  cell: v }),
      col.accessor('longitude', { header: 'Longitude', cell: v }),
    ]

    // Custom metadata fields
    for (const f of customFields) {
      if (SCHEMA_FIELD_KEYS.has(f.field_key)) continue
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.label,
        accessorFn: (r: Location) => (r.metadata as any)?.[f.field_key] ?? '',
        cell: (i: any) => i.getValue() || '—',
      })
    }

    cols.push(col.accessor('active', { header: 'Active', size: 70, cell: (i) => (i.getValue() ? '✓' : '✗') }))
    cols.push(col.accessor('updated_at', {
      header: 'Last Updated',
      size: 140,
      cell: (i) => {
        const r = i.row.original as Location
        const src = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${src}` : '—'
      },
    }))
    cols.push({
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, size: 50,
      cell: (i: any) => (
        <button onClick={() => openEdit(i.row.original as Location)} className="text-xs font-mono text-inky hover:underline">Edit</button>
      ),
    })

    return cols
  }, [customFields, openEdit])

  // ── Filter logic ────────────────────────────────────────────────────────────

  function rowsAbove(fi: number): Location[] {
    let r = data
    for (let i = 0; i < fi; i++) {
      const val = dropFilters[LOC_FILTER_HIERARCHY[i].field]
      if (val) r = r.filter(loc => locFieldValue(loc, LOC_FILTER_HIERARCHY[i].field) === val)
    }
    return r
  }

  const filteredData = useMemo(() => {
    let r = data
    for (const { field } of LOC_FILTER_HIERARCHY) {
      const val = dropFilters[field]
      if (val) r = r.filter(loc => locFieldValue(loc, field) === val)
    }
    return r
  }, [data, dropFilters])

  function setDropFilter(field: string, val: string, fi: number) {
    setDropFilters(prev => {
      const next: Record<string, string> = {}
      for (let i = 0; i < fi; i++) next[LOC_FILTER_HIERARCHY[i].field] = prev[LOC_FILTER_HIERARCHY[i].field] ?? ''
      next[field] = val
      return next
    })
  }

  const hasActiveFilters = LOC_FILTER_HIERARCHY.some(({ field }) => dropFilters[field])

  const visibleHierarchy = LOC_FILTER_HIERARCHY.filter(({ field }) => {
    if (hiddenDropdowns.has(field)) return false
    const vals = new Set(data.map(loc => locFieldValue(loc, field)).filter(Boolean))
    return vals.size >= 2
  })

  const { table, globalFilter, setGlobalFilter } = useTable(filteredData, columns, {
    initialSorting: [{ id: 'name', desc: false }],
    initialVisibility: INITIAL_COL_VISIBILITY,
  })

  // ── Save helpers ────────────────────────────────────────────────────────────

  function buildMetadata(values: Record<string, string>) {
    const meta: Record<string, unknown> = {}
    for (const f of customFields) meta[f.field_key] = coerce(values[f.field_key] ?? '', f.field_type)
    return meta
  }

  async function onSubmit() {
    if (!formVals.name.trim() || !formVals.shop_city.trim()) return
    const payload: Record<string, unknown> = {}
    for (const [k, raw] of Object.entries(formVals)) {
      const trimmed = raw.trim()
      if (NUMERIC_FIELD_KEYS.has(k)) payload[k] = trimmed ? Number(trimmed) : null
      else payload[k] = trimmed || null
    }
    payload.active = formBools.active
    payload.tire_rotations = formBools.tire_rotations
    payload.safety_inspections = formBools.safety_inspections
    payload.emissions_inspections = formBools.emissions_inspections
    payload.second_asm_approved = formBools.second_asm_approved
    payload.mighty_po_upload = formBools.mighty_po_upload
    payload.metadata = buildMetadata(customVals)

    if (editId) await update(editId, payload as Partial<Location>)
    else await insert({ ...payload, updated_by: profile?.id ?? null, last_change_source: 'manual' } as Partial<Location>)
    setAddOpen(false)
    setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm(`Delete location "${formVals.shop_city || formVals.name}"? This cannot be undone.`)) return
    await remove(editId)
    setAddOpen(false)
    setEditId(null)
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  async function confirmImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const customKeys = new Set(
      customFields.filter((f) => !SCHEMA_FIELD_KEYS.has(f.field_key)).map((f) => f.field_key)
    )
    const typeByKey = new Map(customFields.map((f) => [f.field_key, f.field_type]))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'active') {
          out.active = isActiveText(raw)
        } else if (BOOL_FIELD_KEYS.has(m.fieldName)) {
          const t = raw.trim()
          out[m.fieldName] = t ? isActiveText(raw) : null
        } else if (DATE_FIELD_KEYS.has(m.fieldName)) {
          out[m.fieldName] = normalizeDate(raw)
        } else if (NUMERIC_FIELD_KEYS.has(m.fieldName)) {
          const n = Number(raw.replace(/[$,]/g, ''))
          out[m.fieldName] = raw.trim() && !isNaN(n) ? n : null
        } else if (customKeys.has(m.fieldName)) {
          meta[m.fieldName] = coerce(raw, typeByKey.get(m.fieldName) ?? 'text')
        } else {
          out[m.fieldName] = raw.trim() || null
        }
      }
      out.metadata = meta
      return out as Partial<Location>
    }).filter((r: any) => r.name)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.name ?? '').toLowerCase() })
    setImporting(false)
  }

  const uploadFields = [
    ...SCHEMA_FIELDS,
    ...customFields.filter((f) => !SCHEMA_FIELD_KEYS.has(f.field_key)).map((f) => ({ name: f.field_key, label: f.label })),
  ]

  // ── Form field helpers ──────────────────────────────────────────────────────

  const inp = (key: string, label: string, type = 'text') => (
    <Input key={key} label={label} type={type}
      value={formVals[key] ?? ''}
      onChange={(e) => setFormVals((v) => ({ ...v, [key]: e.target.value }))}
    />
  )

  const triSelect = (key: keyof FormBools, label: string) => (
    <label key={key} className="flex flex-col gap-0.5">
      <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">{label}</span>
      <select
        value={formBools[key] == null ? '' : String(formBools[key])}
        onChange={(e) => {
          const val = e.target.value
          setFormBools((b) => ({ ...b, [key]: val === '' ? null : val === 'true' }))
        }}
        className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none"
      >
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </label>
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {/* Contextual filter dropdowns */}
        {!loading && visibleHierarchy.length > 0 && (
          <div className="flex items-end gap-3 flex-wrap">
            {visibleHierarchy.map(({ field, label }, fi) => {
              const hierarchyIdx = LOC_FILTER_HIERARCHY.findIndex(h => h.field === field)
              const above = rowsAbove(hierarchyIdx)
              const opts = Array.from(new Set(above.map(loc => locFieldValue(loc, field)).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              const countFor = (val: string) => above.filter(loc => locFieldValue(loc, field) === val).length
              return (
                <div key={field} className="flex flex-col gap-0.5 min-w-[120px]">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">{label}</span>
                  <select
                    value={dropFilters[field] ?? ''}
                    onChange={e => setDropFilter(field, e.target.value, hierarchyIdx)}
                    className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none max-w-[160px]"
                  >
                    <option value="">All</option>
                    {opts.map(val => <option key={val} value={val}>{val} ({countFor(val)})</option>)}
                  </select>
                </div>
              )
            })}
            <div className="flex items-end gap-2 ml-auto pb-0.5">
              {hasActiveFilters && (
                <button onClick={() => setDropFilters({})} className="text-xs font-mono text-inky/60 hover:text-navy underline whitespace-nowrap">
                  Clear Filters
                </button>
              )}
              <div className="relative" ref={dropSettingsRef}>
                <Button size="sm" variant="secondary" onClick={() => setDropSettingsOpen(o => !o)}>Dropdowns ▾</Button>
                {dropSettingsOpen && (
                  <div className="absolute top-full right-0 mt-1 z-30 bg-cream dark:bg-[#0e2638] border border-navy/30 rounded shadow-xl p-3 min-w-[190px] flex flex-col gap-1.5">
                    <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Toggle visible dropdowns</p>
                    {LOC_FILTER_HIERARCHY.map(({ field, label }) => (
                      <label key={field} className="flex items-center gap-2 cursor-pointer text-xs font-body text-navy">
                        <input type="checkbox" checked={!hiddenDropdowns.has(field)} className="accent-sky"
                          onChange={e => {
                            setHiddenDropdowns(prev => {
                              const next = new Set(prev)
                              if (e.target.checked) next.delete(field)
                              else next.add(field)
                              return next
                            })
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename="locations.csv"
          loading={loading}
          actions={
            <>
              <ClearTableButton clearAll={clearAll} />
              <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
              <Button size="sm" onClick={openAdd}>+ Add Location</Button>
            </>
          }
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={confirmImport} importing={importing} onAddColumn={(label) => addField({ label })} storageKey="locations" />
        </div>
        <DataSourceLinker configType="locations" />
      </div>

      <div className="border-t border-navy/10 pt-4">
        <LocationDataSourceConfig />
      </div>

      {/* ── Add / Edit modal ─────────────────────────────────────────────── */}
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Location' : 'Add Location'} size="xl">
        <div className="flex flex-col gap-3">
          {/* Tab nav */}
          <div className="flex gap-0 border-b border-navy/10 -mx-1 mb-1 overflow-x-auto">
            {FORM_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setFormTab(t)}
                className={`px-3 py-2 text-xs font-mono whitespace-nowrap transition-colors border-b-2 ${
                  formTab === t
                    ? 'border-navy text-navy font-bold'
                    : 'border-transparent text-inky/60 hover:text-navy'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Tab: Identity ─────────────────────────────────────────────── */}
          {formTab === 'Identity' && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                {inp('name',      'Name (Code) *')}
                {inp('shop_city', 'Shop # / City *')}
                {inp('region',    'Region')}
                {inp('status',    'Status (Active / Inactive)')}
              </div>
              <Toggle checked={formBools.active} onChange={(val) => setFormBools((b) => ({ ...b, active: val }))} label="Active location" color="green" />
              {customFields.length > 0 && (
                <div className="border-t border-navy/10 pt-3">
                  <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Custom Fields</p>
                  <div className="grid grid-cols-2 gap-3">
                    {customFields.map((f) => (
                      <Input key={f.id} label={f.label}
                        type={f.field_type === 'date' ? 'date' : 'text'}
                        value={customVals[f.field_key] ?? ''}
                        onChange={(e) => setCustomVals({ ...customVals, [f.field_key]: e.target.value })}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab: Contact & People ─────────────────────────────────────── */}
          {formTab === 'Contact & People' && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Area Manager</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('area_manager', 'Area Manager')}
                  {inp('am_phone',     'AM Phone')}
                  {inp('am_email',     'AM Email')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Regional Director</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('director',  'Regional Director')}
                  {inp('rd_email',  'RD Email')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Marketing & HR</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('marketing_manager', 'Marketing Manager')}
                  {inp('mm_email',          'MM Email')}
                  {inp('mm_cell',           'MM Cell')}
                  {inp('hrbp',              'HRBP')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Store Contact</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('store_phone', 'Store Phone')}
                  {inp('store_email', 'Store Email')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Address</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('address', 'Street Address')}
                  {inp('city',    'City')}
                  {inp('state',   'State')}
                  {inp('county',  'County')}
                  {inp('zip',     'Zip')}
                  {inp('location','Location')}
                </div>
              </div>
            </div>
          )}

          {/* Tab: Operations ────────────────────────────────────────────── */}
          {formTab === 'Operations' && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                {inp('owner',            'Owner')}
                {inp('market',           'Market')}
                {inp('num_bays',         '# of Bays',         'number')}
                {inp('pit_type',         'Pit Type')}
                {inp('store_type',       'Store Type')}
                {inp('classification',   'Classification')}
                {inp('groups',           'Groups')}
                {inp('entity_name',      'Entity Name')}
                {inp('brand_used',       'Brand Used')}
                {inp('developer',        'Developer')}
                {inp('landlord',         'Landlord')}
                {inp('num_days_open',    '# Days Open',        'number')}
                {inp('manager_workweek', 'Manager Workweek')}
                {triSelect('second_asm_approved', '2nd ASM Approved')}
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Key Dates</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('date_opened',          'Date Opened',          'date')}
                  {inp('acquisition_date',     'Acquisition Date',     'date')}
                  {inp('year_opened',          'Year Opened',          'number')}
                  {inp('droptop_go_live',      'Droptop Go-Live',      'date')}
                  {inp('last_price_change',    'Last Price Change',    'date')}
                  {inp('review_pricing_date',  'Review Pricing Date',  'date')}
                  {inp('last_day_of_business', 'Last Day of Business', 'date')}
                </div>
              </div>
            </div>
          )}

          {/* Tab: Pricing & Financial ───────────────────────────────────── */}
          {formTab === 'Pricing & Financial' && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Rates & Fees</p>
                <div className="grid grid-cols-3 gap-3">
                  {inp('royalty_rate',            'Royalty Rate',             'number')}
                  {inp('local_ad_percent',         'Local Ad %',               'number')}
                  {inp('local_ad_dollar',          'Local Ad $',               'number')}
                  {inp('brand_fund',               'Brand Fund',               'number')}
                  {inp('technology_fee',           'Technology Fee',           'number')}
                  {inp('supply_fee',               'Supply Fee',               'number')}
                  {inp('disposal_fee',             'Disposal Fee',             'number')}
                  {inp('oil_inflation_surcharge',  'Oil Inflation Surcharge',  'number')}
                  {inp('sales_quartile',           'Sales Quartile')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Oil Prices</p>
                <div className="grid grid-cols-3 gap-3">
                  {inp('economy',                   'Economy',                   'number')}
                  {inp('premium_hm',                'Premium HM',                'number')}
                  {inp('premium_full_synthetic',    'Premium Full Synthetic',    'number')}
                  {inp('premium_full_synthetic_hm', 'Premium Full Syn HM',       'number')}
                  {inp('rp',                        'RP',                        'number')}
                  {inp('diesel_syn_blend',          'Diesel Syn Blend',          'number')}
                  {inp('diesel_full_syn',           'Diesel Full Syn',           'number')}
                  {inp('european',                  'European',                  'number')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Planning</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('planned_2023', 'Planned 2023', 'number')}
                  {inp('planned_2024', 'Planned 2024', 'number')}
                </div>
              </div>
            </div>
          )}

          {/* Tab: Hours & Services ──────────────────────────────────────── */}
          {formTab === 'Hours & Services' && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Store Hours</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('monday_hours',    'Monday')}
                  {inp('tuesday_hours',   'Tuesday')}
                  {inp('wednesday_hours', 'Wednesday')}
                  {inp('thursday_hours',  'Thursday')}
                  {inp('friday_hours',    'Friday')}
                  {inp('saturday_hours',  'Saturday')}
                  {inp('sunday_hours',    'Sunday')}
                  {inp('holiday_hours',   'Holiday Hours')}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Services Offered</p>
                <div className="grid grid-cols-3 gap-3">
                  {triSelect('tire_rotations',        'Tire Rotations')}
                  {triSelect('safety_inspections',    'Safety Inspections')}
                  {triSelect('emissions_inspections', 'Emissions Inspections')}
                </div>
              </div>
            </div>
          )}

          {/* Tab: Integrations ──────────────────────────────────────────── */}
          {formTab === 'Integrations' && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                {inp('valvoline_account_num',      'Valvoline Account #')}
                {inp('ai_shop_id',                 'AI Shop ID')}
                {inp('ai_username',                'AI Username')}
                {inp('ai_call_center',             'AI Call Center')}
                {inp('ai_call_center_phone',       'AI Call Center Phone')}
                {inp('partnerconnect_username',    'PartnerConnect Username')}
                {inp('google_review_url',          'Google Review URL')}
                {inp('google_review_qr_code',      'Google Review QR Code')}
                {inp('training_shops',             'Training Shops')}
                {inp('integration_manager_region', 'Integration Mgr Region')}
                {inp('opus_serial_primary',        'Opus Serial (Primary)')}
                {inp('opus_serial_secondary',      'Opus Serial (Secondary)')}
                {inp('former_fz_store_num',        'Former FZ Store #')}
                {inp('tmcw_ql',                    'TMCW QL')}
                {inp('am_data_map',                'AM Data Map')}
                {inp('rd_data_map',                'RD Data Map')}
                {inp('droptop_num',                'Droptop #')}
                {inp('droptop_operation_id',       'Droptop Operation ID')}
                {inp('reladyne_delivery_day',      'Reladyne Delivery Day')}
                {inp('mighty_fz',                  'Mighty FZ')}
                {inp('camera_system',              'Camera System')}
                {inp('inspection_station_id',      'Inspection Station ID')}
                {triSelect('mighty_po_upload',     'Mighty PO Upload')}
              </div>
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-2">Coordinates</p>
                <div className="grid grid-cols-2 gap-3">
                  {inp('latitude',  'Latitude',  'number')}
                  {inp('longitude', 'Longitude', 'number')}
                </div>
              </div>
            </div>
          )}

          {/* Form actions */}
          <div className="flex justify-between gap-2 pt-3 border-t border-navy/10 mt-1">
            <div>
              {editId && <Button variant="danger" size="sm" type="button" onClick={onDelete}>Delete</Button>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!formVals.name.trim() || !formVals.shop_city.trim()}>
                {editId ? 'Save Changes' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* ── Manage custom columns ────────────────────────────────────────── */}
      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Location Columns" size="lg">
        <CustomFieldsEditor section="locations" recommended={RECOMMENDED} />
      </Modal>
    </div>
  )
}
