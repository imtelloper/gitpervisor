import { create } from "zustand";

// 시스템 메모리 경보(HealthBanner) 표시 여부. 백엔드 Settings 스키마를 건드리지 않는
// localStorage 토글이다 — useUpdater.autoCheck와 같은 방식.
//
// 왜 끄는 수단이 필요한가: 배너의 X는 "닫은 레벨 이하"만 숨긴다(진짜 악화를 놓치지 않기 위한
// 설계다). 그런데 여유 메모리가 상시 빠듯한 머신에서는 레벨이 경계에서 계속 흔들린다 —
// 이 머신 실측(로그 9일치): 레벨 전이 3484회, warn↔danger가 1~2분 간격으로 왕복. warn을 닫아도
// 곧 danger로 올라가 다시 뜨고, 그걸 닫아도 ok로 한 번 회복하면(9일간 36회) 닫음 기록이 리셋돼
// 처음부터 반복된다. 사용자 입장에선 **끌 방법이 없는 알림**이 된다.
//
// 되돌리기는 설정 › 알림에 있다. 되돌릴 곳 없는 영구 차단은 만들지 않는다.
const KEY = "gp:health-muted";

interface HealthMuteState {
  /** true면 실시간 메모리 경보 카드를 아예 띄우지 않는다(지난 실행 비정상 종료 안내는 별개). */
  muted: boolean;
  setMuted: (v: boolean) => void;
}

export const useHealthMute = create<HealthMuteState>((set) => ({
  muted: localStorage.getItem(KEY) === "1",
  setMuted: (v) => {
    localStorage.setItem(KEY, v ? "1" : "0");
    set({ muted: v });
  },
}));
