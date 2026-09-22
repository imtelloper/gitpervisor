// 음성 인식(태스크 72) 프론트 공용 — 상태 쿼리·준비 판정·언어 목록. 설정 › AI와 대본 패널이 같이 쓴다.
import { useQuery } from "@tanstack/react-query";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { currentMessages } from "../i18n/ui-language";
import type { SttStatus, VideoAudioStream, VideoToolStatus } from "./ipc";
import { ipc } from "./ipc";

/** 엔진·모델 설치 상태. 설정의 다운로드·삭제가 `["stt-status"]`를 무효화한다. */
export function useSttStatus() {
  return useQuery({
    queryKey: ["stt-status"],
    queryFn: ipc.sttStatus,
    staleTime: 5_000,
  });
}

/** whisper `-l` 값. 더 많은 언어를 받지만 드롭다운에는 흔한 것만 둔다(auto가 나머지를 덮는다). 언어 이름은 그 언어로
 *  적는다(UI 언어와 무관) — `auto`의 라벨만 UI 문구라 게터로 **읽는 순간의 UI 언어**를 따른다. */
export const STT_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "auto", get label() { return currentMessages().captions.stt.languageAuto; } },
  { code: "ko", label: "한국어" }, // i18n-ok: 언어 자기 이름(English·日本語와 같은 줄) — UI 언어로 옮기지 않는다
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "vi", label: "Tiếng Việt" },
];

/**
 * 인식 단계의 남은 시간(ms) 추정 — 인식은 전체 진행의 10~95%(transcribe.rs)라 그 안의 경과 비례로 잰다. whisper는
 * 30초 창마다 한 번 보고하므로(부록 B.3) 첫 보고 전(10% 이하)과 끝 무렵은 null. 느린 CPU에서 기다릴지 취소할지
 * 고를 근거(§6 위험 대응).
 */
export function sttRemainingMs(transcribeElapsedMs: number, percent: number): number | null {
  if (percent <= 10 || percent >= 95) return null;
  return Math.round((transcribeElapsedMs * (95 - percent)) / (percent - 10));
}

/** 자막을 만들 오디오 트랙 이름 — "트랙 2 · kor · 해설 · aac 2ch". 번호는 1부터(`0:a:<index>`의 index+1),
 *  컨테이너 언어 태그 `und`(미지정)는 뺀다. OBS 다중 트랙 녹화는 title로 트랙을 가른다. */
export function sttAudioTrackLabel(s: VideoAudioStream): string {
  const parts = [currentMessages().captions.stt.audioTrack(s.index + 1)];
  if (s.language && s.language !== "und") parts.push(s.language);
  if (s.title?.trim()) parts.push(s.title.trim());
  const tech = [s.codec, s.channels ? `${s.channels}ch` : null].filter(Boolean).join(" ");
  if (tech) parts.push(tech);
  return parts.join(" · ");
}

/** 설정 다이얼로그는 메인 창에만 있다(DocWindow에는 없다) — 보조 창에서 "설정 열기" 버튼은 아무 일도 안 한다. */
export const HAS_SETTINGS_DIALOG = (() => {
  try {
    return getCurrentWebviewWindow().label === "main";
  } catch {
    return true;
  }
})();

/** 고치러 갈 곳 — ffmpeg(설정 › 코드 도구) · ai(설정 › AI › 음성 인식) · brew(터미널에서 설치, macOS). */
export type SttFix = "ffmpeg" | "ai" | "brew";

export interface SttNotReady {
  text: string;
  fix: SttFix | null;
}

/**
 * 지금 전사를 시작할 수 있는가 — null이면 가능. 순서는 ffmpeg → ffprobe → 엔진(+VAD) → 모델(§3.5).
 * modelId는 패널 드롭다운 값이다(설정 기본값과 다를 수 있다 — llmReadyReason의 modelId와 같은 이유).
 */
export function sttReadyReason(
  tool: VideoToolStatus | undefined,
  stt: SttStatus | undefined,
  modelId: string,
): SttNotReady | null {
  const t = currentMessages().captions.stt;
  if (!tool) return { text: t.checkingFfmpeg, fix: null };
  if (!tool.found)
    return tool.managedSupported
      ? { text: t.ffmpegNeededManaged, fix: "ffmpeg" }
      : { text: t.ffmpegNeededSystem, fix: null };
  if (!tool.probeFound) return { text: t.ffprobeMissing, fix: "ffmpeg" };
  if (!stt) return { text: t.checkingEngine, fix: null };
  if (stt.runtime.state === "unsupported") return { text: t.engineUnsupported, fix: "brew" };
  if (stt.runtime.state === "missing") return { text: t.engineMissing, fix: "ai" };
  if (!stt.vadInstalled) return { text: t.vadMissing, fix: "ai" };
  const model = stt.models.find((m) => m.id === modelId);
  if (!model) return { text: t.pickModel, fix: "ai" };
  if (!model.installed) return { text: t.modelMissing(model.label), fix: "ai" };
  return null;
}

/** 패널에서 고른 모델·언어를 설정 기본값으로 기억한다 — 바뀐 경우만 쓴다. **직전 설정을 다시 읽어** 덮는다
 *  (TitleBar 즐겨찾기와 같은 이유: 설정 다이얼로그가 들고 있던 옛 스냅샷이 다른 키를 되돌리지 않게). */
export async function rememberSttChoice(modelId: string, language: string): Promise<boolean> {
  const cur = await ipc.getSettings();
  if (cur.sttModel === modelId && cur.sttLanguage === language) return false;
  await ipc.setSettings({ ...cur, sttModel: modelId, sttLanguage: language });
  return true;
}
