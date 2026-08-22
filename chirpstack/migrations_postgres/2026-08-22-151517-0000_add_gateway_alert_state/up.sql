alter table gateway add column alert_enabled boolean not null default true;
alter table gateway add column alert_state smallint not null default 0;
