create table alert_event (
    id text primary key,
    entity_type smallint not null,
    entity_id blob not null,
    tenant_id text not null references tenant on delete cascade,
    previous_state smallint not null,
    new_state smallint not null,
    created_at datetime not null,
    email_sent boolean not null
);

create index idx_alert_event_tenant_id on alert_event (tenant_id);
create index idx_alert_event_entity_id on alert_event (entity_id);
