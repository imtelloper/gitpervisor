// 영상 자동 자막(태스크 72, DOCS/task/72-video-auto-subtitle-editor.md) — whisper.cpp `whisper-cli`를
// 파일당 한 번 별도 프로세스로 돌리고, 결과를 비파괴 자막 문서(CaptionDoc)로 앱 데이터에 둔다.
//
// 따로 바뀌는 단위로 나눴다: 엔진·모델 획득(acquire) · 전사 잡(transcribe) · whisper 출력 해석
// (whisper_json — whisper 버전이 바뀌면 여기만) · 문서 모델(doc) · 방어 필터(guard) · 편집 계획(plan) ·
// 저장소(store) · 자막 파일 작성기(subs) · 자막 입힌 영상의 번인 ASS·소프트 SRT(video_subs).
//
// 커맨드는 llm과 같은 이유로 lib.rs가 서브모듈 경로로 직접 등록한다(llm/mod.rs 주석).
pub mod acquire;
pub mod doc;
pub mod guard;
pub mod plan;
pub mod store;
pub mod subs;
pub mod transcribe;
pub mod video_subs;
pub mod whisper_json;
