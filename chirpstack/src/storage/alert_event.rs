use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use lrwn::EUI64;

use super::error::Error;
use super::schema::alert_event;
use super::{fields, get_async_db_conn};

#[derive(Queryable, Insertable, PartialEq, Eq, Debug, Clone)]
#[diesel(table_name = alert_event)]
pub struct AlertEvent {
    pub id: fields::Uuid,
    pub entity_type: i16,
    pub entity_id: EUI64,
    pub tenant_id: fields::Uuid,
    pub previous_state: i16,
    pub new_state: i16,
    pub created_at: DateTime<Utc>,
    pub email_sent: bool,
}

pub const ENTITY_TYPE_GATEWAY: i16 = 0;
pub const ENTITY_TYPE_DEVICE: i16 = 1;

pub async fn insert(ae: AlertEvent) -> Result<AlertEvent, Error> {
    diesel::insert_into(alert_event::table)
        .values(&ae)
        .get_result(&mut get_async_db_conn().await?)
        .await
        .map_err(|e| Error::from_diesel(e, ae.id.to_string()))
}

#[cfg(test)]
pub mod test {
    use uuid::Uuid;

    use super::*;
    use crate::storage;
    use crate::test;

    pub async fn list_for_entity(entity_id: EUI64) -> Vec<AlertEvent> {
        alert_event::table
            .filter(alert_event::entity_id.eq(&entity_id))
            .load(&mut get_async_db_conn().await.unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn test_insert() {
        let _guard = test::prepare().await;

        let tenant_id = {
            let t = storage::tenant::test::create_tenant().await;
            t.id
        };

        let ae = AlertEvent {
            id: fields::Uuid::from(Uuid::new_v4()),
            entity_type: ENTITY_TYPE_GATEWAY,
            entity_id: EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
            tenant_id,
            previous_state: 1,
            new_state: 2,
            created_at: Utc::now(),
            email_sent: true,
        };
        let inserted = insert(ae.clone()).await.unwrap();
        assert_eq!(ae.id, inserted.id);
        assert_eq!(ae.entity_type, inserted.entity_type);
        assert_eq!(ae.new_state, inserted.new_state);
    }
}
