// 태스크 61 — 선택 텍스트 번역. 백엔드는 59의 `lib/llm.ts chat()`만 거친다(직접 invoke 없음).
import { isIpcError } from "./ipc";
import { chat, langName, type ChatMsg } from "./llm";
import type { TranslateRequest } from "../stores/ui";

/** 원문 상한 — 넘으면 앞부분만 번역하고 카드가 "잘림"을 보인다(§1). */
export const MAX_TRANSLATE_CHARS = 8000;

/** Busy 재시도 간격·상한(§3.1) — 카드를 닫으면(abort) 그 전에 끊긴다. */
const RETRY_MS = 3000;
const RETRY_LIMIT_MS = 10 * 60_000;

/** 한글 음절 비율 = 한글 수 / 공백 제외 문자 수. 빈 문자열이면 0. */
export function hangulRatio(text: string): number {
  const chars = text.replace(/\s/g, "");
  if (!chars.length) return 0;
  return (chars.match(/[가-힣]/g)?.length ?? 0) / chars.length;
}

/** 자동 방향 — 한글이 20% 이상이면 영어로, 아니면 설정 언어(llmLanguage, 기본 ko)로. */
export function autoTarget(text: string, llmLanguage: string | undefined): string {
  return hangulRatio(text) >= 0.2 ? "en" : (llmLanguage ?? "ko");
}

/** 선택 텍스트 → 카드 요청(진입점 3곳 공용). 8,000자 초과는 앞부분만 + truncated. */
export function translateRequest(text: string, x: number, y: number): TranslateRequest {
  return {
    text: text.slice(0, MAX_TRANSLATE_CHARS),
    x,
    y,
    truncated: text.length > MAX_TRANSLATE_CHARS,
  };
}

function messagesFor(text: string, target: string): ChatMsg[] {
  return [
    {
      role: "system",
      content: `Translate the user's text into ${langName(target)}. Keep code, file paths, commands, identifiers, numbers and formatting unchanged. Output only the translation, no preface.`,
    },
    { role: "user", content: text },
  ];
}

/** abort 되면 즉시 깨는 sleep — 카드를 닫았는데 3초를 더 기다리지 않게. */
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
 * 번역을 스트리밍한다. `onToken`은 델타(누적 아님)를 받는다.
 *
 * 서버가 다른 AI 요청을 물고 있으면(`BUSY`) 3초 간격으로 최대 10분 재시도한다 — 59에 대기열을
 * 두는 게 정석이지만 소비자가 60·61 둘뿐이라 과하다.
 * ponytail: 3초 폴링 — 대기가 길어지는 게 일상이 되면 59에 큐를 넣는다.
 *
 * `onStatus`는 사용자에게 그대로 보일 한 줄(모델 로드 중·대기 중)이고, 진행이 끝나면 null이 온다.
 */
export async function translateStream(
  text: string,
  target: string,
  onToken: (delta: string) => void,
  signal: AbortSignal,
  onStatus?: (message: string | null) => void,
): Promise<void> {
  const deadline = Date.now() + RETRY_LIMIT_MS;
  for (;;) {
    try {
      await chat(messagesFor(text, target), (delta) => {
        onStatus?.(null); // 토큰이 흐르기 시작하면 "로드 중"을 지운다
        onToken(delta);
      }, {
        // 번역문은 원문과 길이가 비슷하다 — 토큰 ≈ 문자/1.5, 여유로 2배.
        // 하한 64: 상한일 뿐이라 올려도 비용이 없는데, 없으면 2~5자 선택이 3~7토큰에서 잘린다.
        maxTokens: Math.max(64, Math.min(2048, Math.ceil((text.length * 2) / 1.5))),
        temperature: 0.1,
        signal,
        onProgress: (_phase, message) => onStatus?.(message ?? null),
      });
      onStatus?.(null);
      return;
    } catch (e) {
      const busy = isIpcError(e) && e.code === "BUSY";
      if (!busy || signal.aborted || Date.now() > deadline) throw e;
      onStatus?.("다른 AI 작업이 끝나면 시작합니다…");
      await sleep(RETRY_MS, signal);
      if (signal.aborted) throw e;
    }
  }
}
