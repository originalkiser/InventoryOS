-- End Day feature: track how many times a task has been pushed to the next day.
alter table project_tasks add column if not exists times_pushed int not null default 0;
