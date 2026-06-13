-- Distinguish app-created orders from imported (external) order history.
alter table order_sessions add column if not exists source text not null default 'app';
-- allow 'pending'/'fulfilled' already; imported orders use status 'fulfilled'.
