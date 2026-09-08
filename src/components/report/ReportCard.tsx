import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../../lib/ipc";
import type { Project } from "../../lib/ipc";
import { chat, llmReadyReason, useLlmStatus } from "../../lib/llm";
import type { Period } from "../../lib/report";
import { buildMessages, inputHash, reportKey } from "../../lib/report";
import {
  useCommitsBetween,
  usePrompts,
  useReports,
  useSetReport,
  useSettings,
} from "../../queries";
import { useUi } from "../../stores/ui";
import MarkdownView from "../diff/MarkdownView";
import { ProjectLogo } from "../common/ProjectLogo";

/**
 * 프로젝트 1개 × 선택 기간의 요약 카드.
 *
 * 입력(커밋·프롬프트)은 LLM이 없어도 보인다 — "요약 생성"만 막힌다(설계 §1). 저장된 요약이
 * 있으면 즉시 본문을 그리고, 입력 해시가 달라졌으면 "입력이 바뀜" 뱃지로 재생성을 권한다.
 */
export function ReportCard({
  project,
  period,
  since,
  until,
  mine,
  stripe,
  runNow,
  onFinish,
}: {
  project: Project;
  period: Period;
  since: string;
  until: string;
  mine: boolean;
  stripe: string;
  /** 배치("모두 생성")의 현재 차례 — true가 되는 순간 1회 생성한다. */
  runNow?: boolean;
  onFinish?: () => void;
}) {
  const { data: commits, isPending: commitsPending } = useCommitsBetween(
    project.id,
    since,
    until,
    mine,
  );
  const { data: dump, isPending: promptsPending } = usePrompts(
    project.path,
    since,
    until,
  );
  const { data: reports } = useReports();
  const { data: settings } = useSettings();
  const { data: status } = useLlmStatus();
  const setReport = useSetReport();
  const openSettings = useUi((s) => s.openSettings);

  const key = reportKey(project.id, period, since);
  const saved = reports?.[key];
  const reason = llmReadyReason(status, settings);

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 지금 카드가 가리키는 기간 — 비동기 생성이 끝났을 때 "그 사이에 기간이 바뀌었나"를 본다.
  const keyRef = useRef(key);
  keyRef.current = key;

  // 로딩 중 `?? []`가 매 렌더 새 배열이 되면 아래 해시 효과가 계속 재실행된다 — 고정해 둔다.
  const items = useMemo(() => dump?.items ?? [], [dump]);
  const list = useMemo(() => commits ?? [], [commits]);
  // 아직 안 온 데이터를 "활동 없음"으로 읽으면 안 된다 — 배치가 그 카드를 조용히 건너뛴다.
  const loading = commitsPending || promptsPending;
  const empty = !loading && list.length === 0 && items.length === 0;

  // 저장된 요약이 아직 유효한가 — 입력이 바뀌면 뱃지를 띄운다.
  useEffect(() => {
    let alive = true;
    void inputHash(list, items).then((h) => {
      if (alive) setHash(h);
    });
    return () => {
      alive = false;
    };
  }, [list, items]);

  // 기간·프로젝트가 바뀌면 화면의 스트리밍 결과는 그 기간 것이 아니다 — 저장본으로 되돌린다.
  // 진행 중인 생성도 함께 끊는다: 카드는 key가 같아 리마운트되지 않으므로(ReportView가
  // `key={p.id}`) 안 끊으면 **떠난 기간**의 토큰이 새 기간 머리글 아래로 계속 쌓이고,
  // 한 번에 하나뿐인 LLM 슬롯도 그동안 물고 있는다.
  useEffect(() => {
    abortRef.current?.abort();
    setText("");
    setNote(null);
  }, [key]);

  const stale = !!saved && !!hash && saved.inputHash !== hash;
  const body = text || saved?.text || "";

  const generate = async () => {
    if (busy || reason || empty) return;
    setBusy(true);
    setText("");
    setNote(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const keyAtStart = key;
    let acc = "";
    try {
      const done = await chat(
        buildMessages({
          projectName: project.name,
          period,
          since,
          until,
          commits: list,
          prompts: items,
          language: settings?.llmLanguage ?? "ko",
        }),
        // 취소는 `llm_cancel` IPC 왕복이라 abort 직후에도 델타가 몇 개 더 온다 —
        // 그걸 그리면 기간을 바꾼 카드에 옛 기간 본문이 도로 채워진다.
        (delta) => {
          acc += delta;
          if (!ac.signal.aborted) setText(acc);
        },
        {
          maxTokens: 1024,
          temperature: 0.3,
          signal: ac.signal,
          onProgress: (_phase, message) => setNote(message ?? "모델 로드 중…"),
        },
      );
      if (!ac.signal.aborted) setText(done.text);
      setNote(null);
      await setReport.mutateAsync({
        key,
        record: {
          text: done.text,
          generatedAt: new Date().toISOString(),
          inputHash: await inputHash(list, items),
          model:
            settings?.llmProvider === "external"
              ? (settings.llmExternalModel ?? "external")
              : (settings?.llmModel ?? ""),
        },
      });
    } catch (e) {
      // 취소는 오류가 아니다 — 카드에 흔적만 남기고 지금까지 받은 텍스트는 그대로 둔다.
      // 단 **기간을 옮겨서** 끊긴 경우는 조용히 넘어간다: 그 "취소됨"은 사용자가 지금 보고 있는
      // 새 기간 머리글 아래에 붙어, 누르지도 않은 취소가 일어난 것처럼 보인다.
      if (keyAtStart !== keyRef.current)
        return;
      setNote(ac.signal.aborted ? "취소됨" : errorMessage(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      onFinish?.();
    }
  };

  // 배치 차례 — 부모가 순서대로 한 장씩 켠다(59는 한 번에 한 요청).
  // 생성할 수 없는 카드(활동 없음·LLM 미준비)는 **여기서** 건너뛴다: generate()의 이른 반환은
  // try 이전이라 `finally`의 onFinish를 타지 않아, 대기열이 그 카드에서 영영 멈춘다.
  // generate() 쪽을 고치지 않는 이유는 수동 버튼도 같은 함수를 쓰기 때문 — 그쪽이 대기열을
  // 밀면 안 된다.
  useEffect(() => {
    if (!runNow) return;
    // 데이터가 아직 안 왔으면 **기다린다**(건너뛰지 않는다) — loading이 deps에 있어
    // 도착하는 순간 이 효과가 다시 돈다. 안 그러면 "모두 생성"을 연 직후 누른 사용자에게
    // 아직 로딩 중이던 카드만 조용히 빈 채로 남는다.
    if (loading) return;
    if (busy || reason || empty) onFinish?.();
    else void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNow, loading]);

  return (
    <div className="flex overflow-hidden rounded border border-edge bg-panel">
      <span aria-hidden style={{ background: stripe }} className="w-1 shrink-0" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectLogo projectId={project.id} size={16} />
          <span className="truncate text-xs font-medium text-fg">{project.name}</span>
          <span className="text-[11px] text-fg-muted">
            커밋 {list.length} · 프롬프트 {items.length}
          </span>
          {stale && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">
              입력이 바뀜
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {saved && !busy && (
              <span className="text-[10px] text-fg-dim">
                {new Date(saved.generatedAt).toLocaleString()} · {saved.model}
              </span>
            )}
            {busy ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
              >
                <X size={11} /> 취소
              </button>
            ) : (
              <button
                onClick={() => void generate()}
                disabled={!!reason || empty}
                title={reason ?? undefined}
                className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles size={11} /> {saved ? "다시 생성" : "요약 생성"}
              </button>
            )}
          </div>
        </div>

        {reason && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
            <span>{reason}</span>
            <button
              onClick={() => openSettings("ai")}
              className="rounded bg-raised px-1.5 py-0.5 text-fg-muted hover:text-fg"
            >
              설정 열기
            </button>
          </div>
        )}

        {busy && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <Loader2 size={11} className="animate-spin" />
            {note ?? "요약 생성 중…"}
          </div>
        )}
        {!busy && note && (
          <div className="mt-2 text-[11px] text-fg-muted">{note}</div>
        )}

        {empty ? (
          <div className="mt-2 text-[11px] text-fg-dim">활동 없음</div>
        ) : body ? (
          <div className="mt-2 max-h-[50vh] overflow-auto rounded border border-edge">
            <MarkdownView content={body} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
