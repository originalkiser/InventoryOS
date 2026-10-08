-- Orders v2: per-vendor order timing. For shops on a Week A/B (or other non-weekly) delivery schedule, an order placed today is only needed
-- when waiting until the next order day would push the shop's delivery to a LATER delivery date than ordering now gets it. With
-- hold_until_needed on, the other shops are held until a later order instead of ordering for every shop every time.
--   order_timing_vendors: vendor_id -> { hold_until_needed: boolean, cadence_days: number }   (cadence_days = days between this vendor's orders)
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS order_timing_vendors jsonb NOT NULL DEFAULT '{}'::jsonb;
