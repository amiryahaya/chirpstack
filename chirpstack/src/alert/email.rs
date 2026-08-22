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

    let mailer: AsyncSmtpTransport<Tokio1Executor> = if tenant.alert_smtp_use_tls {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&tenant.alert_smtp_host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&tenant.alert_smtp_host)
    }
    .port(tenant.alert_smtp_port as u16)
    .credentials(creds)
    .build();

    info!(tenant_id = %tenant.id, host = %tenant.alert_smtp_host, "Sending alert email");
    mailer.send(message).await.map(|_| ()).context("send email")
}

pub async fn send_transition_email(
    tenant: &Tenant,
    kind: EntityKind,
    entity_name: &str,
    went_inactive: bool,
) {
    for addr in tenant.alert_email_addresses.iter().flatten() {
        let subject = subject_for(&tenant.name, kind, entity_name, went_inactive);
        let body = body_for(&tenant.name, kind, entity_name, went_inactive);

        match build_message(tenant, addr, subject, body) {
            Ok(msg) => {
                if let Err(e) = send(tenant, msg).await {
                    warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Sending alert email failed");
                }
            }
            Err(e) => {
                warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Building alert email failed");
            }
        }
    }
}

pub async fn send_test_email(tenant: &Tenant) -> Result<()> {
    if tenant.alert_email_addresses.is_empty() {
        anyhow::bail!("no alert email addresses configured for this tenant");
    }

    for addr in tenant.alert_email_addresses.iter().flatten() {
        let subject = format!("[{}] ChirpStack alert test email", tenant.name);
        let body = "This is a test email from ChirpStack to verify your inactivity alert SMTP settings.".to_string();
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
}
