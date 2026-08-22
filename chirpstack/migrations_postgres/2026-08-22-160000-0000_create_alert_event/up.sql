create table alert_event (
    id uuid primary key,
    entity_type smallint not null,
    entity_id bytea not null,
    tenant_id uuid not null references tenant on delete cascade,
    previous_state smallint not null,
    new_state smallint not null,
    created_at timestamp with time zone not null,
    email_sent boolean not null
);

create index idx_alert_event_tenant_id on alert_event (tenant_id);
create index idx_alert_event_entity_id on alert_event (entity_id);
