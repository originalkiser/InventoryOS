// Canonical list of Global Config location fields (base columns on
// core.locations). Shared by the Global Config Locations tab and the
// read-only Quick Access Locations page so the two never drift.
export interface LocationField {
  name: string
  label: string
  required?: boolean
}

export const LOCATION_FIELDS: LocationField[] = [
  // identity
  { name: 'name',         label: 'Code',             required: true },
  { name: 'shop_city',    label: 'Shop # / City',    required: true },
  { name: 'region',       label: 'Region' },
  { name: 'status',       label: 'Status' },
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

export const LOCATION_FIELD_KEYS = new Set(LOCATION_FIELDS.map((f) => f.name))

// Columns shown by default in the Quick Access read-only view.
export const DEFAULT_VISIBLE_LOCATION_COLUMNS = [
  'name', 'shop_city', 'region', 'owner', 'market', 'area_manager', 'director', 'active', 'updated_at',
]
