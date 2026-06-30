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

/// AI 작업 완료 OS 토스트 — **Windows 전용**. 앱 AUMID로 직접 토스트를 띄워 앱 이름·아이콘이
/// 보이게 한다(알림 플러그인은 dev에서 app_id를 안 붙여 "Windows PowerShell"로 떴다 — desktop.rs:201).
/// 비-Windows에선 프론트가 플러그인 sendNotification을 그대로 쓰므로 이 커맨드를 호출하지 않는다.
#[tauri::command]
pub fn notify_os(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), IpcError> {
    #[cfg(windows)]
    {
        win_toast::show(&app, &title, &body)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
        Err(err("이 플랫폼은 플러그인 알림을 사용합니다"))
    }
}

/// Windows 토스트 직접 표시 + AUMID(앱 이름/아이콘) 레지스트리 등록.
/// dev·설치본 모두에서 토스트가 gitpervisor 아이콘으로 뜨게 하는 핵심 경로.
#[cfg(windows)]
mod win_toast {
    use std::path::PathBuf;
    use std::sync::Once;

    use tauri::{AppHandle, Manager};

    use super::err;
    use crate::error::IpcError;

    const APP_ID: &str = "com.greathoon.gitpervisor";
    // 토스트 앱 로고용 PNG를 바이너리에 박아 둔다(설치본도 동일 경로 보장). 128px이면 토스트에 충분.
    const ICON_BYTES: &[u8] = include_bytes!("../icons/128x128.png");

    /// 아이콘 PNG를 안정 경로(app_local_data_dir)에 1회 기록하고 절대경로를 돌려준다.
    fn icon_path(app: &AppHandle) -> Option<PathBuf> {
        let dir = app.path().app_local_data_dir().ok()?;
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("notify-icon.png");
        if !p.exists() {
            std::fs::write(&p, ICON_BYTES).ok()?;
        }
        Some(p)
    }

    /// HKCU\Software\Classes\AppUserModelId\<APP_ID> 에 DisplayName + IconUri 등록 —
    /// Windows가 이 AUMID 토스트를 "Gitpervisor" 이름 + 아이콘으로 표시하게 한다. 프로세스당 1회.
    fn ensure_registered(app: &AppHandle) {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            if let Ok(key) = windows_registry::CURRENT_USER
                .create(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))
            {
                let _ = key.set_string("DisplayName", "Gitpervisor");
                if let Some(p) = icon_path(app) {
                    let _ = key.set_string("IconUri", p.to_string_lossy());
                }
            }
        });
    }

    pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), IpcError> {
        use tauri_winrt_notification::{IconCrop, Toast};
        ensure_registered(app);
        let mut toast = Toast::new(APP_ID).title(title).text1(body);
        if let Some(p) = icon_path(app) {
            toast = toast.icon(&p, IconCrop::Square, "Gitpervisor");
        }
        toast
            .show()
            .map_err(|e| err(format!("알림 표시 실패: {e}")))
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
