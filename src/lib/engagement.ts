// 이 창에서 사용자가 한 번이라도 조작했는가 — **자동재생의 관문**.
//
// 왜 필요한가: 메인 창은 재시작할 때 뷰어 탭을 localStorage에서 복원한다(stores/ui.ts).
// 복원된 탭이 동영상이면 앱을 켜자마자 소리가 나는데, 그건 아무도 시키지 않은 일이다.
// 반면 파일을 **클릭해서** 여는 것은 명백한 의사표시라 바로 재생하는 편이 낫다. 둘을 가르는
// 신호가 "이 창에서 사용자 조작이 있었는가"다.
//
// `navigator.userActivation`은 WebKit에 없어 못 쓴다 — 직접 센다.
//
// **반드시 앱 부팅 시점(main.tsx)에 무장해야 한다.** 소비하는 컴포넌트(VideoPlayer)는 지연
// 로드라, 거기서 리스너를 달면 그 컴포넌트를 띄운 바로 그 클릭을 놓쳐 첫 파일만 자동재생되지
// 않는다. 캡처 단계로 듣는 이유도 같다 — React 핸들러보다 먼저 표시된다.

let engaged = false;

/** 부팅 시 1회. `alreadyEngaged`면 즉시 참으로 둔다(보조 창은 열린 것 자체가 사용자의 행동이다). */
export function armEngagementTracking(alreadyEngaged: boolean): void {
  if (engaged) return;
  if (alreadyEngaged) {
    engaged = true;
    return;
  }
  const mark = () => {
    engaged = true;
  };
  window.addEventListener("pointerdown", mark, { once: true, capture: true });
  window.addEventListener("keydown", mark, { once: true, capture: true });
}

export function hasUserEngaged(): boolean {
  return engaged;
}
