-- Seed a schedule row (Config -> Data Connections) for the new
-- monday-sync-locations edge function, same as every other connection.
-- Off by default -- an admin turns it on once the mapping's been spot-
-- checked against a real run.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT company_id, 'monday_locations', 'interval', 1440
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
