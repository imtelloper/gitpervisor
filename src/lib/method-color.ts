// HTTP 메서드 / 상태코드 → Tailwind 토큰 className.
// change-kind.ts의 KIND_BADGE 패턴(맵 + 색 토큰)을 미러링한다(§8.4).
// 새 CSS 변수 추가 없음 — styles.css @theme 토큰만 사용(data-theme 자동 추종).

/** 메서드별 텍스트 색 className(§8.4 표). 대소문자 무시, 미지정 메서드는 회색. */
export function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "text-add"; // 초록 — 안전 읽기
    case "POST":
      return "text-warn"; // 노랑 — 생성
    case "PUT":
    case "PATCH":
      return "text-mod"; // 파랑 — 수정
    case "DELETE":
      return "text-danger"; // 빨강
    case "HEAD":
    case "OPTIONS":
      return "text-fg-dim"; // 회색
    default:
      return "text-fg-dim"; // 커스텀 메서드
  }
}

/** 상태코드 범위별 배지 className(§8.4 표). 0/<100 = 네트워크 오류로 danger. */
export function statusColor(code: number): string {
  if (code >= 200 && code < 300) return "bg-ok/20 text-ok"; // 2xx
  if (code >= 300 && code < 400) return "bg-mod/20 text-mod"; // 3xx
  if (code >= 400 && code < 500) return "bg-warn/20 text-warn"; // 4xx
  // 5xx + 0(네트워크 실패) + 기타 비정상
  return "bg-danger/20 text-danger";
}
