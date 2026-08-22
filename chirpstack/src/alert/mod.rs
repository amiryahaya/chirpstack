pub mod email;
pub mod state;

use tokio::time::sleep;
use tracing::{error, info, trace};
use uuid::Uuid;

use crate::config;
use crate::storage::{alert_event, device, fields, gateway, tenant};
use email::EntityKind;
use state::{evaluate, AlertState, Transition};

pub async fn setup() {
    info!("Setting up inactivity alert reaper loop");
    tokio::spawn(async move {
        reaper_loop().await;
    });
}

async fn reaper_loop() {
    let conf = config::get();

    loop {
        trace!("Starting inactivity alert scan");

        if let Err(err) = scan_gateways().await {
            error!(error = %err, "Scanning gateways for inactivity alerts failed");
        }
        if let Err(err) = scan_devices().await {
            error!(error = %err, "Scanning devices for inactivity alerts failed");
        }

        sleep(conf.monitoring.alert_interval).await;
    }
}

pub async fn scan_gateways() -> anyhow::Result<()> {
    let candidates = gateway::get_alert_candidates().await?;

    for c in candidates {
        let previous = AlertState::from_i16(c.alert_state);
        let (new_state, transition) = evaluate(previous, c.is_inactive);

        match transition {
            Transition::None => continue,
            Transition::RecordOnly => {
                gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await?;
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                if let Ok(t) = tenant::get(&c.tenant_id.into()).await {
                    let email_sent = !t.alert_email_addresses.is_empty();
                    if email_sent {
                        email::send_transition_email(&t, EntityKind::Gateway, &c.name, went_inactive)
                            .await;
                    }
                    alert_event::insert(alert_event::AlertEvent {
                        id: fields::Uuid::from(Uuid::new_v4()),
                        entity_type: alert_event::ENTITY_TYPE_GATEWAY,
                        entity_id: c.gateway_id,
                        tenant_id: c.tenant_id,
                        previous_state: previous.to_i16(),
                        new_state: new_state.to_i16(),
                        created_at: chrono::Utc::now(),
                        email_sent,
                    })
                    .await?;
                }
                gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await?;
            }
        }
    }

    Ok(())
}

pub async fn scan_devices() -> anyhow::Result<()> {
    let candidates = device::get_alert_candidates().await?;

    for c in candidates {
        let previous = AlertState::from_i16(c.alert_state);
        let (new_state, transition) = evaluate(previous, c.is_inactive);

        match transition {
            Transition::None => continue,
            Transition::RecordOnly => {
                device::set_alert_state(&c.dev_eui, new_state.to_i16()).await?;
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                if let Ok(t) = tenant::get(&c.tenant_id.into()).await {
                    let email_sent = !t.alert_email_addresses.is_empty();
                    if email_sent {
                        email::send_transition_email(&t, EntityKind::Device, &c.name, went_inactive)
                            .await;
                    }
                    alert_event::insert(alert_event::AlertEvent {
                        id: fields::Uuid::from(Uuid::new_v4()),
                        entity_type: alert_event::ENTITY_TYPE_DEVICE,
                        entity_id: c.dev_eui,
                        tenant_id: c.tenant_id,
                        previous_state: previous.to_i16(),
                        new_state: new_state.to_i16(),
                        created_at: chrono::Utc::now(),
                        email_sent,
                    })
                    .await?;
                }
                device::set_alert_state(&c.dev_eui, new_state.to_i16()).await?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod test {
    use chrono::Duration;

    use super::*;
    use crate::storage::{self, gateway};
    use crate::test;

    #[tokio::test]
    async fn test_scan_gateways_records_first_observation_without_email() {
        let _guard = test::prepare().await;
        let t = storage::tenant::test::create_tenant().await; // alert_email_addresses is empty by default

        let gw = gateway::create(gateway::Gateway {
            gateway_id: lrwn::EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
            tenant_id: t.id,
            name: "test-gw".into(),
            alert_enabled: true,
            stats_interval_secs: 30,
            last_seen_at: Some(chrono::Utc::now() - Duration::seconds(600)),
            ..Default::default()
        })
        .await
        .unwrap();

        scan_gateways().await.unwrap();

        let gw_get = gateway::get(&gw.gateway_id).await.unwrap();
        // First observation: alert_state moves from 0 (unknown) straight to 2 (inactive),
        // recorded silently -- no email possible anyway since the tenant has no addresses.
        assert_eq!(2, gw_get.alert_state);
    }
}
