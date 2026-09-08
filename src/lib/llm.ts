// 로컬 LLM 프론트 계약 (태스크 59 §3.4) — **60(요약·잔디)·61(번역)은 이 파일만 import한다.**
// 여기 이름·시그니처가 곧 그 두 태스크의 공용 API다(00-INDEX §11.3 "정본 이름").
//
// 스토어 없음: 상태는 react-query(["llm-status"])와 호출자 로컬 state가 전부다.
import { useQuery } from "@tanstack/react-query";

import type { ChatDone, LlmChatProgress, LlmStatus, Settings } from "./ipc";
import { ipc } from "./ipc";

export type { ChatDone };

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export interface ChatOpts {
  maxTokens?: number;
  temperature?: number;
  /** abort → llm_cancel(requestId). 응답이 유실돼도 우리가 만든 id로 끊을 수 있다. */
  signal?: AbortSignal;
  /**
   * 첫 요청은 서버 기동 + 모델 로드로 20~60초가 걸린다. 그동안 phase="loading"이 흐르므로
   * 모든 호출자가 이걸 그려야 한다("모델 로드 중…") — 안 그리면 앱이 멈춘 것처럼 보인다(§6).
   */
  onProgress?: (phase: string, message?: string) => void;
}

/**
 * 진행 이벤트 → 사용자에게 보일 한 줄. **두 모양이 같은 채널로 온다**: 평소엔 모델 로드
 * (`phase:"loading"` + 초), Windows Vulkan 기동이 실패하면 CPU 빌드 다운로드(`percent`).
 * 로드 모양만 그리던 시절엔 폴백 중에 "모델 로드 중… (undefined초)"가 떴다.
 */
function progressMessage(p: LlmChatProgress): string {
  switch (p.phase) {
    case "loading":
      return `모델 로드 중… (${p.seconds}초)`;
    case "download":
      return `CPU 런타임 받는 중${p.percent != null ? ` ${p.percent}%` : "…"}`;
    case "verify":
      return "CPU 런타임 검증 중…";
    case "extract":
      return "CPU 런타임 압축 해제 중…";
    case "error":
      return `⚠ ${p.message ?? "실패"}`;
    default:
      return "런타임 준비 완료 — 모델을 올리는 중…";
  }
}

/**
 * 한 번 물어보고 토큰을 스트리밍한다. `onToken`은 **델타**(누적 아님)를 받고, 완료 시 전체 텍스트가
 * 담긴 `ChatDone`을 돌려준다.
 *
 * v1은 백엔드가 한 번에 한 요청만 받는다 — 진행 중이면 `ErrorCode.Busy`로 거절되므로 호출자가
 * "대기 중"을 표시하고 재시도한다(61 §3).
 */
export async function chat(
  messages: ChatMsg[],
  onToken: (delta: string) => void,
  opts?: ChatOpts,
): Promise<ChatDone> {
  const requestId = crypto.randomUUID();
  const onAbort = () => void ipc.llmCancel(requestId).catch(() => {});
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await ipc.llmChat(
      {
        messages,
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
        requestId,
      },
      onToken,
      (p) => opts?.onProgress?.(p.phase, progressMessage(p)),
    );
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

/** 런타임·모델·서버 상태. 설정 AI 페이지와 60·61의 "준비 안 됨" 안내가 공유한다. */
export function useLlmStatus() {
  return useQuery({
    queryKey: ["llm-status"],
    queryFn: ipc.llmStatus,
    staleTime: 5_000,
  });
}

/**
 * 지금 `chat()`을 부를 수 있는가. null이면 가능, 아니면 **사용자에게 그대로 보여줄 이유**다.
 * 60·61은 이 문자열을 버튼 툴팁·빈 상태 문구에 쓴다.
 */
export function llmReadyReason(
  status: LlmStatus | undefined,
  settings: Settings | undefined,
): string | null {
  if (!settings) return "설정을 불러오는 중입니다";
  if (settings.llmProvider === "external") {
    return settings.llmExternalUrl?.trim() ? null : "설정 › AI › 고급에서 외부 서버 URL을 입력하세요";
  }
  if (!status) return "AI 상태를 확인하는 중입니다";
  if (!status.runtimeSupported) {
    return "이 플랫폼용 llama.cpp 공식 빌드가 없습니다 — 설정 › AI › 고급에서 외부 서버 URL을 쓰세요";
  }
  if (!status.runtime) return "설정 › AI에서 런타임을 다운로드하세요";
  if (settings.llmModel === "custom") {
    return status.customModelOk ? null : "설정 › AI › 고급의 GGUF 경로를 확인하세요";
  }
  const model = status.models.find((m) => m.id === settings.llmModel);
  if (!model) return "설정 › AI에서 모델을 고르세요";
  return model.present ? null : `설정 › AI에서 ${model.label} 모델을 다운로드하세요`;
}

/** 설정 `llmLanguage` → 프롬프트에 넣을 언어 이름. 60·61의 시스템 프롬프트가 쓴다. */
export function langName(code: string): string {
  return { ko: "Korean", en: "English" }[code] ?? code;
}
