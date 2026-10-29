// 저장 버튼 옆 '⋯' — 다른 이름으로 저장 · 정리 저장 · 평탄화 내보내기(태스크 75 T4, 설계 §7.2).
// 동작은 lib/pdf/export.ts, 여기는 경로 입력(앱 PromptDialog)·덮어쓰기 확인·토스트만.

import { Eraser, FileDown, FilePlus2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { currentMessages, useMessages } from "../../i18n/ui-language";
import { openDocWindow } from "../../lib/floating";
import { errorMessage, isIpcError } from "../../lib/ipc";
import type { EditorDoc } from "../../lib/annotate/types";
import type { PdfLedger, PdfMarkup } from "../../lib/pdf/model";
import type { SaveModel } from "../../lib/pdf/save";
import { useUi } from "../../stores/ui";
import { MenuItem } from "../workspace/TerminalPane";

export interface PdfExportDeps {
  projectId: string;
  path: string;
  /** 지금 편집의 저장 모델(편집이 없으면 null)과 그 편집이 올라탄 디스크 stamp. stamp 가 없으면(아직 못 읽음) 막는다. */
  current(): { model: SaveModel | null; stamp: string | null };
  /** 현재 파일을 제자리로 다시 쓰는 동안 외부 변경 폴링과 겹치지 않게(Ctl.exclusive). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** 정리 저장 성공 — 일반 저장 성공과 같은 뒷정리(폴링 seen·세션 장부·stamp). ledger 는 편집이 없었으면 null. */
  onRewritten(stamp: string, ledger: PdfLedger | null): void;
  /** 일반 저장이 도는 중이면 true — 같은 파일을 두 경로가 동시에 쓰지 않게. */
  busy(): boolean;
}

const loadExport = () => import("../../lib/pdf/export");

const CLEAN_EXPLAINED_KEY = "gpv.pdf.cleanSaveExplained";
function cleanExplained(): boolean {
  try {
    return localStorage.getItem(CLEAN_EXPLAINED_KEY) === "1";
  } catch {
    return false; // 저장소를 못 쓰는 환경 — 매번 안내하는 쪽이 안전하다
  }
}
function markCleanExplained(): void {
  try {
    localStorage.setItem(CLEAN_EXPLAINED_KEY, "1");
  } catch {
    /* 기억하지 못하면 다음에 한 번 더 안내할 뿐이다 */
  }
}

const stemOf = (p: string) => p.replace(/\.pdf$/i, "");

/** 렌더마다 만들어도 싸다(상태 없음) — 스토어 액션은 호출 시점에 꺼낸다. */
export function createPdfExport(deps: PdfExportDeps) {
  const { askPrompt, askConfirm, pushToast } = useUi.getState();
  const t = () => currentMessages().pdf.export;
  const fail = (e: unknown) => pushToast("error", t().failed(errorMessage(e)));

  /** 새 파일 쓰기 공통 — 이미 있으면 덮어쓰기를 물어 한 번 더. */
  const writeNew = async (target: string, overwrite: boolean, kind: "saveAs" | "flatten"): Promise<void> => {
    const { model, stamp } = deps.current();
    if (!stamp) return;
    try {
      const exp = await loadExport();
      if (kind === "saveAs") await exp.saveAsPdf(deps.projectId, deps.path, stamp, target, model, overwrite);
      else await exp.flattenPdf(deps.projectId, deps.path, stamp, target, model, overwrite);
      // 뷰어는 원본에 남는다 — 만든 파일은 토스트에서 바로 연다.
      pushToast("success", kind === "saveAs" ? t().savedAs(target) : t().flattened(target), {
        label: t().openResult,
        run: () => openDocWindow(deps.projectId, target, { size: [1180, 860] }),
      });
    } catch (e) {
      if (!overwrite && isIpcError(e) && e.code === "ALREADY_EXISTS")
        askConfirm({
          title: t().existsTitle,
          message: t().existsMessage(target),
          confirmLabel: t().existsConfirm,
          danger: true,
          onConfirm: () => void writeNew(target, true, kind),
        });
      else fail(e);
    }
  };

  const askTarget = (kind: "saveAs" | "flatten", defaultValue: string) => {
    void loadExport().then(
      (exp) =>
        askPrompt({
          title: kind === "saveAs" ? t().saveAs : t().flatten,
          label: t().pathLabel,
          defaultValue,
          confirmLabel: kind === "saveAs" ? t().saveAsConfirm : t().flattenConfirm,
          validate: (v) => {
            const p = exp.normalizeTargetPath(v);
            if (!p) return t().pathEmpty;
            return p === deps.path ? t().samePath : null;
          },
          onConfirm: (v) => void writeNew(exp.normalizeTargetPath(v), false, kind),
        }),
      fail,
    );
  };

  const runClean = async () => {
    if (deps.busy()) return;
    try {
      const exp = await loadExport();
      await deps.exclusive(async () => {
        const { model, stamp } = deps.current();
        if (!stamp) return;
        const r = await exp.cleanSavePdf(deps.projectId, deps.path, stamp, model);
        deps.onRewritten(r.stamp, r.ledger);
      });
      pushToast("success", t().cleanSaved);
    } catch (e) {
      fail(e);
    }
  };

  const cleanSave = () => {
    if (cleanExplained()) return void runClean();
    askConfirm({
      title: t().cleanTitle,
      message: t().cleanMessage,
      confirmLabel: t().cleanConfirm,
      danger: true,
      onConfirm: () => {
        markCleanExplained();
        void runClean();
      },
    });
  };

  return {
    saveAs: () => askTarget("saveAs", `${stemOf(deps.path)}-copy.pdf`),
    flatten: () => void loadExport().then((exp) => askTarget("flatten", exp.flattenedName(deps.path)), fail),
    cleanSave,
    /** 일반 저장 성공 뒤 — 지운 것이 있었으면 "정리 저장" 제안(설계 Q7). pages·ledger 는 저장 **전** 것. */
    suggestAfterSave(pages: EditorDoc[], ledgerBefore: PdfLedger, markups: readonly PdfMarkup[] = []) {
      void loadExport().then((exp) => {
        if (!exp.hasDeletions(pages, ledgerBefore, markups)) return;
        pushToast("info", t().suggestClean, { label: t().suggestCleanAction, run: cleanSave });
      }, fail);
    },
  };
}

export type PdfExport = ReturnType<typeof createPdfExport>;

export default function PdfExportMenu({ exp, disabled }: { exp: PdfExport; disabled: boolean }) {
  const msg = useMessages();
  const t = msg.pdf.export;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  const btn = useRef<HTMLButtonElement>(null);
  // 메뉴 항목은 곧 사라진다 — 다이얼로그가 닫힌 뒤 포커스가 돌아올 자리를 남아 있는 ⋯ 버튼으로 옮겨 둔다.
  const run = (fn: () => void) => () => {
    btn.current?.focus({ preventScroll: true });
    setAt(null);
    fn();
  };

  return (
    <>
      <button
        ref={btn}
        data-pdf-export-menu
        disabled={disabled}
        title={t.menu}
        aria-label={t.menu}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.right, y: r.bottom + 2 });
        }}
        className="flex shrink-0 items-center rounded px-1 py-0.5 enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
      >
        <MoreHorizontal size={13} />
      </button>
      {at && (
        <div
          data-pdf-export-items
          className="fixed z-50 min-w-60 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          // 버튼 오른쪽 끝에 맞춰 왼쪽으로 펼친다 — 툴바가 창 오른쪽 끝에 붙어 있다. 높이 = 3줄 × 31.5 + 패딩.
          style={{ left: Math.max(0, at.x - 240), top: Math.max(0, Math.min(at.y, window.innerHeight - 110)) }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem icon={<FilePlus2 size={13} />} label={t.saveAs} onClick={run(exp.saveAs)} />
          <MenuItem icon={<Eraser size={13} />} label={t.cleanSave} onClick={run(exp.cleanSave)} />
          <MenuItem icon={<FileDown size={13} />} label={t.flatten} onClick={run(exp.flatten)} />
        </div>
      )}
    </>
  );
}
