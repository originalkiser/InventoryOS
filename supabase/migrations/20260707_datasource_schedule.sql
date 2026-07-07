-- Add schedule_cron column to data_source_links for timed fetch scheduling
alter table inventory.data_source_links
  add column if not exists schedule_cron text;
