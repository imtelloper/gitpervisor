// 트리의 이미지 변환(단일·일괄) 진행 — 상태바 작업 버튼(TaskCenter)이 목록으로 보인다(사용자 요청 2026-11-09).
// HEIC 48장 일괄 변환은 백엔드 해독만 수십 초라 눈에 보이는 진행이 없으면 멈춘 것처럼 보였다.
import { create } from "zustand";

export interface ImageConvertJob {
  id: string;
  /** 대상 형식 이름(PNG·JPG·WebP·AVIF). */
  format: string;
  total: number;
  done: number;
  failed: number;
  /** 지금 변환 중인 파일 이름. */
  current: string;
  cancelled: boolean;
}

export const useImageConvertJobs = create<{ jobs: ImageConvertJob[] }>(() => ({ jobs: [] }));

let seq = 0;

export function startImageConvertJob(format: string, total: number): string {
  const id = `img-convert-${++seq}`;
  useImageConvertJobs.setState((s) => ({
    jobs: [...s.jobs, { id, format, total, done: 0, failed: 0, current: "", cancelled: false }],
  }));
  return id;
}

export function updateImageConvertJob(id: string, patch: Partial<Pick<ImageConvertJob, "done" | "failed" | "current">>) {
  useImageConvertJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
}

/** 남은 파일을 시작하지 않는다 — 해독 중인 것은 끝까지 간다(백엔드 ffmpeg 를 끊을 길이 없다). */
export function cancelImageConvertJob(id: string) {
  useImageConvertJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, cancelled: true } : j)) }));
}

export function isImageConvertCancelled(id: string): boolean {
  return useImageConvertJobs.getState().jobs.find((j) => j.id === id)?.cancelled ?? true;
}

export function finishImageConvertJob(id: string) {
  useImageConvertJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
}
