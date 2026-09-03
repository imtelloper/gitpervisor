/**
 * 초안 flush 레지스트리.
 *
 * 백엔드 health 감시는 레벨이 warn 이상으로 오를 때 "health://flush-drafts"를 발행한다
 * (src-tauri/src/health/mod.rs). **그걸 받는 곳이 프론트에 하나도 없었다** — 2026-09-02
 * NTS 머신(물리 RAM 7.7GB)에서 앱이 흔적 없이 사라졌을 때, 디바운스 대기 중이던 초안이
 * 그대로 날아간 경로다(API 클라이언트 250ms, 메모 500ms, 커밋 메시지 300ms).
 *
 * 여기 등록된 함수는 그 이벤트 한 번에 전부 호출된다. 각 flush는 자기 저장 경로를 이미
 * 갖고 있으므로(localStorage 또는 ipc) 이 모듈은 호출만 책임진다.
 */
const flushers = new Set<() => void>();

/** 등록하고 해제 함수를 돌려준다 — useEffect cleanup에 그대로 쓴다. */
export function registerDraftFlush(fn: () => void): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/** 하나가 던져도 나머지는 저장돼야 한다 — 개별 try/catch. */
export function flushAllDrafts(): void {
  for (const fn of flushers) {
    try {
      fn();
    } catch {
      /* 무시 — 한 초안의 실패가 다른 초안을 막지 않는다. */
    }
  }
}
