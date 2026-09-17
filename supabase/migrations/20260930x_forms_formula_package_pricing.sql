-- Form Builder overhaul (2026-09-16 request): general calculating field
-- ('formula') and a purpose-built repeating "Package Pricing" field for
-- acquisition pricing worksheets ('package_pricing'). Neither reuses the
-- existing 'calculation' type, which is a narrower, already-load-bearing
-- feature (the blanket score/streak total computed in FormCanvas's
-- calcScore() — see that function's own comment) that a general arithmetic
-- field must not risk changing the behavior of.
ALTER TABLE forms.fields DROP CONSTRAINT fields_field_type_check;
ALTER TABLE forms.fields ADD CONSTRAINT fields_field_type_check
  CHECK (field_type = ANY (ARRAY[
    'text_block', 'short_answer', 'long_answer', 'multiple_choice', 'multi_select',
    'dropdown', 'file_upload', 'date', 'number', 'calculation', 'formula', 'package_pricing'
  ]));

-- A package_pricing field's response is an array of package rows (name,
-- oil type/brand, pricing, tax/filter mode, computed OTD price, penetration
-- % with auto-split bookkeeping) — structurally incompatible with the
-- existing scalar value_text/value_array/value_option_id/value_score
-- columns, which all assume one flat value per (submission, field). A
-- generic jsonb escape hatch here (rather than a dedicated child table)
-- matches how field-side config already leans on jsonb (fields.options,
-- fields.calculation_config) for exactly this kind of structured-but-
-- per-field-type-varying shape, and keeps this addition to one column
-- rather than a new table + RLS policy for what is, for now, a single
-- field type's storage need.
ALTER TABLE forms.responses ADD COLUMN IF NOT EXISTS value_json jsonb;
