//! 스트리밍 채팅 IPC (태스크 59 §3.3) — OpenAI 호환 `/v1/chat/completions`(SSE)를 토큰 델타로
//! 프론트에 흘린다. 60(요약)·61(번역)이 `src/lib/llm.ts`를 통해 이 커맨드 하나만 쓴다.
//!
//! 계약 셋:
//! - **한 번에 한 요청**(`AppState.llm_inflight`). 두 번째는 `ErrorCode::Busy` — 서버도 `-np 1`이라
//!   동시 요청은 컨텍스트 메모리를 두 배로 먹는다. 60의 배치는 프론트가 직렬로 돈다.
//! - **취소**는 `request_id`로. 프론트가 id를 만들므로 invoke 응답이 유실돼도 끊을 수 있다(http.rs 관례).
//! - 진행(`on_progress`)과 토큰(`on_token`)은 **다른 채널**이다. 한 채널에 섞으면 `{"phase":…}`처럼
//!   생긴 토큰과 구분할 방법이 없다. 채널은 호출마다 새로 만든다(재사용 = 무증상 영구 정지).

use std::time::Duration;

use futures::future::{AbortHandle, Abortable};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::server;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 요약 최대치를 감안한 상한(§3.3). 이걸 넘으면 서버가 멈춘 것으로 본다.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReq {
    pub messages: Vec<ChatMsg>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// 프론트가 만든 UUID — `llm_cancel`의 유일한 열쇠.
    pub request_id: String,
    /// 이 요청에만 쓸 모델 id(설정 `llm_report_model`). 없으면 설정의 `llm_model`.
    /// 60·67(리포트)만 채운다 — 61(번역)·설정 테스트는 항상 기본 모델을 쓴다.
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDone {
    pub text: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// `finish_reason == "length"` — 출력이 max_tokens에서 잘렸다. 호출자가 "…" 표시를 할 수 있다.
    pub truncated: bool,
}

/// SSE 누적 상태. `apply_line`이 순수 함수라 파싱만 따로 테스트한다.
#[derive(Default)]
struct Acc {
    out: ChatDone,
    done: bool,
}

/// SSE 한 줄을 반영하고, 프론트로 보낼 델타가 있으면 돌려준다.
///
/// 빈 줄·주석(`:`)·모르는 필드는 조용히 넘긴다 — 서버가 하트비트를 섞어 보내는 경우가 있다.
fn apply_line(acc: &mut Acc, line: &str) -> Option<String> {
    let line = line.trim_end_matches('\r');
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        acc.done = true;
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if let Some(u) = v.get("usage") {
        // 마지막 청크에만 온다(있을 때만).
        if let Some(n) = u.get("prompt_tokens").and_then(|x| x.as_u64()) {
            acc.out.prompt_tokens = n as u32;
        }
        if let Some(n) = u.get("completion_tokens").and_then(|x| x.as_u64()) {
            acc.out.completion_tokens = n as u32;
        }
    }
    let choice = v.get("choices").and_then(|c| c.get(0))?;
    if choice.get("finish_reason").and_then(|f| f.as_str()) == Some("length") {
        acc.out.truncated = true;
    }
    let delta = choice.get("delta")?.get("content")?.as_str()?;
    if delta.is_empty() {
        return None; // 첫 청크의 `{"role":"assistant","content":""}` — 보내면 헛돈다
    }
    acc.out.text.push_str(delta);
    Some(delta.to_string())
}

/// 바이트 버퍼에서 **완결된 줄 하나**를 잘라 낸다(`\n` 포함). 줄이 아직 안 끝났으면 None —
/// 꼬리는 버퍼에 남아 다음 청크와 이어 붙는다.
///
/// 청크마다 `from_utf8_lossy`로 디코드하면 안 된다. 한글 한 글자는 3바이트라 청크 경계가 그
/// 한가운데를 지나는 일이 흔하고, 그때 그 글자가 U+FFFD로 깨져 델타와 `ChatDone.text`에 그대로
/// 남는다(한국어 출력이 이 기능의 기본값이다). 그래서 **바이트 단위로** 자르고 완결된 줄만 디코드한다.
fn next_line(buf: &mut Vec<u8>) -> Option<String> {
    let nl = buf.iter().position(|b| *b == b'\n')?;
    let line: Vec<u8> = buf.drain(..=nl).collect();
    Some(String::from_utf8_lossy(&line).into_owned())
}

/// in-flight 등록을 RAII로 지운다 — 성공·실패·취소·패닉 어느 경로로 끝나도 다음 요청이 막히지 않게.
/// **자기 요청일 때만** 지운다(늦게 끝난 요청이 새 요청의 자리를 치우면 그 요청은 취소 불가가 된다).
struct InflightGuard<'a> {
    state: &'a AppState,
    request_id: String,
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        let mut g = self.state.llm_inflight.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref().is_some_and(|(id, _)| *id == self.request_id) {
            *g = None;
        }
    }
}

/// 로컬(또는 외부 OpenAI 호환) LLM에 한 번 물어보고 토큰을 스트리밍한다.
///
/// 첫 호출은 서버 기동+모델 로드로 20~60초가 걸린다 — 그동안 `on_progress`로
/// `{"phase":"loading","seconds":n}`이 흐른다.
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ChatReq,
    on_token: Channel<String>,
    on_progress: Channel<String>,
) -> Result<ChatDone, IpcError> {
    let (abort_handle, abort_reg) = AbortHandle::new_pair();
    {
        let mut g = state.llm_inflight.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_some() {
            return Err(IpcError::new(ErrorCode::Busy, "다른 AI 요청이 진행 중입니다"));
        }
        *g = Some((req.request_id.clone(), abort_handle));
    }
    let _guard = InflightGuard {
        state: state.inner(),
        request_id: req.request_id.clone(),
    };

    let work = run_chat(&app, state.inner(), &req, &on_token, &on_progress);
    let cancelled = || IpcError::new(ErrorCode::Cancelled, "AI 요청을 취소했습니다");
    match tokio::time::timeout(REQUEST_TIMEOUT, Abortable::new(work, abort_reg)).await {
        Err(_) => Err(IpcError::new(
            ErrorCode::Timeout,
            "AI 응답 시간 초과(10분) — 서버 상태를 확인하세요",
        )),
        Ok(Err(_aborted)) => Err(cancelled()),
        Ok(Ok(r)) => r,
    }
}

async fn run_chat(
    app: &AppHandle,
    state: &AppState,
    req: &ChatReq,
    on_token: &Channel<String>,
    on_progress: &Channel<String>,
) -> Result<ChatDone, IpcError> {
    let ep = server::ensure_server(app, state, on_progress, req.model_id.as_deref()).await?;
    server::touch_activity(state);

    let mut body = serde_json::json!({
        "model": ep.model,
        "messages": req.messages,
        "stream": true,
        // Qwen3 사고 모드 차단 — 요약·번역에 불필요하고 토큰을 태운다. 다른 모델은 이 키를 무시한다.
        "chat_template_kwargs": { "enable_thinking": false },
    });
    if let Some(n) = req.max_tokens {
        body["max_tokens"] = serde_json::json!(n);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = serde_json::json!(t);
    }

    let mut r = server::http().post(format!("{}/v1/chat/completions", ep.base));
    if let Some(key) = &ep.key {
        r = r.bearer_auth(key);
    }
    let mut resp = r
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new(ErrorCode::Network, format!("AI 요청 실패: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(IpcError::new(
            ErrorCode::Network,
            format!("AI 서버 오류 {code}: {}", detail.chars().take(300).collect::<String>()),
        ));
    }

    let mut acc = Acc::default();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| IpcError::new(ErrorCode::Network, format!("응답 수신 실패: {e}")))?
    {
        buf.extend_from_slice(&chunk);
        // 줄 단위로만 소비한다 — 청크 경계가 UTF-8/SSE 줄 한가운데를 자르는 게 정상이다.
        while let Some(line) = next_line(&mut buf) {
            if let Some(delta) = apply_line(&mut acc, &line) {
                let _ = on_token.send(delta);
                server::touch_activity(state);
            }
        }
        if acc.done {
            break;
        }
    }
    Ok(acc.out)
}

/// 진행 중인 요청 취소 — id가 다르면 아무 일도 하지 않는다(이미 끝난 요청의 늦은 취소가 다음
/// 요청을 죽이지 않게). 없으면 no-op.
#[tauri::command]
pub fn llm_cancel(state: State<'_, AppState>, request_id: String) -> Result<(), IpcError> {
    let g = state.llm_inflight.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((id, handle)) = g.as_ref() {
        if *id == request_id {
            handle.abort();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str]) -> Acc {
        let mut acc = Acc::default();
        for l in lines {
            apply_line(&mut acc, l);
        }
        acc
    }

    /// 델타는 **누적이 아니라 조각**이다. 이걸 뒤집으면 60·61 화면에 같은 글자가 겹쳐 쌓인다.
    #[test]
    fn deltas_accumulate_into_text() {
        let mut acc = Acc::default();
        let a = apply_line(&mut acc, r#"data: {"choices":[{"delta":{"content":"안녕"}}]}"#);
        let b = apply_line(&mut acc, r#"data: {"choices":[{"delta":{"content":"하세요"}}]}"#);
        assert_eq!(a.as_deref(), Some("안녕"));
        assert_eq!(b.as_deref(), Some("하세요"));
        assert_eq!(acc.out.text, "안녕하세요");
    }

    /// 첫 청크의 빈 content(`{"role":"assistant","content":""}`)와 SSE 하트비트는 흘리지 않는다.
    #[test]
    fn empty_and_noise_lines_emit_nothing() {
        let mut acc = Acc::default();
        assert!(apply_line(&mut acc, r#"data: {"choices":[{"delta":{"content":""}}]}"#).is_none());
        assert!(apply_line(&mut acc, "").is_none());
        assert!(apply_line(&mut acc, ": ping").is_none());
        assert!(apply_line(&mut acc, "event: message").is_none());
        assert!(apply_line(&mut acc, "data: not-json").is_none());
        assert!(acc.out.text.is_empty());
    }

    #[test]
    fn done_marker_and_length_finish_and_usage() {
        let acc = feed(&[
            r#"data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}"#,
            "data: [DONE]",
        ]);
        assert!(acc.done);
        assert!(acc.out.truncated);
        assert_eq!(acc.out.prompt_tokens, 12);
        assert_eq!(acc.out.completion_tokens, 34);
        assert_eq!(acc.out.text, "x");
    }

    /// 청크 경계가 한글 한 글자(3바이트) 한가운데를 지나도 글자가 깨지면 안 된다.
    /// 청크마다 `from_utf8_lossy`로 디코드하던 시절엔 여기서 U+FFFD가 나왔다.
    #[test]
    fn multibyte_split_across_chunks_is_not_corrupted() {
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"안녕하세요\"}}]}\n";
        let bytes = payload.as_bytes();
        // '안'의 첫 바이트 다음 = 글자 한가운데.
        let cut = payload.find('안').expect("한글 위치") + 1;

        let mut buf: Vec<u8> = Vec::new();
        let mut acc = Acc::default();
        buf.extend_from_slice(&bytes[..cut]);
        assert!(next_line(&mut buf).is_none(), "줄이 아직 안 끝났다");
        buf.extend_from_slice(&bytes[cut..]);
        let line = next_line(&mut buf).expect("줄 완성");
        let delta = apply_line(&mut acc, &line);

        assert_eq!(delta.as_deref(), Some("안녕하세요"));
        assert_eq!(acc.out.text, "안녕하세요");
        assert!(!acc.out.text.contains('\u{FFFD}'), "대체 문자가 섞였다");
        assert!(buf.is_empty(), "완결된 줄만 잘라야 한다");
    }

    /// `finish_reason: "stop"`은 잘림이 아니다 — 여기서 true가 되면 정상 응답마다 "잘렸습니다"가 뜬다.
    #[test]
    fn normal_stop_is_not_truncated() {
        let acc = feed(&[r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#]);
        assert!(!acc.out.truncated);
    }
}
