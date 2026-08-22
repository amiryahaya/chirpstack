alter table tenant add column alert_smtp_host text not null default '';
alter table tenant add column alert_smtp_port integer not null default 587;
alter table tenant add column alert_smtp_username text not null default '';
alter table tenant add column alert_smtp_password text not null default '';
alter table tenant add column alert_smtp_from_email text not null default '';
alter table tenant add column alert_smtp_use_tls boolean not null default true;
alter table tenant add column alert_email_addresses text not null default '[]';
