// 로컬 LLM 런타임(llama-server) — 태스크 59. 획득(acquire)·프로세스 수명(server)·대화(chat).
//
// 커맨드는 `commands/`를 거치지 않고 이 모듈 경로로 lib.rs가 직접 등록한다(lsp가 획득만
// `lsp/`에 두고 커맨드를 `commands/lsp.rs`에 둔 것과 다른 이유: 여기선 세 파일이 한 기능의
// 앞뒤라 한 폴더에 모아 두는 편이 읽기 쉽다).
pub mod acquire;
pub mod chat;
pub mod server;

// 커맨드는 재노출하지 않는다 — `#[tauri::command]`가 만드는 숨은 `__cmd__*` 매크로는 이름을
// 짚은 `pub use`로 따라오지 않아 `invoke_handler!`가 못 찾는다. lib.rs가 `llm::acquire::…`처럼
// 서브모듈 경로로 직접 등록한다. 여기선 평범한 함수 둘만 올린다.
pub use server::{llm_kill_all, llm_spawn_idle_reaper};
