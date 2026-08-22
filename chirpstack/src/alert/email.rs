use anyhow::{Context, Result};
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tracing::{info, warn};

use crate::storage::tenant::Tenant;

#[derive(Debug, Clone, Copy)]
pub enum EntityKind {
    Gateway,
    Device,
}

impl EntityKind {
    fn label(&self) -> &'static str {
        match self {
            EntityKind::Gateway => "Gateway",
            EntityKind::Device => "Device",
        }
    }
}

pub fn subject_for(
    tenant_name: &str,
    kind: EntityKind,
    entity_name: &str,
    went_inactive: bool,
) -> String {
    if went_inactive {
        format!(
            "[{}] {} '{}' went inactive",
            tenant_name,
            kind.label(),
            entity_name
        )
    } else {
        format!(
            "[{}] {} '{}' is active again",
            tenant_name,
            kind.label(),
            entity_name
        )
    }
}

pub fn body_for(
    tenant_name: &str,
    kind: EntityKind,
    entity_name: &str,
    went_inactive: bool,
) -> String {
    if went_inactive {
        format!(
            "{} '{}' in tenant '{}' has gone inactive.",
            kind.label(),
            entity_name,
            tenant_name
        )
    } else {
        format!(
            "{} '{}' in tenant '{}' is active again.",
            kind.label(),
            entity_name,
            tenant_name
        )
    }
}

// deliverable_addresses returns the tenant's configured alert email addresses with blank
// (empty or whitespace-only) entries filtered out. This is the single definition of "does
// this tenant have a usable alert email address" -- used both to decide whether sending is
// worth attempting and to drive the actual send loops.
pub fn deliverable_addresses(tenant: &Tenant) -> Vec<&str> {
    tenant
        .alert_email_addresses
        .iter()
        .flatten()
        .map(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .collect()
}

fn build_message(tenant: &Tenant, to: &str, subject: String, body: String) -> Result<Message> {
    Message::builder()
        .from(
            tenant
                .alert_smtp_from_email
                .parse()
                .context("parse from address")?,
        )
        .to(to.parse().context("parse to address")?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .context("build email message")
}

async fn send(tenant: &Tenant, message: Message) -> Result<()> {
    let creds = Credentials::new(
        tenant.alert_smtp_username.clone(),
        tenant.alert_smtp_password.clone(),
    );

    let mailer: AsyncSmtpTransport<Tokio1Executor> = if !tenant.alert_smtp_use_tls {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&tenant.alert_smtp_host)
    } else if tenant.alert_smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&tenant.alert_smtp_host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&tenant.alert_smtp_host)?
    }
    .port(tenant.alert_smtp_port as u16)
    .credentials(creds)
    .build();

    info!(tenant_id = %tenant.id, host = %tenant.alert_smtp_host, "Sending alert email");
    mailer.send(message).await.map(|_| ()).context("send email")
}

// send_transition_email attempts to send the transition email to every deliverable address
// configured for the tenant, logging (and continuing past) per-recipient failures. It
// returns true if at least one recipient was actually sent to successfully, so callers can
// use it to record whether an email was truly sent (rather than merely attempted).
pub async fn send_transition_email(
    tenant: &Tenant,
    kind: EntityKind,
    entity_name: &str,
    went_inactive: bool,
) -> bool {
    let mut any_sent = false;

    for addr in deliverable_addresses(tenant) {
        let subject = subject_for(&tenant.name, kind, entity_name, went_inactive);
        let body = body_for(&tenant.name, kind, entity_name, went_inactive);

        match build_message(tenant, addr, subject, body) {
            Ok(msg) => match send(tenant, msg).await {
                Ok(_) => any_sent = true,
                Err(e) => {
                    warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Sending alert email failed");
                }
            },
            Err(e) => {
                warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Building alert email failed");
            }
        }
    }

    any_sent
}

pub async fn send_test_email(tenant: &Tenant) -> Result<()> {
    let addresses = deliverable_addresses(tenant);
    if addresses.is_empty() {
        anyhow::bail!("no alert email addresses configured for this tenant");
    }

    for addr in addresses {
        let subject = format!("[{}] ChirpStack alert test email", tenant.name);
        let body =
            "This is a test email from ChirpStack to verify your inactivity alert SMTP settings."
                .to_string();
        let msg = build_message(tenant, addr, subject, body)?;
        send(tenant, msg).await?;
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_subject_for() {
        assert_eq!(
            "[Acme] Gateway 'gw-01' went inactive",
            subject_for("Acme", EntityKind::Gateway, "gw-01", true)
        );
        assert_eq!(
            "[Acme] Device 'sensor-1' is active again",
            subject_for("Acme", EntityKind::Device, "sensor-1", false)
        );
    }

    #[test]
    fn test_body_for() {
        assert_eq!(
            "Gateway 'gw-01' in tenant 'Acme' has gone inactive.",
            body_for("Acme", EntityKind::Gateway, "gw-01", true)
        );
        assert_eq!(
            "Device 'sensor-1' in tenant 'Acme' is active again.",
            body_for("Acme", EntityKind::Device, "sensor-1", false)
        );
    }

    #[test]
    fn test_deliverable_addresses_filters_blanks() {
        let mut tenant = Tenant::default();

        tenant.alert_email_addresses = crate::storage::fields::StringVec::new(vec![]);
        assert!(deliverable_addresses(&tenant).is_empty());

        tenant.alert_email_addresses = crate::storage::fields::StringVec::new(vec![
            Some("".to_string()),
            Some("   ".to_string()),
        ]);
        assert!(
            deliverable_addresses(&tenant).is_empty(),
            "blank and whitespace-only entries must be filtered out"
        );

        tenant.alert_email_addresses = crate::storage::fields::StringVec::new(vec![
            Some("".to_string()),
            Some("a@example.com".to_string()),
            Some("   ".to_string()),
            Some("b@example.com".to_string()),
            None,
        ]);
        assert_eq!(
            vec!["a@example.com", "b@example.com"],
            deliverable_addresses(&tenant)
        );
    }
}
