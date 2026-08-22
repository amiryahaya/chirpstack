pub mod email;
pub mod state;

use tokio::time::sleep;
use tracing::{error, info, trace};
use uuid::Uuid;

use crate::config;
use crate::storage::{alert_event, device, fields, gateway, tenant};
use email::EntityKind;
use state::{AlertState, Transition, evaluate};

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
                if let Err(e) = gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await {
                    error!(gateway_id = %c.gateway_id, error = %e, "Recording inactivity alert state for gateway failed");
                }
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                match tenant::get(&c.tenant_id.into()).await {
                    Ok(t) => {
                        let email_sent = email::send_transition_email(
                            &t,
                            EntityKind::Gateway,
                            &c.name,
                            went_inactive,
                        )
                        .await;
                        if let Err(e) = alert_event::insert(alert_event::AlertEvent {
                            id: fields::Uuid::from(Uuid::new_v4()),
                            entity_type: alert_event::ENTITY_TYPE_GATEWAY,
                            entity_id: c.gateway_id,
                            tenant_id: c.tenant_id,
                            previous_state: previous.to_i16(),
                            new_state: new_state.to_i16(),
                            created_at: chrono::Utc::now(),
                            email_sent,
                        })
                        .await
                        {
                            error!(gateway_id = %c.gateway_id, error = %e, "Inserting inactivity alert event for gateway failed");
                            continue;
                        }
                        if let Err(e) =
                            gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await
                        {
                            error!(gateway_id = %c.gateway_id, error = %e, "Recording inactivity alert state for gateway failed");
                        }
                    }
                    Err(e) => {
                        // Do not advance alert_state: without the tenant we can neither send the
                        // transition email nor write the alert_event audit row, so leaving the
                        // stored state behind lets this transition be retried next scan cycle
                        // instead of being silently and permanently lost.
                        error!(gateway_id = %c.gateway_id, tenant_id = %c.tenant_id, error = %e, "Looking up tenant for gateway inactivity alert failed");
                    }
                }
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
                if let Err(e) = device::set_alert_state(&c.dev_eui, new_state.to_i16()).await {
                    error!(dev_eui = %c.dev_eui, error = %e, "Recording inactivity alert state for device failed");
                }
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                match tenant::get(&c.tenant_id.into()).await {
                    Ok(t) => {
                        let email_sent = email::send_transition_email(
                            &t,
                            EntityKind::Device,
                            &c.name,
                            went_inactive,
                        )
                        .await;
                        if let Err(e) = alert_event::insert(alert_event::AlertEvent {
                            id: fields::Uuid::from(Uuid::new_v4()),
                            entity_type: alert_event::ENTITY_TYPE_DEVICE,
                            entity_id: c.dev_eui,
                            tenant_id: c.tenant_id,
                            previous_state: previous.to_i16(),
                            new_state: new_state.to_i16(),
                            created_at: chrono::Utc::now(),
                            email_sent,
                        })
                        .await
                        {
                            error!(dev_eui = %c.dev_eui, error = %e, "Inserting inactivity alert event for device failed");
                            continue;
                        }
                        if let Err(e) =
                            device::set_alert_state(&c.dev_eui, new_state.to_i16()).await
                        {
                            error!(dev_eui = %c.dev_eui, error = %e, "Recording inactivity alert state for device failed");
                        }
                    }
                    Err(e) => {
                        // Do not advance alert_state: without the tenant we can neither send the
                        // transition email nor write the alert_event audit row, so leaving the
                        // stored state behind lets this transition be retried next scan cycle
                        // instead of being silently and permanently lost.
                        error!(dev_eui = %c.dev_eui, tenant_id = %c.tenant_id, error = %e, "Looking up tenant for device inactivity alert failed");
                    }
                }
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

    #[tokio::test]
    async fn test_scan_gateways_went_inactive_records_email_sent_false_on_send_failure() {
        let _guard = test::prepare().await;

        // A tenant with a deliverable address configured, but pointed at an SMTP relay that
        // cannot be reached. This asserts that email_sent reflects actual send success, not
        // merely that addresses were configured (the bug fixed alongside deliverable_addresses).
        let t = storage::tenant::Tenant {
            id: fields::Uuid::from(Uuid::new_v4()),
            name: "test t2".into(),
            can_have_gateways: true,
            max_gateway_count: 10,
            max_device_count: 20,
            alert_email_addresses: storage::fields::StringVec::new(vec![Some(
                "a@example.com".into(),
            )]),
            alert_smtp_host: "127.0.0.1".into(),
            alert_smtp_port: 1,
            alert_smtp_use_tls: false,
            alert_smtp_from_email: "alerts@example.com".into(),
            ..Default::default()
        };
        let t = storage::tenant::create(t).await.unwrap();

        let gw = gateway::create(gateway::Gateway {
            gateway_id: lrwn::EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 9]),
            tenant_id: t.id,
            name: "test-gw-2".into(),
            alert_enabled: true,
            stats_interval_secs: 30,
            last_seen_at: Some(chrono::Utc::now() - Duration::seconds(600)),
            ..Default::default()
        })
        .await
        .unwrap();
        // Seed alert_state as Active (1) so the scan (with an already-expired last_seen_at)
        // produces a WentInactive transition instead of the first-observation RecordOnly path.
        gateway::set_alert_state(&gw.gateway_id, 1).await.unwrap();

        scan_gateways().await.unwrap();

        let gw_get = gateway::get(&gw.gateway_id).await.unwrap();
        assert_eq!(2, gw_get.alert_state);

        let events = storage::alert_event::test::list_for_entity(gw.gateway_id).await;
        assert_eq!(1, events.len());
        assert!(
            !events[0].email_sent,
            "email_sent must be false when the SMTP send failed, even though addresses were configured"
        );
    }
}
