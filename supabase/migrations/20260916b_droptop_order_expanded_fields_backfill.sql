-- One-time backfill for 20260916_droptop_order_expanded_fields.sql — every
-- already-synced order's raw_data already carries the full original
-- Droptop payload, so every new column/table here is populated straight
-- from that, with zero re-sync from Droptop needed. Safe to re-run: the
-- header UPDATE is idempotent by nature, and each child-table INSERT is
-- guarded against an order that's already been backfilled.

UPDATE inventory.droptop_orders
SET
  order_opened_at = CASE WHEN (raw_data->>'order_opened') ~ '^\d+(\.\d+)?$'
    THEN to_timestamp((raw_data->>'order_opened')::numeric) END,
  order_sent_to_bay_at = CASE WHEN (raw_data->>'order_sent_to_bay') ~ '^\d+(\.\d+)?$'
    THEN to_timestamp((raw_data->>'order_sent_to_bay')::numeric) END,
  order_service_completed_at = CASE WHEN (raw_data->>'order_service_completed') ~ '^\d+(\.\d+)?$'
    THEN to_timestamp((raw_data->>'order_service_completed')::numeric) END,
  order_last_updated_at = CASE WHEN (raw_data->>'order_last_updated') ~ '^\d+(\.\d+)?$'
    THEN to_timestamp((raw_data->>'order_last_updated')::numeric) END,
  bay_id = NULLIF(raw_data->>'bay_id', ''),
  bay_name = NULLIF(raw_data->>'bay_name', ''),
  order_owner_id = raw_data->'order_owner'->>'user_id',
  order_owner_name = NULLIF(trim(both ' ' from concat_ws(' ',
    raw_data->'order_owner'->>'first_name', raw_data->'order_owner'->>'last_name')), ''),
  order_owner_email = raw_data->'order_owner'->>'email',
  pay_status = raw_data->>'pay_status',
  tax_exempt_total = CASE WHEN (raw_data->>'tax_exempt_total') ~ '^-?\d+(\.\d+)?$'
    THEN (raw_data->>'tax_exempt_total')::numeric END,
  fleet_location_id = raw_data->'fleet_location'->>'fleet_location_id',
  fleet_location_name = raw_data->'fleet_location'->>'name',
  fleet_company_id = raw_data->'fleet_location'->'fleet_company'->>'fleet_company_id',
  fleet_company_name = raw_data->'fleet_location'->'fleet_company'->>'name'
WHERE raw_data IS NOT NULL
  AND order_last_updated_at IS NULL; -- skip rows already backfilled if this is re-run

INSERT INTO inventory.droptop_order_vehicles
  (order_id, company_id, vin, license_plate, vehicle_name, mileage, vin_vehicle_make, vin_vehicle_model, vin_vehicle_year)
SELECT
  o.id, o.company_id,
  v->>'vin', v->>'license_plate', v->>'other_vehicle_name',
  CASE WHEN (v->>'mileage') ~ '^\d+(\.\d+)?$' THEN (v->>'mileage')::numeric END,
  v->>'vin_vehicle_make', v->>'vin_vehicle_model',
  CASE WHEN (v->>'vin_vehicle_year') ~ '^\d+$' THEN (v->>'vin_vehicle_year')::integer END
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'vehicles', '[]'::jsonb)) AS v
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_vehicles x WHERE x.order_id = o.id);

INSERT INTO inventory.droptop_order_servicing_positions
  (order_id, company_id, user_id, user_name, "position", vin, license_plate, vehicle_name)
SELECT
  o.id, o.company_id,
  p->>'user_id', p->>'user_name', p->>'position', p->>'vin', p->>'license_plate', p->>'vehicle_name'
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'servicing_positions', '[]'::jsonb)) AS p
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_servicing_positions x WHERE x.order_id = o.id);

INSERT INTO inventory.droptop_order_payments
  (order_id, company_id, payment_id, payment_type, sub_payment_type, status, final_amount, currency, payment_created_at, payment_updated_at)
SELECT
  o.id, o.company_id,
  pay->>'payment_id', pay->>'payment_type', pay->>'sub_payment_type', pay->>'status',
  CASE WHEN (pay->>'final_amount') ~ '^-?\d+(\.\d+)?$' THEN (pay->>'final_amount')::numeric END,
  pay->>'currency',
  CASE WHEN (pay->>'created_timestamp') ~ '^\d+(\.\d+)?$' THEN to_timestamp((pay->>'created_timestamp')::numeric) END,
  CASE WHEN (pay->>'last_updated_timestamp') ~ '^\d+(\.\d+)?$' THEN to_timestamp((pay->>'last_updated_timestamp')::numeric) END
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'payments', '[]'::jsonb)) AS pay
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_payments x WHERE x.order_id = o.id);

INSERT INTO inventory.droptop_order_taxes
  (order_id, company_id, name, amount, percentage, taxed_subtotal)
SELECT
  o.id, o.company_id,
  t->>'name',
  CASE WHEN (t->>'amount') ~ '^-?\d+(\.\d+)?$' THEN (t->>'amount')::numeric END,
  CASE WHEN (t->>'percentage') ~ '^-?\d+(\.\d+)?$' THEN (t->>'percentage')::numeric END,
  CASE WHEN (t->>'taxed_subtotal') ~ '^-?\d+(\.\d+)?$' THEN (t->>'taxed_subtotal')::numeric END
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'taxes', '[]'::jsonb)) AS t
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_taxes x WHERE x.order_id = o.id);

INSERT INTO inventory.droptop_order_declined_items (order_id, company_id, item_type, raw_data)
SELECT o.id, o.company_id, 'package', pkg
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'declined_items'->'packages', '[]'::jsonb)) AS pkg
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_declined_items x WHERE x.order_id = o.id AND x.item_type = 'package')
UNION ALL
SELECT o.id, o.company_id, 'service', svc
FROM inventory.droptop_orders o, jsonb_array_elements(coalesce(o.raw_data->'declined_items'->'services', '[]'::jsonb)) AS svc
WHERE o.raw_data IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory.droptop_order_declined_items x WHERE x.order_id = o.id AND x.item_type = 'service');
