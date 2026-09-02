import { Star, X } from "lucide-react";
import { useState } from "react";

/**
 * GitHub star 부탁 카드 — 우측 하단, 3번째 실행에 딱 한 번.
 *
 * 첫 실행에 조르지 않는 이유: 그때는 아직 "써 본" 상태가 아니라 닫힘만 당한다. 두 번 돌아와
 * 세 번째로 켰다면 쓸 만하다고 판단한 뒤다. 누르든 닫든 `gp:star-asked`가 남아 다시는 뜨지 않는다.
 *
 * 설정 항목은 만들지 않는다 — 되돌릴 이유가 없는 1회성 플래그라 settings 스키마(Rust·ipc·검색
 * 인덱스·완전성 가드)를 연쇄로 건드릴 값이 아니다. 선례는 `gp:prev-session-seen`(HealthBanner).
 */
const REPO_URL = "https://github.com/imtelloper/gitpervisor";
const KEY_ASKED = "gp:star-asked";
const KEY_LAUNCH = "gp:launch-count";
const MIN_LAUNCHES = 3;

let counted = false; // StrictMode 이중 마운트·재렌더에도 페이지 로드당 1회

/**
 * 실행 횟수 +1 후 값 반환. App 렌더 중에만 호출한다 — App은 메인 창에서만 렌더되므로
 * 플로팅·모아보기 같은 보조 창은 세지 않는다(모듈 최상위에 두면 창마다 +1 된다).
 */
export function bumpLaunchCount(): number {
  const n = Number(localStorage.getItem(KEY_LAUNCH) ?? "0") + (counted ? 0 : 1);
  if (!counted) {
    counted = true;
    localStorage.setItem(KEY_LAUNCH, String(n));
  }
  return n;
}

export function StarPrompt() {
  const [show, setShow] = useState(
    () =>
      localStorage.getItem(KEY_ASKED) == null &&
      Number(localStorage.getItem(KEY_LAUNCH) ?? "0") >= MIN_LAUNCHES,
  );
  if (!show) return null;

  const done = () => {
    localStorage.setItem(KEY_ASKED, "1");
    setShow(false);
  };
  const star = () => {
    // 메인 창 빌더의 on_new_window(lib.rs)가 http/https를 가로채 OS 기본 브라우저로 넘긴다
    // (반환은 항상 Deny — 새 웹뷰 창은 열리지 않는다). 그래서 여기엔 커맨드도 플러그인도 없다.
    window.open(REPO_URL, "_blank", "noopener");
    done();
  };

  return (
    // 경보가 아니라 부탁이다 — HealthBanner의 amber/danger 대신 중립 테두리를 쓴다.
    <div role="status" className="rounded-lg border border-edge bg-panel p-3 text-xs shadow-xl">
      <div className="flex items-start gap-2">
        <Star size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 font-medium text-fg">
          Gitpervisor가 도움이 되고 있나요?
        </div>
        <button
          onClick={done}
          title="닫기 — 이 안내는 다시 표시되지 않습니다"
          className="-mr-1 -mt-1 shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 pl-6 leading-5 text-fg-muted">
        GitHub에서 ⭐ 하나 남겨 주시면 개발에 큰 힘이 됩니다. 이 안내는 다시 표시되지 않습니다.
      </div>
      <div className="mt-2 pl-6">
        <button
          type="button"
          onClick={star}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 font-medium text-on-accent hover:bg-accent-hover"
        >
          <Star size={12} /> GitHub에서 Star 남기기
        </button>
      </div>
    </div>
  );
}
