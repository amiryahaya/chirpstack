alter table device add column alert_enabled boolean not null default true;
alter table device add column alert_state smallint not null default 0;
