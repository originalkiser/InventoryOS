-- Direct feedback 2026-09-25: a per-alert email workflow mirroring Tank
-- Monitors' own offline/low-VMI email flow — step through late-PO alerts
-- one shop at a time with a copyable email, and 4 actions per alert: Log
-- Exception (creates a real inventory.exception_reports row and links back
-- via exception_report_id), Skip (no write), Exclude (excluded=true, hides
-- it from the default view without deleting/closing it), or Close (No
-- Receipt) (status='Closed' with a stamped reason in notes).
ALTER TABLE inventory.po_receipt_alerts
  ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exception_report_id uuid,
  ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
