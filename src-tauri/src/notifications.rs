// AI(터미널 Claude) 작업 완료 시 외부 알림 — Slack 웹훅 / SMTP 이메일.
// 프론트의 working→done 엣지(agent-notify.ts)가 notify_external을 호출하면, 설정에 켜진
// 채널로 팬아웃한다. 시크릿(웹훅 URL·SMTP 비번)은 settings.json에 두지 않고 OS 키링에 저장한다.
use tauri::State;

use crate::error::{ErrorCode, IpcError};
use crate::git::types::Settings;
use crate::state::AppState;

const KEYRING_SERVICE: &str = "gitpervisor-notify";

fn err(m: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::Io, m)
}

fn keyring_entry(account: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, account).ok()
}

fn get_secret(account: &str) -> Option<String> {
    keyring_entry(account).and_then(|e| e.get_password().ok())
}

/// 시크릿 종류 → 키링 계정명. 알 수 없는 종류는 거부.
fn secret_account(kind: &str) -> Result<&'static str, IpcError> {
    match kind {
        "slack" => Ok("slack-webhook"),
        "smtp" => Ok("smtp-password"),
        _ => Err(err("알 수 없는 시크릿 종류입니다")),
    }
}

/// 외부 알림 시크릿 저장/제거 — 빈 값이면 제거. 평문은 settings.json에 남기지 않는다.
#[tauri::command]
pub fn notify_set_secret(kind: String, value: String) -> Result<(), IpcError> {
    let account = secret_account(&kind)?;
    let entry = keyring_entry(account).ok_or_else(|| err("키체인 접근 실패"))?;
    if value.trim().is_empty() {
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(format!("시크릿 삭제 실패: {e}"))),
        }
    } else {
        entry
            .set_password(value.trim())
            .map_err(|e| err(format!("시크릿 저장 실패: {e}")))
    }
}

/// 시크릿이 저장돼 있는지 — UI "저장됨" 표시용.
#[tauri::command]
pub fn notify_has_secret(kind: String) -> Result<bool, IpcError> {
    let account = secret_account(&kind)?;
    Ok(get_secret(account).is_some())
}

/// working→done 엣지에서 활성 외부 채널로 팬아웃. 실패는 메시지로 모아 돌려준다(호출 측은 무시).
#[tauri::command]
pub async fn notify_external(
    state: State<'_, AppState>,
    title: String,
    body: String,
) -> Result<(), IpcError> {
    let settings = state.settings.read().unwrap().clone();
    let mut errors = Vec::new();
    if settings.slack_enabled {
        if let Err(e) = send_slack(&title, &body).await {
            errors.push(format!("Slack: {}", e.message));
        }
    }
    if settings.email_enabled {
        if let Err(e) = send_email(&settings, &title, &body).await {
            errors.push(format!("Email: {}", e.message));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(err(errors.join(" · ")))
    }
}

/// 설정 화면 "테스트 전송" — 한 채널로 샘플 알림을 보낸다.
#[tauri::command]
pub async fn notify_test(state: State<'_, AppState>, channel: String) -> Result<(), IpcError> {
    let settings = state.settings.read().unwrap().clone();
    let title = "gitpervisor 테스트 알림";
    let body = "외부 알림이 정상적으로 설정되었습니다.";
    match channel.as_str() {
        "slack" => send_slack(title, body).await,
        "smtp" => send_email(&settings, title, body).await,
        _ => Err(err("알 수 없는 채널입니다")),
    }
}

/// Slack Incoming Webhook — reqwest로 `{ "text": ... }` POST.
async fn send_slack(title: &str, body: &str) -> Result<(), IpcError> {
    let url = get_secret("slack-webhook")
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| err("Slack 웹훅 URL이 설정되지 않았습니다"))?;
    let client = reqwest::Client::new();
    let payload = serde_json::json!({ "text": format!("*{title}*\n{body}") });
    let resp = client
        .post(url.trim())
        .json(&payload)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| err(format!("전송 실패: {e}")))?;
    if !resp.status().is_success() {
        return Err(err(format!("Slack 응답 오류: {}", resp.status())));
    }
    Ok(())
}

/// SMTP 이메일 — lettre. 465=implicit TLS, 587(기타)=STARTTLS, smtp_tls=false면 평문.
async fn send_email(s: &Settings, title: &str, body: &str) -> Result<(), IpcError> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let trimmed = |o: &Option<String>| {
        o.as_deref()
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_string)
    };
    let host = trimmed(&s.smtp_host).ok_or_else(|| err("SMTP 호스트가 비었습니다"))?;
    let from = trimmed(&s.smtp_from).ok_or_else(|| err("보내는 주소(from)가 비었습니다"))?;
    let to = trimmed(&s.smtp_to).ok_or_else(|| err("받는 주소(to)가 비었습니다"))?;
    let username = trimmed(&s.smtp_username).unwrap_or_else(|| from.clone());
    let password = get_secret("smtp-password").unwrap_or_default();

    let email = Message::builder()
        .from(from.parse().map_err(|e| err(format!("from 주소 오류: {e}")))?)
        .to(to.parse().map_err(|e| err(format!("to 주소 오류: {e}")))?)
        .subject(title)
        .body(body.to_string())
        .map_err(|e| err(format!("메일 생성 실패: {e}")))?;

    let builder = if !s.smtp_tls {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
    } else if s.smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            .map_err(|e| err(format!("SMTP TLS 설정 실패: {e}")))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            .map_err(|e| err(format!("SMTP STARTTLS 설정 실패: {e}")))?
    };
    let mailer = builder
        .port(s.smtp_port)
        .credentials(Credentials::new(username, password))
        .build();
    mailer
        .send(email)
        .await
        .map_err(|e| err(format!("메일 전송 실패: {e}")))?;
    Ok(())
}
