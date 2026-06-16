-- Link tasks to an open project
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

-- Order date + expected delivery per line item
ALTER TABLE order_line_items
  ADD COLUMN IF NOT EXISTS order_date date,
  ADD COLUMN IF NOT EXISTS expected_delivery date;
