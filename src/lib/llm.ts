// 로컬 LLM 프론트 계약 (태스크 59 §3.4) — **60(요약·잔디)·61(번역)은 이 파일만 import한다.**
// 여기 이름·시그니처가 곧 그 두 태스크의 공용 API다(00-INDEX §11.3 "정본 이름").
//
// 스토어 없음: 상태는 react-query(["llm-status"])와 호출자 로컬 state가 전부다.
import { useQuery } from "@tanstack/react-query";

import type { ChatDone, LlmChatProgress, LlmStatus, Settings } from "./ipc";
import { ipc, isIpcError } from "./ipc";

export type { ChatDone };

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export interface ChatOpts {
  maxTokens?: number;
  temperature?: number;
  /** 이 요청에만 쓸 모델 id(설정 `llmReportModel`). 비면 설정의 기본 모델. */
  modelId?: string;
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
        modelId: opts?.modelId,
      },
      onToken,
      (p) => opts?.onProgress?.(p.phase, progressMessage(p)),
    );
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

/** Busy 재시도 간격·상한(61 §3.1) — abort 되면 그 전에 끊긴다. */
const BUSY_RETRY_MS = 3000;
const BUSY_RETRY_LIMIT_MS = 10 * 60_000;

/** abort 되면 즉시 깨는 sleep — 창·카드를 닫았는데 3초를 더 기다리지 않게. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * `chat()` + 서버가 다른 AI 요청을 물고 있으면(`BUSY`) 3초 간격으로 최대 10분 재시도. 소비자는 61(선택 번역)·
 * 72(자막 번역) — 72는 배치마다 부르므로 그 사이에 60·61 요청이 끼어드는 것이 의도다.
 * ponytail: 3초 폴링 — 대기가 길어지는 게 일상이 되면 59에 큐를 넣는다.
 */
export async function chatWithBusyRetry(
  messages: ChatMsg[],
  onToken: (delta: string) => void,
  opts: ChatOpts & { signal: AbortSignal; onBusy?: () => void },
): Promise<ChatDone> {
  const deadline = Date.now() + BUSY_RETRY_LIMIT_MS;
  for (;;) {
    try {
      return await chat(messages, onToken, opts);
    } catch (e) {
      const busy = isIpcError(e) && e.code === "BUSY";
      if (!busy || opts.signal.aborted || Date.now() > deadline) throw e;
      opts.onBusy?.();
      await sleep(BUSY_RETRY_MS, opts.signal);
      if (opts.signal.aborted) throw e;
    }
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
  /**
   * 이 호출이 쓸 모델 id — 리포트는 `settings.llmReportModel`을 넘긴다.
   * **넘기지 않으면 `llmModel`을 본다.** 리포트가 12B를 쓰는데 준비 판정이 기본 모델을 보면
   * "준비됨"이라 떠 있는 버튼이 요청 순간 "모델이 없습니다"로 죽는다.
   */
  modelId?: string | null,
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
  const want = modelId?.trim() || settings.llmModel;
  if (want === "custom") {
    return status.customModelOk ? null : "설정 › AI › 고급의 GGUF 경로를 확인하세요";
  }
  const model = status.models.find((m) => m.id === want);
  if (!model) return "설정 › AI에서 모델을 고르세요";
  return model.present ? null : `설정 › AI에서 ${model.label} 모델을 다운로드하세요`;
}

/** 언어 코드 → 프롬프트에 넣을 언어 이름. 60·61의 시스템 프롬프트(설정 `llmLanguage`)와 72 자막 번역이 쓴다. */
export function langName(code: string): string {
  return (
    {
      ko: "Korean",
      en: "English",
      ja: "Japanese",
      zh: "Chinese",
      es: "Spanish",
      fr: "French",
      de: "German",
      vi: "Vietnamese",
    }[code] ?? code
  );
}
