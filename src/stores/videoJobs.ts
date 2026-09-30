// 이 창이 시작한 단일 동영상 내보내기(내보내기 패널·mp4로 변환) — 상태바 작업 버튼(TaskCenter)이 목록으로 보인다.
//
// 그 잡의 상태는 시작한 컴포넌트 안에만 있어(ExportPanel·VideoPlayer) 다른 곳에서 볼 길이 없었다. 여기는 **표시용**
// 이름·진행률만 모은다: 등록은 markLocalVideoJob(id, 이름), 진행률·종결은 events.ts의 전역 리스너가 채우고 거둔다.
// 대기열이 있는 잡(빠른 재생 사본·분할·프레임 추출·자막)은 자기 스토어가 있어 여기 올리지 않는다(TaskCenter가 따로 읽는다).
import { create } from "zustand";

export interface VideoJobRow {
  id: string;
  /** 산출물 파일 이름 — 목록에 그대로. */
  label: string;
  pct: number;
}

export const useVideoJobs = create<{ jobs: VideoJobRow[] }>(() => ({ jobs: [] }));

export function trackVideoJob(id: string, label: string) {
  useVideoJobs.setState((s) => (s.jobs.some((j) => j.id === id) ? s : { jobs: [...s.jobs, { id, label, pct: 0 }] }));
}

export function setVideoJobPct(id: string, pct: number) {
  useVideoJobs.setState((s) =>
    s.jobs.some((j) => j.id === id) ? { jobs: s.jobs.map((j) => (j.id === id ? { ...j, pct } : j)) } : s,
  );
}

export function untrackVideoJob(id: string) {
  useVideoJobs.setState((s) => (s.jobs.some((j) => j.id === id) ? { jobs: s.jobs.filter((j) => j.id !== id) } : s));
}
