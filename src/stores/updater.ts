import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

import { useUi } from "./ui";

// 자동 업데이트(Tauri updater) 상태. 서명 검증·다운로드·설치는 플러그인이 처리하고, 여기선
// "언제 확인하고 어떤 상태를 보여줄지"만 다룬다. 업데이트 확인은 네이티브 HTTP라 웹뷰 CSP와 무관.
//
//  idle → checking → (upToDate | available | error)
//  available → downloading(percent) → installed → relaunch()
export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installed"
  | "error";

const LS_AUTOCHECK = "gp:update-autocheck";

interface UpdaterState {
  status: UpdaterStatus;
  /** 설치할 Update 핸들(메모리 전용, 직렬화 안 함). */
  update: Update | null;
  currentVersion: string | null;
  newVersion: string | null;
  /** 릴리스 노트(마크다운 원문). */
  notes: string | null;
  /** 0–100 다운로드 진행률. */
  progress: number;
  error: string | null;
  lastCheckedAt: number | null;
  autoCheck: boolean;
  setAutoCheck: (v: boolean) => void;
  /** 업데이트 확인. silent면 실패를 조용히(수동 확인만 에러 노출·있음 시 토스트). */
  check: (opts?: { silent?: boolean }) => Promise<void>;
  /** 다운로드+설치 후 재실행. */
  downloadAndInstall: () => Promise<void>;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  update: null,
  currentVersion: null,
  newVersion: null,
  notes: null,
  progress: 0,
  error: null,
  lastCheckedAt: null,
  autoCheck: localStorage.getItem(LS_AUTOCHECK) !== "off",

  setAutoCheck: (v) => {
    localStorage.setItem(LS_AUTOCHECK, v ? "on" : "off");
    set({ autoCheck: v });
  },

  check: async ({ silent = false } = {}) => {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const current = await getVersion().catch(() => null);
      const update = await check();
      if (update) {
        set({
          status: "available",
          update,
          currentVersion: current ?? update.currentVersion,
          newVersion: update.version,
          notes: update.body ?? null,
          lastCheckedAt: Date.now(),
        });
        // 시작 시 조용한 확인에서도 새 버전은 한 번 알린다(클릭 시 설정 열기).
        useUi.getState().pushToast("info", `새 버전 v${update.version} — 설정에서 업데이트`, {
          label: "설정 열기",
          run: () => useUi.getState().setSettingsOpen(true),
        });
      } else {
        set({
          status: "upToDate",
          update: null,
          currentVersion: current,
          newVersion: null,
          notes: null,
          lastCheckedAt: Date.now(),
        });
      }
    } catch (e) {
      // 오프라인·매니페스트 없음(첫 서명 릴리스 전) 등 — 조용한 확인은 무시, 수동만 노출.
      set({
        status: silent ? "idle" : "error",
        error: e instanceof Error ? e.message : String(e),
        lastCheckedAt: Date.now(),
      });
    }
  },

  downloadAndInstall: async () => {
    const { update } = get();
    if (!update) return;
    set({ status: "downloading", progress: 0, error: null });
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          downloaded += ev.data.chunkLength;
          const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          set({ progress: pct });
        } else if (ev.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ status: "installed" });
      // 재실행 **전에** 자식(PTY 셸·LSP 서버·브라우저 webview·보조 창)을 먼저 정리한다.
      // relaunch()는 request_restart → 이벤트 루프 종료 → exec 순서라, 앱 쪽 RunEvent::Exit
      // 훅만 믿으면 이미 루프가 내려가는 중이라 창 close 메시지가 펌프되지 않는다. 여기서
      // await 하면 정리가 끝난 것을 확인한 뒤 새 프로세스가 떠, 구·신 버전의 자식 프로세스가
      // 겹쳐 사는 구간이 없어진다(2026-08-01 프로세스 누적 사건의 경로 중 하나).
      // 실패해도 재실행은 막지 않는다 — Rust의 RunEvent::Exit 경로가 백스톱이고, 정리 실패로
      // 업데이트가 중단되면 사용자는 "설치됐는데 안 바뀐다" 상태에 갇힌다.
      await invoke("prepare_relaunch").catch((e) => {
        console.warn("재실행 전 정리 실패(무시하고 재실행):", e);
      });
      // 설치 완료 → 새 버전으로 재실행. (Windows perMachine는 설치 중 UAC 승격 프롬프트.)
      await relaunch();
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
