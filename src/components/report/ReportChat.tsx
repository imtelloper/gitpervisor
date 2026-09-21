import { Loader2, MessageSquare, Plus, Save, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage, isIpcError } from "../../lib/ipc";
import type { ChatMsg } from "../../lib/llm";
import { chat, llmReadyReason, useLlmStatus } from "../../lib/llm";
import type { ChatContext } from "../../lib/report";
import { chatMessages, maxTokensFor } from "../../lib/report";
import { useReports, useSetReport, useSettings } from "../../queries";
import { useUi } from "../../stores/ui";
import MarkdownView from "../diff/MarkdownView";

/** 59는 한 번에 한 요청만 받는다 — 카드가 요약을 만드는 중이면 채팅이 이 문구로 거절당한다. */
const BUSY_NOTE = "다른 생성이 진행 중입니다 — 끝나면 다시 보내세요";
/** 저장 버튼의 관문 — 요약 형식(`## 머리글`)이 아닌 답변을 카드 본문으로 앉히면 형식이 깨진다. */
const isSummary = (t: string) => /^## /m.test(t);

/**
 * 리포트 우측 AI 채팅 패널(태스크 67 §3.2).
 *
 * 요약이 시원찮으면 여기서 고쳐 받아 [요약으로 저장]으로 카드에 앉힌다. 컨텍스트(`ctx`)는
 * 카드의 [AI에게 묻기]가 준다 — 없어도 그냥 대화할 수 있다(그때 system은 첫 문장뿐이다).
 *
 * 대화는 저장하지 않는다(창을 닫으면 사라진다 — §7). 남길 가치가 있는 건 [요약으로 저장]이
 * 이미 `reports.json`에 담는다. 상태(`ctx`·`messages`)를 부모가 들고 있는 이유는 패널을 닫았다
 * 열어도 대화가 남아야 하기 때문이다.
 */
export function ReportChat({
  ctx,
  messages,
  setMessages,
  onClose,
}: {
  ctx: ChatContext | null;
  messages: ChatMsg[];
  setMessages: Dispatch<SetStateAction<ChatMsg[]>>;
  onClose: () => void;
}) {
  const { data: settings } = useSettings();
  const { data: status } = useLlmStatus();
  const { data: reports } = useReports();
  const setReport = useSetReport();
  const openSettings = useUi((s) => s.openSettings);
  // 리포트는 전용 모델을 쓸 수 있다(설정 `llmReportModel`) — 준비 판정도 **그 모델**을 봐야 한다.
  const reportModel = settings?.llmReportModel ?? null;
  const reason = llmReadyReason(status, settings, reportModel);

  // `ctx.body`는 [AI에게 묻기]를 누른 **그 순간의 스냅샷**이다. [요약으로 저장] 뒤에도 그대로
  // 두면 다음 요청의 "### 현재 요약"이 저장 전 본문이라, 이어서 "존댓말로 바꿔 줘"를 시키면
  // 모델이 옛 본문을 다시 써 방금 저장한 것을 되돌린다. 카드가 정본으로 삼는 저장본과 **같은
  // 출처**를 본다(ReportCard의 `body = text || saved?.text`).
  const live = ctx && { ...ctx, body: reports?.[ctx.key]?.text ?? ctx.body };

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 사용자가 위로 올려 읽고 있으면 새 토큰이 와도 끌어내리지 않는다.
  const pinned = useRef(true);
  // assistant 자리에 **표시만** 한 안내 문구(BUSY·오류·취소). 모델이 한 말이 아니므로 다음
  // 요청의 히스토리에서는 뺀다 — 그대로 실으면 4B 모델이 자기가 그렇게 답했다고 믿고 같은
  // 문구를 되풀이하거나 "이미 말씀드렸듯"으로 이어 간다.
  const notices = useRef(new Set<string>());

  // 컨텍스트가 바뀌면(다른 카드를 눌렀다) 진행 중인 답변은 그 컨텍스트 것이 아니다 — 끊는다.
  // 패널을 닫을 때(언마운트)도 같은 정리가 돌아 LLM 슬롯을 물고 있지 않는다.
  useEffect(() => () => abortRef.current?.abort(), [ctx?.key]);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, note]);

  const model =
    settings?.llmProvider === "external"
      ? (settings.llmExternalModel ?? "external")
      : (settings?.llmModel ?? "");

  const send = async () => {
    const text = input.trim();
    if (!text || busy || reason) return;
    const history = messages;
    // 모델에 보낼 때만 안내 문구가 앉은 assistant 턴과 그 짝인 직전 user 턴을 걷어 낸다
    // (위 `notices` 주석). 화면 목록은 그대로 둔다 — 사용자가 본 것을 지우지 않는다.
    const sendable = messages.reduce<ChatMsg[]>((out, m) => {
      if (m.role === "assistant" && (!m.content || notices.current.has(m.content))) out.pop();
      else out.push(m);
      return out;
    }, []);
    setInput("");
    // 답변 자리를 미리 만들어 두고 델타가 올 때마다 **그 자리**를 갱신한다(61 번역 카드와 같은 방식).
    setMessages([...history, { role: "user", content: text }, { role: "assistant", content: "" }]);
    pinned.current = true;
    setBusy(true);
    setNote(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const last = (content: string) =>
      setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content } : x)));
    /** 안내 문구 — 그 자리에 보여 주되 다음 요청의 히스토리에서는 빠진다. */
    const notice = (content: string) => {
      notices.current.add(content);
      last(content);
    };
    let acc = "";
    try {
      const done = await chat(
        chatMessages(live, sendable, text, settings?.llmLanguage ?? "ko", settings?.llmContext),
        (delta) => {
          acc += delta;
          if (!ac.signal.aborted) last(acc);
        },
        {
          maxTokens: maxTokensFor(ctx?.period ?? "day"),
          temperature: 0.3,
          modelId: reportModel ?? undefined,
          signal: ac.signal,
          onProgress: (_phase, message) => setNote(message ?? "모델 로드 중…"),
        },
      );
      if (!ac.signal.aborted) last(done.text);
    } catch (e) {
      // 취소는 오류가 아니다 — 지금까지 받은 글은 그대로 둔다(번역 카드와 같은 처리).
      // 한 글자도 못 받았으면 그건 답변이 아니라 안내다.
      if (ac.signal.aborted) {
        if (acc) last(acc);
        else notice("취소됨");
        return;
      }
      const isBusy = isIpcError(e) && e.code === "BUSY";
      notice(isBusy ? BUSY_NOTE : errorMessage(e));
      // 자동 재시도는 넣지 않는다(61의 3초 폴링과 다르다 — 사용자가 패널을 보고 있다).
      // 대신 입력한 글을 돌려준다: 다시 타이핑하게 하지 않는다.
      if (isBusy) setInput(text);
    } finally {
      setBusy(false);
      setNote(null);
      abortRef.current = null;
    }
  };

  const save = (text: string) => {
    if (!ctx) return;
    setReport.mutate({
      key: ctx.key,
      record: {
        text,
        generatedAt: new Date().toISOString(),
        // 채팅은 입력(커밋·프롬프트)을 바꾸지 않는다 — 카드가 계산해 둔 해시를 그대로 쓴다.
        inputHash: ctx.hash ?? "",
        model,
      },
    });
  };

  return (
    <aside
      data-gpv="report-chat"
      className="flex w-[min(380px,45%)] shrink-0 flex-col border-l border-edge bg-base"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
        <MessageSquare size={13} className="shrink-0 text-accent" />
        <span
          data-gpv="report-chat-ctx"
          title={ctx ? `${ctx.title} (${ctx.since}~${ctx.until})` : undefined}
          className="min-w-0 flex-1 truncate text-[11px] text-fg-muted"
        >
          {ctx
            ? `${ctx.title} · ${ctx.since === ctx.until ? ctx.since : `${ctx.since}~${ctx.until}`}`
            : "리포트 채팅"}
        </span>
        <button
          // 진행 중인 답변도 끊는다 — 안 끊으면 그 답변이 갈 자리가 없어 조용히 버려지는데도
          // 스피너와 [취소]가 남고, 끝날 때까지 한 개뿐인 LLM 슬롯을 물고 있어 새 전송이 막힌다
          // (컨텍스트 교체가 같은 이유로 abort 한다 — 위 효과).
          onClick={() => {
            abortRef.current?.abort();
            setMessages([]);
          }}
          title="새 대화 — 지금까지의 대화를 지웁니다(컨텍스트는 그대로)"
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Plus size={13} />
        </button>
        <button
          onClick={onClose}
          title="닫기"
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {reason && (
          <div className="mb-2 text-[12px] leading-5 text-fg-muted">
            {reason}
            {/* 별도 창(doc-*)엔 설정 다이얼로그가 없다 — 버튼 대신 어디서 하라고만 일러 준다(§3.3). */}
            {IS_DOC_WINDOW ? (
              <div className="mt-1 text-fg-dim">메인 창의 설정 › AI에서 준비하세요</div>
            ) : (
              <button
                onClick={() => openSettings("ai")}
                className="ml-2 rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-raised hover:text-fg"
              >
                설정 열기
              </button>
            )}
          </div>
        )}

        {messages.length === 0 && !reason && (
          <div className="text-[12px] leading-5 text-fg-dim">
            카드의 [AI에게 묻기]를 누르면 그 리포트를 두고 대화합니다 — 그냥 물어봐도 됩니다.
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} data-role={m.role} className="mb-2">
            {m.role === "user" ? (
              <div className="ml-6 whitespace-pre-wrap break-words rounded bg-raised px-2 py-1 text-[12px] leading-5 text-fg">
                {m.content}
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded border border-edge">
                  {m.content ? (
                    <MarkdownView content={m.content} />
                  ) : (
                    <div className="px-2 py-1 text-[12px] text-fg-dim">…</div>
                  )}
                </div>
                {m.content && (
                  <button
                    data-gpv="report-chat-save"
                    onClick={() => save(m.content)}
                    disabled={!ctx || busy || !isSummary(m.content)}
                    title={
                      isSummary(m.content)
                        ? "이 답변을 요약으로 저장합니다 — 카드 본문이 바뀝니다"
                        : "요약 형식이 아닙니다 — '요약을 다시 써 줘'라고 요청하세요"
                    }
                    className="mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-fg-dim hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Save size={10} /> 요약으로 저장
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-edge p-2">
        {busy && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <Loader2 size={11} className="animate-spin" />
            <span className="min-w-0 flex-1 truncate">{note ?? "답변을 쓰는 중…"}</span>
            <button
              onClick={() => abortRef.current?.abort()}
              className="shrink-0 rounded px-1.5 py-0.5 hover:bg-raised hover:text-fg"
            >
              취소
            </button>
          </div>
        )}
        <textarea
          data-gpv="report-chat-input"
          rows={3}
          value={input}
          disabled={!!reason}
          onChange={(e) => setInput(e.target.value)}
          // 한글 조합 중의 Enter는 조합 확정이다 — 그걸 전송으로 읽으면 글자가 잘려 나간다.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="더 짧게 써 줘 · 존댓말로 · 영어로 (Enter 전송, Shift+Enter 줄바꿈)"
          className="w-full resize-none rounded border border-edge bg-panel px-2 py-1 text-[12px] leading-5 text-fg placeholder:text-fg-dim disabled:opacity-50"
        />
      </div>
    </aside>
  );
}
