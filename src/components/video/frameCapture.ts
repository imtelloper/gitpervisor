// 현재 재생 위치의 프레임을 PNG로 저장한다 — 플레이어 툴바와 편집 패널이 **공유**한다.
//
// 왜 공용 모듈인가: 같은 기능을 두 자리에서 부르는데, 파일명 규칙(GEN_SUFFIX)·덮어쓰기 확인·
// 저장 후 트리 갱신까지 전부 같아야 한다. 한쪽만 고치면 "편집 패널에서 저장한 것과 툴바에서
// 저장한 것의 이름이 다르다" 같은 어긋남이 생긴다.
//
// 프레임은 **원본 파일에서** ffmpeg가 뽑는다 — 화면에 그려진 픽셀을 캔버스로 긁지 않는다.
// 코덱 폴백(hls.rs)이 걸린 영상은 웹뷰가 보여 주는 그림이 1080p로 downscale된 H.264
// 재인코딩본이라, 캔버스로 긁으면 원본보다 나쁜 사본이 남는다. 게다가 루프백 서버는
// 앱 origin과 달라 캔버스가 오염되고(tainted) toBlob이 SecurityError로 죽는다.

import type { QueryClient } from "@tanstack/react-query";

import { errorMessage, ipc, isIpcError } from "../../lib/ipc";

/** 이 기능들이 스스로 만든 접미사 — 산출물을 다시 열었을 때 무한히 쌓이는 것을 막는다
 *  (`cam03.part-03.copy.mp4` -> 다시 열면 `cam03.part-03.copy.clip.mp4` 였다). */
export const GEN_SUFFIX =
  /(\.(clip|crop|mute|edit|copy|mosaic|blur|x[\d.]+|\d{3,4}p|part-\d+|frame-[\dms]+))+$/i;

export function splitPath(path: string): { dir: string; stem: string } {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const dot = base.lastIndexOf(".");
  return { dir, stem: dot > 0 ? base.slice(0, dot) : base };
}

/** 접미사를 벗긴 원본 stem — 만들어지는 모든 이름(파일명·폴더·프레임)이 여기서 나온다. */
export function cleanStem(path: string): string {
  return splitPath(path).stem.replace(GEN_SUFFIX, "");
}

/** `<원본stem>.frame-01m23s456.png` — 같은 위치를 두 번 찍으면 같은 이름이 나와
 *  덮어쓰기 확인으로 이어진다(무한히 늘어나는 이름을 만들지 않는다). */
export function frameOutRel(path: string, atMs: number): string {
  const ms = Math.max(0, Math.round(atMs));
  const { dir } = splitPath(path);
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const fff = String(frac).padStart(3, "0");
  return `${dir}${cleanStem(path)}.frame-${mm}m${ss}s${fff}.png`;
}

export interface CaptureDeps {
  projectId: string;
  /** 원본 영상의 레포 상대 경로. */
  path: string;
  /** 캡처 시각(ms) — 호출 시점의 `currentTime`. */
  atMs: number;
  pushToast: (kind: "success" | "error" | "info", message: string) => void;
  askConfirm: (opts: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  }) => void;
  qc: QueryClient;
}

/**
 * 프레임 한 장을 저장한다. 같은 이름이 있으면 덮어쓸지 묻고, 확인하면 다시 시도한다.
 *
 * 저장 성공 시 파일트리·상태 쿼리를 무효화한다 — 안 하면 방금 만든 파일이 트리에 안 보여
 * "저장됐다는데 어디 있냐"가 된다.
 */
export function captureFrame(deps: CaptureDeps, overwrite = false): void {
  const { projectId, path, atMs, pushToast, askConfirm, qc } = deps;
  const out = frameOutRel(path, atMs);
  void ipc
    .videoCaptureFrame(projectId, path, Math.max(0, Math.round(atMs)), out, overwrite)
    .then(() => {
      pushToast("success", `프레임 저장됨 — ${out.split("/").pop()}`);
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
    })
    .catch((e) => {
      if (isIpcError(e) && e.code === "ALREADY_EXISTS" && !overwrite) {
        askConfirm({
          title: "덮어쓰기",
          message: "같은 이름의 프레임 파일이 있습니다. 덮어쓸까요?",
          confirmLabel: "덮어쓰기",
          danger: true,
          onConfirm: () => captureFrame(deps, true),
        });
      } else pushToast("error", errorMessage(e));
    });
}
