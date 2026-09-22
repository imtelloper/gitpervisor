// 대본 패널(태스크 72 §3.5) — 자막 문서를 cue 행으로 보이고 고친다. 행 하나 = 영상 줄(인식 단어) + 자막 줄(표시 텍스트).
//
// - contentEditable을 쓰지 않는다: VideoPlayer 컨테이너 단축키는 INPUT/TEXTAREA/SELECT만 거르므로 contentEditable
//   안에서는 `i`가 In 지점을 찍고 Ctrl+Z가 영상 편집 되돌리기로 간다(§2.1). 토큰 span + 자체 선택 모델로 그리고,
//   키는 패널 루트 onKeyDown에서 처리한 뒤 전파를 끊는다.
// - 재생 시각을 props로 받지 않는다(부모가 재생 중 60fps로 다시 그린다) — ref 게터를 받아 자체 rAF에서 현재 단어를
//   classList로만 강조한다(React 렌더 0회). cue 행은 객체 동일성으로 memo.
// - 문서·자동 저장·전사 잡·되돌리기는 captionDoc 스토어가 든다 — 이 패널은 토글·파일 전환(key={path})에 언마운트된다.
import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  EyeOff,
  Languages,
  Link2,
  Loader2,
  Redo2,
  RefreshCw,
  Replace,
  Scissors,
  Search,
  Timer,
  Undo2,
  X,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  captionCueOfToken,
  captionCueSpans,
  captionCueText,
  captionCutAllowed,
  captionFillerIds,
  captionGapKeptMs,
  captionIndexAt,
  captionMatchCutIds,
  captionSelectionRange,
  captionSelectionTimeRange,
  captionSilenceCandidates,
  cutCaptionTokens,
  DEFAULT_CAPTION_FILLERS,
  findCaptionMatches,
  mergeCaptionCues,
  parseCaptionFillers,
  replaceCaptionMatches,
  setCaptionCueCaption,
  setCaptionSilence,
  setCaptionWordText,
  splitCaptionCue,
  toggleCaptionCut,
  type CaptionSelection,
} from "../../../lib/captionEdit";
import {
  captionDefaultTranslateLang,
  captionLangLabel,
  captionTranslateItems,
  captionTranslationCounts,
  captionTranslationLangs,
  setCaptionTranslation,
} from "../../../lib/captionTranslate";
import type { CaptionCue, CaptionDoc, CaptionToken, VideoAudioStream, VideoToolStatus } from "../../../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../../../lib/ipc";
import { isMac, isMod, isWindows, modLabel } from "../../../lib/platform";
import {
  HAS_SETTINGS_DIALOG,
  rememberSttChoice,
  STT_LANGUAGES,
  STT_PHASE_LABEL,
  sttAudioTrackLabel,
  sttReadyReason,
  useSttStatus,
} from "../../../lib/stt";
import { useSettings } from "../../../queries";
import { captionKey, captionReadOnly, useCaptionDoc, type TranscribeOpts } from "../../../stores/captionDoc";
import { useUi } from "../../../stores/ui";
import { splitPath, subsOutRel } from "../frameCapture";
import { fmtTime } from "../VideoPlayer";
import { TranslatePanel } from "./TranslatePanel";

/** 현재 재생 단어 표시 — classList로만 붙였다 뗀다. 선택(bg)·찾기(bg)와 겹쳐도 보이게 배경을 쓰지 않는다. */
const NOW_CLS = ["text-accent", "underline", "decoration-2", "underline-offset-4"];

/** 패널에 포커스가 있어도 플레이어로 넘기는 이동 키 — 나머지 글자 키는 끊는다(i·o·t·r·s가 구간·분할을 찍지 않게). */
const PASS_TO_PLAYER = new Set(["ArrowLeft", "ArrowRight", ",", ".", "m", "M", "f", "F", "-", "=", "+"]);

const PROMPT_MAX = 500;

/** 근사 단어 시각 문서의 컷 비활성 이유 — 다시 인식하라고 하지 않는다(brew 엔진은 다시 돌려도 근사값일 수 있다). */
const APPROX_CUT =
  "이 자막은 단어 시각이 근사값이라(인식 엔진이 단어 시각을 주지 않았다) 자르기·무음 줄이기·편집본 내보내기를 쓸 수 없습니다. 보기·고치기·자막 파일 내보내기는 됩니다.";

/** 추임새 목록 — 창·앱 재시작을 넘어 기억한다(개인 취향이라 설정 파일이 아니라 로컬). */
const FILLERS_KEY = "gp:caption-fillers";

function loadFillerText(): string {
  try {
    return localStorage.getItem(FILLERS_KEY) ?? DEFAULT_CAPTION_FILLERS.join(", ");
  } catch {
    return DEFAULT_CAPTION_FILLERS.join(", "); // localStorage 불가 환경 — 기본 목록
  }
}

type SubFormat = "srt" | "vtt" | "txt";
type SubTimeline = "source" | "edited";
type SubText = "caption" | "translation" | "both";

type Editing =
  | { kind: "word"; tokenId: string }
  | { kind: "caption"; cueId: string }
  | { kind: "trans"; cueId: string }
  | null;

const iconBtn = "rounded p-1 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
const smallBtn = "rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg disabled:opacity-40";
const fieldCls = "rounded border border-edge bg-base px-1.5 py-1 text-xs text-fg outline-none focus:border-accent";

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** cue마다 토큰 조각 — 안의 토큰이 전부 그대로면 **이전 배열을 재사용**한다(행 memo가 참조 비교라서). */
function useStableSlices(doc: CaptionDoc | null, spans: Array<[number, number]>): CaptionToken[][] {
  const cache = useRef(new Map<string, CaptionToken[]>());
  return useMemo(() => {
    if (!doc) return [];
    const next = new Map<string, CaptionToken[]>();
    const out = doc.cues.map((c, i) => {
      const [a, b] = spans[i];
      const prev = cache.current.get(c.id);
      const same = !!prev && prev.length === b - a + 1 && prev.every((t, j) => t === doc.tokens[a + j]);
      const slice = same ? prev : doc.tokens.slice(a, b + 1);
      next.set(c.id, slice);
      return slice;
    });
    cache.current = next;
    return out;
  }, [doc, spans]);
}

// ══════════════════════════ 인라인 입력 ══════════════════════════

/** 단어 텍스트 수정 — Enter 확정, Esc 취소, 포커스를 잃으면 확정. */
function WordInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      size={Math.max(2, [...v].length + 1)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          if (e.key === "Enter") onCommit(v);
          else onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCommit(v);
      }}
      className="mr-1 rounded border border-accent bg-base px-1 text-fg outline-none"
    />
  );
}

/** 자막 줄 수정(Correct — 영상은 그대로) — Enter 확정, Shift+Enter 줄바꿈, Esc 취소. */
function CaptionInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  return (
    <textarea
      autoFocus
      rows={2}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          if (e.key === "Enter") onCommit(v);
          else onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCommit(v);
      }}
      className="min-w-0 flex-1 resize-none rounded border border-accent bg-base px-1 text-fg outline-none"
    />
  );
}

// ══════════════════════════ cue 행 ══════════════════════════

interface RowHandlers {
  down: (e: React.MouseEvent, t: CaptionToken) => void;
  enter: (e: React.MouseEvent, t: CaptionToken) => void;
  dbl: (t: CaptionToken) => void;
  seek: (ms: number) => void;
  editCaption: (cueId: string) => void;
  commitWord: (tokenId: string, text: string) => void;
  commitCaption: (cueId: string, text: string) => void;
  follow: (cueId: string) => void;
  editTrans: (cueId: string) => void;
  commitTrans: (cueId: string, text: string) => void;
  cancel: () => void;
}

const CueRow = memo(function CueRow({
  cue,
  tokens,
  first,
  selLo,
  selHi,
  captionText,
  hits,
  curHit,
  editingTokenId,
  editingCaption,
  trans,
  transStale,
  editingTrans,
  readOnly,
  hideCut,
  silenceKeepMs,
  silenceMinMs,
  h,
}: {
  cue: CaptionCue;
  tokens: CaptionToken[];
  /** tokens[0]의 문서 토큰 인덱스. */
  first: number;
  /** 선택 구간(문서 토큰 인덱스). 이 행과 안 겹치면 -1/-1 — 값이 같아 memo가 건너뛴다. */
  selLo: number;
  selHi: number;
  captionText: string;
  /** 찾은 곳 — 토큰 id 또는 "caption". 없으면 undefined. */
  hits: Set<string> | undefined;
  curHit: string | null;
  editingTokenId: string | null;
  editingCaption: boolean;
  /** 번역 줄(P4) — undefined면 그리지 않는다(이 언어 번역이 없는 문서), ""면 "(번역 없음)". */
  trans: string | undefined;
  /** 번역한 뒤 원문이 바뀌었다. */
  transStale: boolean;
  editingTrans: boolean;
  readOnly: boolean;
  /** "잘린 부분 숨기기" 보기 옵션 — 잘린 토큰을 그리지 않는다. */
  hideCut: boolean;
  /** 문서의 무음 줄이기 값(숫자로 받아 memo 비교가 싸다) — 줄어드는 쉼 칩을 "1.4→0.6s"로 그린다. */
  silenceKeepMs: number | undefined;
  silenceMinMs: number | undefined;
  h: RowHandlers;
}) {
  const firstWord = tokens.find((t) => t.kind === "word");
  const startMs = (firstWord ?? tokens[0])?.startMs ?? 0;
  const override = !!cue.caption?.trim();
  const hitCls = (id: string) =>
    hits?.has(id) ? (curHit === id ? "bg-warn/40 ring-1 ring-warn" : "bg-warn/20") : "";

  return (
    <div data-cue={cue.id} className="border-b border-edge/50 px-3 py-1.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px]">
        <button
          onClick={() => h.seek(startMs)}
          title="이 자막 줄 처음으로 이동"
          className="font-mono tabular-nums text-fg-dim hover:text-accent"
        >
          {fmtTime(startMs / 1000)}
        </button>
        {cue.suspect && (
          <span
            className="rounded bg-warn/15 px-1 text-warn"
            title={
              cue.suspect === "repeat"
                ? "같은 문장이 연달아 반복됐습니다 — 인식 엔진의 환각일 수 있으니 원본을 들어 보세요"
                : "인식 결과에 깨진 글자가 있어 �로 바꿨습니다 — 직접 고쳐 주세요"
            }
          >
            {cue.suspect === "repeat" ? "반복 의심" : "깨진 글자"}
          </span>
        )}
      </div>

      {/* 영상 줄 — 인식 단어. 텍스트 수정은 인식 교정(시각 그대로), Delete는 컷(영상에서 뺀다). */}
      <div
        className="leading-6 text-fg"
        title="영상 줄 — 인식된 단어 (더블클릭·F2 고치기 · Shift+F2 자막 줄 고치기 · Alt+Shift+F2 번역 줄 고치기 · Delete 자르기/되살리기 · cue 첫 단어의 Backspace는 위와 합치기)"
      >
        {tokens.map((t, j) => {
          const i = first + j;
          const sel = i >= selLo && i <= selHi;
          if (hideCut && t.cut) return null;
          if (t.kind === "gap") {
            const len = ((t.endMs - t.startMs) / 1000).toFixed(1);
            const kept = captionGapKeptMs(t, silenceKeepMs, silenceMinMs);
            return (
              <span
                key={t.id}
                data-tid={t.id}
                onMouseDown={(e) => h.down(e, t)}
                onMouseEnter={(e) => h.enter(e, t)}
                title={
                  t.cut
                    ? "잘린 쉼 — 편집본에서 빠집니다"
                    : kept != null
                      ? `쉼 ${len}초 → ${(kept / 1000).toFixed(1)}초로 줄임(무음 줄이기)`
                      : "쉼(무음)"
                }
                className={`mr-1 inline-block cursor-pointer rounded px-1 font-mono text-[10px] leading-4 ${
                  sel ? "bg-selection" : "bg-raised"
                } ${t.cut ? "text-fg-dim line-through opacity-50" : kept != null ? "text-accent" : "text-fg-dim"}`}
              >
                ··· {kept != null ? `${len}→${(kept / 1000).toFixed(1)}s` : `${len}s`}
              </span>
            );
          }
          if (t.id === editingTokenId)
            return (
              <WordInput
                key={t.id}
                initial={t.text}
                onCommit={(v) => h.commitWord(t.id, v)}
                onCancel={h.cancel}
              />
            );
          return (
            <Fragment key={t.id}>
              <span
                data-tid={t.id}
                onMouseDown={(e) => h.down(e, t)}
                onMouseEnter={(e) => h.enter(e, t)}
                onDoubleClick={() => h.dbl(t)}
                className={`cursor-pointer rounded-sm ${sel ? "bg-selection" : "hover:bg-raised"} ${
                  t.cut ? "text-fg-dim line-through opacity-60" : ""
                } ${hitCls(t.id)}`}
              >
                {t.text}
              </span>{" "}
            </Fragment>
          );
        })}
      </div>

      {/* 자막 줄 — 화면·자막 파일에 나가는 글. 고쳐도 영상은 그대로다(Vrew 자막 줄 / Descript Correct). */}
      <div className="mt-0.5 flex items-start gap-1 border-l-2 border-edge pl-1.5">
        {editingCaption ? (
          <CaptionInput
            initial={captionText}
            onCommit={(v) => h.commitCaption(cue.id, v)}
            onCancel={h.cancel}
          />
        ) : (
          <div
            data-gpv="caption-line"
            onClick={() => h.editCaption(cue.id)}
            title={
              readOnly
                ? "자막 줄"
                : "자막 줄 — 클릭(또는 단어를 고른 뒤 Shift+F2)해 자막만 고칩니다(영상은 그대로, 잘린 말은 빠짐)"
            }
            className={`min-w-0 flex-1 whitespace-pre-line rounded px-1 ${readOnly ? "" : "cursor-text hover:bg-raised"} ${
              override ? "text-accent" : "text-fg-muted"
            } ${hitCls("caption")}`}
          >
            {captionText || <span className="italic text-fg-dim">(빈 자막)</span>}
          </div>
        )}
        {override && !readOnly && !editingCaption && (
          <button
            onClick={() => h.follow(cue.id)}
            title="인식 텍스트 따라가기 — 자막 줄 수정을 지웁니다"
            className="mt-0.5 shrink-0 text-accent hover:text-fg"
          >
            <Link2 size={11} />
          </button>
        )}
      </div>

      {/* 번역 줄(P4) — 원본 시각 cue 글(잘린 말 포함)의 번역. 고쳐도 원문·영상은 그대로다. */}
      {trans !== undefined && (
        <div className="mt-0.5 flex items-start gap-1 border-l-2 border-accent/40 pl-1.5">
          {editingTrans ? (
            <CaptionInput initial={trans} onCommit={(v) => h.commitTrans(cue.id, v)} onCancel={h.cancel} />
          ) : (
            <div
              data-gpv="translation-line"
              onClick={() => h.editTrans(cue.id)}
              title={
                readOnly
                  ? "번역 줄"
                  : "번역 줄 — 클릭(또는 단어를 고른 뒤 Alt+Shift+F2)해 고칩니다(비우면 이 줄 번역을 지웁니다)"
              }
              className={`min-w-0 flex-1 whitespace-pre-line rounded px-1 text-fg-muted ${readOnly ? "" : "cursor-text hover:bg-raised"}`}
            >
              {trans || <span className="italic text-fg-dim">(번역 없음)</span>}
            </div>
          )}
          {transStale && !editingTrans && (
            <span
              data-gpv="translation-stale"
              className="mt-0.5 shrink-0 rounded bg-warn/15 px-1 text-[10px] text-warn"
              title="번역한 뒤 원문이 바뀌었습니다 — 번역에서 이어서 번역하면 다시 번역합니다"
            >
              원문 바뀜
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// ══════════════════════════ 전사 시작 폼 ══════════════════════════

/** 모델·언어·용어 힌트 + [자막 만들기]. 준비가 안 됐으면 무엇을 하면 되는지(§3.5 빈 상태 — ffmpeg → 엔진 → 모델). */
function TranscribeForm({
  tool,
  hasAudio,
  audioStreams,
  defaultTrack,
  label,
  onStart,
}: {
  tool: VideoToolStatus | undefined;
  hasAudio: boolean | undefined;
  audioStreams: VideoAudioStream[] | undefined;
  /** 다시 인식이면 지금 문서가 쓴 트랙, 처음이면 0. */
  defaultTrack: number;
  label: string;
  onStart: (opts: TranscribeOpts) => void;
}) {
  const qc = useQueryClient();
  const openSettings = useUi((s) => s.openSettings);
  const { data: settings } = useSettings();
  const { data: stt } = useSttStatus();
  // null = 설정 기본값을 따른다(설정을 다른 창에서 바꿔도 따라간다). 고르면 시작할 때 기본값으로 기억한다.
  const [modelPick, setModelPick] = useState<string | null>(null);
  const [langPick, setLangPick] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [trackPick, setTrackPick] = useState<number | null>(null);
  const streams = audioStreams ?? [];
  // 문서가 가리키던 트랙이 파일에서 사라졌으면(원본 교체) 첫 트랙 — 없는 번호를 보내면 백엔드가 거절한다. 트랙 목록을
  // 아직 모르면(probe 읽는 중·실패) 바꾸지 않는다 — 다중 트랙 녹화를 말없이 엉뚱한 트랙으로 다시 인식해 문서를 덮었다.
  const wanted = trackPick ?? defaultTrack;
  const track = audioStreams && !audioStreams.some((s) => s.index === wanted) ? 0 : wanted;
  const modelId = modelPick ?? settings?.sttModel ?? "turbo-q5";
  const language = langPick ?? settings?.sttLanguage ?? "auto";
  const notReady = sttReadyReason(tool, stt, modelId);
  // b5130 Windows 빌드는 명령줄을 ANSI로 받아 한글 힌트가 깨진다 — 백엔드도 거절한다(설계 9절 7).
  const promptBad = isWindows && /[^\x00-\x7f]/.test(prompt);
  const blocked = !!notReady || hasAudio === false || promptBad;

  const recheck = () => {
    void qc.invalidateQueries({ queryKey: ["stt-status"] });
    void qc.invalidateQueries({ queryKey: ["video-tool"] });
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="block text-[11px] text-fg-dim">모델</span>
          <select value={modelId} onChange={(e) => setModelPick(e.target.value)} className={`${fieldCls} w-full`}>
            {(stt?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.installed ? "" : " (미설치)"}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-[11px] text-fg-dim">언어</span>
          <select value={language} onChange={(e) => setLangPick(e.target.value)} className={`${fieldCls} w-full`}>
            {STT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* 트랙이 하나면 고를 것이 없다 — OBS 다중 트랙(마이크·데스크톱 소리 분리) 녹화에서만 보인다. */}
      {streams.length >= 2 && (
        <label className="block space-y-1">
          <span className="block text-[11px] text-fg-dim">오디오 트랙</span>
          <select
            data-gpv="stt-audio-track"
            value={track}
            onChange={(e) => setTrackPick(Number(e.target.value))}
            className={`${fieldCls} w-full`}
          >
            {streams.map((s) => (
              <option key={s.index} value={s.index}>
                {sttAudioTrackLabel(s)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block space-y-1">
        <span className="block text-[11px] text-fg-dim">
          용어 힌트(선택){isWindows ? " — Windows는 영문·숫자만" : ""}
        </span>
        <input
          value={prompt}
          maxLength={PROMPT_MAX}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="고유명사를 쉼표로 — 예: Gitpervisor, Tauri, whisper"
          spellCheck={false}
          className={`${fieldCls} w-full`}
        />
      </label>
      {promptBad && (
        <div className="text-[11px] text-warn">
          Windows에서는 인식 엔진이 명령줄의 한글을 깨뜨립니다 — 용어 힌트는 영문·숫자로만 적어 주세요.
        </div>
      )}
      {hasAudio === false && (
        <div className="text-[11px] text-warn">이 영상에는 오디오 트랙이 없어 자막을 만들 수 없습니다.</div>
      )}
      {notReady && (
        <div className="space-y-1.5 rounded border border-edge bg-base px-2 py-1.5">
          <div className="text-fg">{notReady.text}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {notReady.fix === "brew" && (
              <code className="select-text rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg">
                brew install whisper-cpp
              </code>
            )}
            {(notReady.fix === "ffmpeg" || notReady.fix === "ai") &&
              (HAS_SETTINGS_DIALOG ? (
                <button
                  onClick={() => openSettings(notReady.fix === "ffmpeg" ? "codetools" : "ai")}
                  className={smallBtn}
                >
                  {notReady.fix === "ffmpeg" ? "설정 › 코드 도구 열기" : "설정 › AI 열기"}
                </button>
              ) : (
                <span className="text-[11px] text-fg-dim">메인 창의 설정에서 받을 수 있습니다.</span>
              ))}
            <button onClick={recheck} className={smallBtn} title="설치했으면 다시 확인합니다">
              다시 확인
            </button>
          </div>
        </div>
      )}
      <button
        data-gpv="stt-start"
        onClick={() => onStart({ modelId, language, prompt: prompt.trim() || null, audioStream: track })}
        disabled={blocked}
        className="w-full rounded bg-accent/20 px-3 py-1.5 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted"
      >
        {label}
      </button>
    </div>
  );
}

// ══════════════════════════ 무음 줄이기 ══════════════════════════

/**
 * 무음 줄이기(P2) — 조건 "X초 넘는 쉼을 Y초로"(기본 1.0 → 0.6), 적용 전 검토 목록(몇 곳·총 몇 초), 복구.
 * 자동 적용하지 않는다(Q10 — 화면 작업 중의 쉼일 수 있다). 적용·복구는 각각 되돌리기 한 단계.
 */
function SilencePanel({
  doc,
  blocked,
  locked,
  onApply,
  onClear,
  onSeek,
}: {
  doc: CaptionDoc;
  /** 적용할 수 없는 이유(근사 문서·잠김) — null이면 가능. */
  blocked: string | null;
  /** 전사 중·읽기 전용 — 복구도 못 한다. */
  locked: boolean;
  onApply: (minMs: number, keepMs: number) => void;
  onClear: () => void;
  onSeek: (ms: number) => void;
}) {
  const applied = doc.silenceKeepMs != null;
  const [minS, setMinS] = useState(() => String((doc.silenceMinMs ?? doc.silenceKeepMs ?? 1000) / 1000));
  const [keepS, setKeepS] = useState(() => String((doc.silenceKeepMs ?? 600) / 1000));
  const minMs = Math.round(Number(minS) * 1000);
  const keepMs = Math.round(Number(keepS) * 1000);
  const invalid =
    !minS.trim() || !keepS.trim() || !Number.isFinite(minMs) || !Number.isFinite(keepMs) || keepMs < 0 || minMs < keepMs;
  const hits = useMemo(
    () => (invalid ? [] : captionSilenceCandidates(doc, minMs, keepMs)),
    [doc, minMs, keepMs, invalid],
  );
  const savedMs = hits.reduce((a, x) => a + x.savedMs, 0);
  const same = applied && doc.silenceKeepMs === keepMs && (doc.silenceMinMs ?? keepMs) === minMs;

  return (
    <div data-gpv="silence-panel" className="shrink-0 space-y-1.5 border-b border-edge px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <input
          type="number"
          min={0}
          step={0.1}
          value={minS}
          onChange={(e) => setMinS(e.target.value)}
          aria-label="조건 — 이보다 긴 쉼(초)"
          className={`${fieldCls} w-16 font-mono`}
        />
        <span>초 넘는 쉼을</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={keepS}
          onChange={(e) => setKeepS(e.target.value)}
          aria-label="목표 길이(초)"
          className={`${fieldCls} w-16 font-mono`}
        />
        <span>초로 줄이기</span>
      </div>
      {invalid ? (
        <div className="text-[11px] text-warn">길이는 0 이상, 앞 칸(조건)은 뒤 칸(목표) 이상이어야 합니다.</div>
      ) : (
        <div className="text-fg">
          {hits.length}곳 · 총 {(savedMs / 1000).toFixed(1)}초 줄어듦
          {same && <span className="ml-1.5 text-accent">(적용됨)</span>}
        </div>
      )}
      {hits.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded border border-edge">
          {hits.map((x) => (
            <button
              key={x.tokenId}
              onClick={() => onSeek(x.startMs)}
              title="이 쉼으로 이동"
              className="flex w-full items-center gap-2 px-2 py-0.5 text-left font-mono tabular-nums hover:bg-raised"
            >
              <span className="text-fg-dim">{fmtTime(x.startMs / 1000)}</span>
              <span>
                {((x.endMs - x.startMs) / 1000).toFixed(1)}s → {(keepMs / 1000).toFixed(1)}s
              </span>
            </button>
          ))}
        </div>
      )}
      {blocked && <div className="text-[11px] text-warn">{blocked}</div>}
      <div className="flex gap-1.5">
        <button
          onClick={() => onApply(minMs, keepMs)}
          disabled={!!blocked || invalid || hits.length === 0 || same}
          className="flex-1 rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted"
        >
          {same ? "적용됨" : applied ? "바꿔 적용" : "적용"}
        </button>
        {applied && (
          <button
            onClick={onClear}
            disabled={locked}
            title="모든 쉼을 원래 길이로 되돌립니다"
            className={smallBtn}
          >
            복구
          </button>
        )}
      </div>
      <div className="text-[11px] text-fg-dim">
        쉼의 가운데를 덜어 양 끝에 절반씩 남깁니다. 원본 파일은 그대로이고, 편집 반영 재생·편집본 내보내기에만
        쓰입니다({modLabel}+Z로도 되돌립니다).
      </div>
    </div>
  );
}

// ══════════════════════════ 패널 ══════════════════════════

export const TranscriptPanel = memo(function TranscriptPanel({
  projectId,
  path,
  tool,
  hasAudio,
  audioStreams,
  getDocMs,
  onSeekDocMs,
  onTogglePlay,
  onSetRangeDocMs,
}: {
  projectId: string;
  path: string;
  tool: VideoToolStatus | undefined;
  /** probe 결과 — undefined면 아직 모른다. */
  hasAudio: boolean | undefined;
  audioStreams: VideoAudioStream[] | undefined;
  /** 현재 재생 위치(문서 시각 ms) ref 게터 — 부를 때 읽는다. */
  getDocMs: () => number;
  onSeekDocMs: (ms: number) => void;
  onTogglePlay: () => void;
  /** 선택한 cue 범위를 플레이어 구간(In/Out)으로 — 기존 단일 구간 내보내기가 받는다(§3.6). */
  onSetRangeDocMs: (startMs: number, endMs: number) => void;
}) {
  const qc = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const key = captionKey(projectId, path);
  const entry = useCaptionDoc((s) => s.entries[key]);
  const doc = entry?.doc ?? null;
  const job = entry?.job ?? null;
  const readOnly = captionReadOnly(doc);
  const locked = readOnly || !!job;
  const cutAllowed = !!doc && captionCutAllowed(doc);

  useEffect(() => {
    useCaptionDoc.getState().ensureLoaded(projectId, path);
  }, [projectId, path]);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState<CaptionSelection | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [find, setFind] = useState({ open: false, replace: false });
  const [query, setQuery] = useState("");
  const [repl, setRepl] = useState("");
  /** 이동한 찾은 곳 번호. -1 = 아직 안 옮겼다(Enter가 첫 결과로 간다). */
  const [hit, setHit] = useState(-1);
  const [popup, setPopup] = useState<"none" | "export" | "form" | "silence" | "translate">("none");
  const [fmt, setFmt] = useState<SubFormat>("srt");
  const [subsTl, setSubsTl] = useState<SubTimeline>("source");
  const [subsText, setSubsText] = useState<SubText>("caption");
  const [outName, setOutName] = useState(() => baseName(subsOutRel(path, "srt", "source")));
  const nameEditedRef = useRef(false);
  // 번역 언어(P4) — 행의 번역 줄·[번역] 팝업·자막 파일 내보내기가 같은 값을 본다. null = 문서 기준 기본값.
  const [transPick, setTransPick] = useState<string | null>(null);
  const transLang = transPick ?? captionDefaultTranslateLang(doc);
  const translating = !!entry?.translate;
  const [exporting, setExporting] = useState(false);
  const [hideCut, setHideCut] = useState(false);
  const [fillerOpen, setFillerOpen] = useState(false);
  const [fillerText, setFillerText] = useState(loadFillerText);

  const spans = useMemo(() => (doc ? captionCueSpans(doc) : []), [doc]);
  const rowTokens = useStableSlices(doc, spans);
  // 자막 줄은 잘린 어절을 뺀 글(편집본에 나가는 글)로 보이고, 고칠 때도 이 글에서 시작한다 — 넣어 두면 오타 하나
  // 고치는 순간 잘린 어절까지 override로 굳어 편집본 자막에 되살아난다(override는 컷보다 앞선다).
  const captionTexts = useMemo(
    () => (doc ? doc.cues.map((c, i) => captionCueText(doc, c, spans[i], false)) : []),
    [doc, spans],
  );
  // 번역 줄 — 이 언어 번역이 한 줄이라도 있거나 번역 중일 때만 그린다. 어절이 없는 cue는 번역 대상이 아니라 줄이 없다.
  // 원문 바뀜 = 번역할 때 저장한 원문 해시 ≠ 지금 원문 해시.
  const translatingLang = entry?.translate?.lang ?? null;
  const transRows = useMemo(() => {
    if (!doc) return null;
    const tr = doc.translations?.[transLang];
    const any = !!tr && Object.values(tr).some((t) => t.trim());
    if (!any && translatingLang !== transLang) return null;
    const saved = doc.translationSrc?.[transLang];
    const now = new Map(captionTranslateItems(doc).map((it) => [it.cueId, it.src]));
    return doc.cues.map((c) => {
      const src = now.get(c.id);
      if (src === undefined) return { text: undefined, stale: false };
      const text = tr?.[c.id]?.trim() ?? "";
      return { text, stale: !!text && saved?.[c.id] != null && saved[c.id] !== src };
    });
  }, [doc, transLang, translatingLang]);
  const transLangRef = useRef(transLang);
  transLangRef.current = transLang;
  const range = useMemo(() => (doc ? captionSelectionRange(doc, sel) : null), [doc, sel]);
  const matches = useMemo(
    () => (doc && find.open ? findCaptionMatches(doc, query) : []),
    [doc, find.open, query],
  );
  const curHit = matches.length && hit >= 0 ? Math.min(hit, matches.length - 1) : -1;
  const hitsByCue = useMemo(() => {
    const m = new Map<number, Set<string>>();
    for (const x of matches) {
      const s = m.get(x.cueIndex) ?? new Set<string>();
      s.add(x.kind === "caption" ? "caption" : (x.tokenId ?? ""));
      m.set(x.cueIndex, s);
    }
    return m;
  }, [matches]);
  const cur = curHit >= 0 ? matches[curHit] : null;
  const fillerIds = useMemo(
    () => (doc && fillerOpen ? captionFillerIds(doc, parseCaptionFillers(fillerText)) : []),
    [doc, fillerOpen, fillerText],
  );
  // 단어 입력 중인 행만 그 id를 받는다 — 모든 행에 같은 값을 주면 편집을 열고 닫을 때마다 전 행이 다시 그려진다.
  const editingRow = useMemo(() => {
    if (!doc || editing?.kind !== "word") return -1;
    const id = editing.tokenId;
    return captionCueOfToken(spans, doc.tokens.findIndex((t) => t.id === id));
  }, [doc, spans, editing]);

  // 행 핸들러는 참조가 고정돼야 한다(memo) — 바뀌는 값은 ref로 읽는다.
  const selRef = useRef(sel);
  selRef.current = sel;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const draggingRef = useRef(false);

  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const focusRoot = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  const edit = useCallback(
    (fn: (d: CaptionDoc) => CaptionDoc | null) => useCaptionDoc.getState().edit(key, fn),
    [key],
  );

  const h: RowHandlers = useMemo(
    () => ({
      down: (e, t) => {
        if (e.button !== 0) return;
        const s = selRef.current;
        if (e.shiftKey && s) setSel({ anchorId: s.anchorId, focusId: t.id });
        else {
          setSel({ anchorId: t.id, focusId: t.id });
          onSeekDocMs(t.startMs);
        }
        draggingRef.current = true;
      },
      enter: (e, t) => {
        if (draggingRef.current && e.buttons & 1) setSel((s) => (s ? { ...s, focusId: t.id } : s));
      },
      dbl: (t) => {
        if (t.kind === "word" && !lockedRef.current) setEditing({ kind: "word", tokenId: t.id });
      },
      seek: (ms) => onSeekDocMs(ms),
      editCaption: (cueId) => {
        if (!lockedRef.current) setEditing({ kind: "caption", cueId });
      },
      commitWord: (tokenId, text) => {
        edit((d) => setCaptionWordText(d, tokenId, text));
        setEditing(null);
        focusRoot();
      },
      commitCaption: (cueId, text) => {
        edit((d) => setCaptionCueCaption(d, cueId, text));
        setEditing(null);
        focusRoot();
      },
      follow: (cueId) => {
        edit((d) => setCaptionCueCaption(d, cueId, null));
      },
      editTrans: (cueId) => {
        if (!lockedRef.current) setEditing({ kind: "trans", cueId });
      },
      commitTrans: (cueId, text) => {
        const lang = transLangRef.current;
        // 고치지 않고 확정(포커스 잃음 포함)은 아무 것도 안 한다 — 원문 해시를 갱신하면 "원문 바뀜"이 말없이 풀린다.
        edit((d) =>
          text.trim() === (d.translations?.[lang]?.[cueId] ?? "").trim()
            ? null
            : setCaptionTranslation(d, lang, cueId, text),
        );
        setEditing(null);
        focusRoot();
      },
      cancel: () => {
        setEditing(null);
        focusRoot();
      },
    }),
    [edit, focusRoot, onSeekDocMs],
  );

  // 현재 재생 단어 — 자체 rAF + classList(React 렌더 0회). 행이 다시 그려지며 className이 덮이면 다시 붙인다.
  useEffect(() => {
    if (!doc) return;
    const tokens = doc.tokens;
    let raf = 0;
    let curId: string | null = null;
    let curEl: HTMLElement | null = null;
    const tick = () => {
      const i = captionIndexAt(tokens, getDocMs());
      const id = i >= 0 && tokens[i].kind === "word" ? tokens[i].id : null;
      if (
        id !== curId ||
        (id !== null && (!curEl || !curEl.isConnected || !curEl.classList.contains(NOW_CLS[0])))
      ) {
        curEl?.classList.remove(...NOW_CLS);
        curEl = id ? (listRef.current?.querySelector<HTMLElement>(`[data-tid="${CSS.escape(id)}"]`) ?? null) : null;
        curEl?.classList.add(...NOW_CLS);
        curId = id;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      curEl?.classList.remove(...NOW_CLS);
    };
  }, [doc, getDocMs]);

  // ── 찾기 ──
  const openFind = (replace: boolean) => {
    setFind({ open: true, replace: replace || find.replace });
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };
  const closeFind = () => {
    setFind({ open: false, replace: false });
    focusRoot();
  };
  const stepHit = (dir: 1 | -1) => {
    if (!doc || matches.length === 0) return;
    const i = curHit < 0 ? (dir > 0 ? 0 : matches.length - 1) : curHit + dir;
    const n = ((i % matches.length) + matches.length) % matches.length;
    setHit(n);
    const m = matches[n];
    const cueId = doc.cues[m.cueIndex]?.id;
    if (cueId)
      listRef.current?.querySelector(`[data-cue="${CSS.escape(cueId)}"]`)?.scrollIntoView({ block: "nearest" });
    const t = m.tokenId ? doc.tokens.find((x) => x.id === m.tokenId) : undefined;
    if (t) {
      setSel({ anchorId: t.id, focusId: t.id });
      onSeekDocMs(t.startMs);
    }
  };
  const replaceOne = () => {
    if (curHit < 0) return;
    // 지금 문서로 다시 찾는다 — 화면의 결과 목록이 한 박자 늦어도 엉뚱한 곳을 바꾸지 않게.
    edit((d) => {
      const m = findCaptionMatches(d, query)[curHit];
      return m ? replaceCaptionMatches(d, query, repl, m).doc : null;
    });
  };
  const replaceAll = () => {
    let n = 0;
    let total = 0;
    edit((d) => {
      total = findCaptionMatches(d, query).length;
      const r = replaceCaptionMatches(d, query, repl);
      n = r.replaced;
      return r.doc;
    });
    if (total === 0) pushToast("info", "바꿀 곳이 없습니다");
    else
      pushToast(
        "success",
        `${n}곳 바꿨습니다${n < total ? ` — ${total - n}곳은 단어가 비게 돼 건너뛰었습니다` : ""}`,
      );
  };

  // ── 컷(P2) — 토큰을 지우지 않고 cut 표시만. 남길 구간은 저장 응답의 plan(Rust)이 계산한다 ──
  /** 선택 영역 컷 토글(Delete·Backspace) — 전부 잘려 있으면 되살린다. */
  const cutSelection = () => {
    if (!doc || !range) return;
    if (!cutAllowed) {
      pushToast("info", APPROX_CUT);
      return;
    }
    edit((d) => {
      const r = captionSelectionRange(d, selRef.current);
      return r ? toggleCaptionCut(d, r) : null;
    });
  };
  /** 찾은 곳 모두 컷 — 단어 전체와 맞은 곳만(일부만 맞은 곳은 건너뛴다). 되돌리기 한 단계. */
  const cutAllFound = () => {
    let places = 0;
    let skipped = 0;
    const ok = edit((d) => {
      const r = captionMatchCutIds(d, findCaptionMatches(d, query));
      places = r.places;
      skipped = r.skipped;
      return cutCaptionTokens(d, r.ids);
    });
    const skip = skipped ? ` — 단어 일부만 맞았거나 자막 줄에서 찾은 ${skipped}곳은 건너뛰었습니다` : "";
    if (ok) pushToast("success", `${places}곳을 잘랐습니다${skip}`);
    else pushToast("info", `${places ? "이미 모두 잘려 있습니다" : "자를 곳이 없습니다"}${skip}`);
  };
  const cutFillers = () => {
    let n = 0;
    const ok = edit((d) => {
      const ids = captionFillerIds(d, parseCaptionFillers(fillerText));
      n = ids.length;
      return cutCaptionTokens(d, ids);
    });
    if (ok) pushToast("success", `추임새 ${n}곳을 잘랐습니다 — ${modLabel}+Z로 되돌립니다`);
  };
  const changeFillers = (text: string) => {
    setFillerText(text);
    try {
      localStorage.setItem(FILLERS_KEY, text);
    } catch {
      // 저장 불가 환경(localStorage 차단) — 이번 창에서만 쓴다.
    }
  };

  // ── 나누기·합치기 ──
  const caret = range ? range[0] : -1;
  const splitAtCaret = () => {
    if (!doc || caret < 0) return;
    const id = doc.tokens[caret].id;
    edit((d) => splitCaptionCue(d, id));
  };
  const mergeAt = (dir: -1 | 1) => {
    if (caret < 0) return;
    const ci = captionCueOfToken(spans, caret);
    if (ci < 0) return;
    const i = dir < 0 ? ci - 1 : ci;
    edit((d) => mergeCaptionCues(d, i));
  };
  /** caret이 cue 첫 단어(또는 그 앞 쉼)이고 위에 cue가 있는가 — Backspace 합치기 자리(그 밖의 Backspace는 컷). */
  const atCueHead = () => {
    if (caret < 0) return false;
    const ci = captionCueOfToken(spans, caret);
    if (ci <= 0) return false;
    const firstWord = rowTokens[ci].findIndex((t) => t.kind === "word");
    return caret <= spans[ci][0] + Math.max(0, firstWord);
  };
  const editCaret = () => {
    if (!doc || caret < 0 || locked) return;
    const t = doc.tokens[caret];
    if (t.kind === "word") setEditing({ kind: "word", tokenId: t.id });
  };
  /** Shift+F2 — caret이 든 cue의 자막 줄 고치기(마우스 없이 들어가는 길). */
  const editCaretCaption = () => {
    if (!doc || caret < 0 || locked) return;
    const ci = captionCueOfToken(spans, caret);
    if (ci >= 0) setEditing({ kind: "caption", cueId: doc.cues[ci].id });
  };
  /** Alt+Shift+F2 — caret이 든 cue의 번역 줄 고치기(번역 줄이 보일 때만). 번역 줄은 클릭으로만 열려, 키보드로는
   *  "원문 바뀜"(손으로 고쳐야 풀린다)을 풀 길이 없었다. */
  const editCaretTrans = () => {
    if (!doc || caret < 0 || locked) return;
    const ci = captionCueOfToken(spans, caret);
    if (ci >= 0 && transRows?.[ci]?.text !== undefined) setEditing({ kind: "trans", cueId: doc.cues[ci].id });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    // 입력 요소는 자기 키를 쓴다(찾기 입력의 Enter·단어 입력의 Esc 등은 각자 처리). 바깥 컨테이너도 이들을 거른다.
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // 포커스된 버튼(취소·적용·헤더)은 Space·Enter로 자기 동작을 한다 — 나누기·컷·고치기로 가로채면 버튼이 안 눌리고
    // 앞서 고른 단어가 말없이 잘리거나 나뉜다.
    if (tag === "BUTTON" && [" ", "Enter", "Delete", "Backspace", "F2"].includes(e.key)) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const k = e.key.toLowerCase();
    if (isMod(e.nativeEvent) && !e.altKey) {
      if (k === "f" && !e.shiftKey) {
        stop();
        openFind(false);
      } else if (k === "h" && !e.shiftKey) {
        stop();
        openFind(true);
      } else if (k === "z" || k === "y") {
        // 패널에 포커스가 있으면 되돌리기는 대본 몫이다 — 비어 있어도 영상 편집 되돌리기로 새지 않게 끊는다.
        stop();
        if (k === "y" || e.shiftKey) useCaptionDoc.getState().redo(key);
        else useCaptionDoc.getState().undo(key);
      } else if (k === "e" && !e.shiftKey) {
        stop();
        mergeAt(1);
      }
      return; // 그 밖의 조합(Ctrl+Shift+F·Ctrl+W …)은 전역 단축키에 양보
    }
    // macOS ⌘H는 앱 숨기기라 가로챌 수 없다 — 찾아 바꾸기는 ⌥⌘F(VS Code 관례).
    if (isMac && e.metaKey && e.altKey && e.code === "KeyF") {
      stop();
      openFind(true);
      return;
    }
    if (e.key === "F2" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      stop();
      editCaretTrans();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case " ":
        stop();
        if (!e.repeat) onTogglePlay(); // 전역 Space 리스너는 플레이어 안 포커스를 건너뛴다 — 이중 토글 없음
        return;
      case "Enter":
        stop();
        if (!locked) splitAtCaret();
        return;
      case "Backspace":
        stop();
        if (locked) return;
        // 한 단어만 고른 채(caret) cue 첫 단어에서 누르면 위와 합치기(P1), 그 밖은 선택 영역 컷 토글(P2 — 설계 표).
        if (range && range[0] === range[1] && atCueHead()) mergeAt(-1);
        else cutSelection();
        return;
      case "Delete":
        stop();
        if (!locked) cutSelection();
        return;
      case "F2":
        stop();
        if (e.shiftKey) editCaretCaption();
        else editCaret();
        return;
      case "Escape":
        if (find.open) {
          stop();
          closeFind();
        } else if (sel) {
          stop();
          setSel(null);
        }
        return; // 닫을 것이 없으면 플레이어(확대 해제)에 양보
    }
    if (PASS_TO_PLAYER.has(e.key)) return;
    // 나머지 **글자** 키는 여기서 끊는다 — 대본을 보다 누른 i·o·t·r·s·숫자가 구간·분할·반복·탐색을 찍으면 안 된다
    // (e2e 회귀 대상). F5·Tab 같은 비글자 키는 전역 단축키 몫이라 흘려보낸다.
    if (e.key.length === 1) e.stopPropagation();
  };

  // ── 선택 → 구간(In/Out) ──
  const setRangeFromSelection = () => {
    if (!doc || !range) return;
    const r = captionSelectionTimeRange(doc, spans, range);
    if (!r) return;
    onSetRangeDocMs(r.startMs, r.endMs);
    pushToast(
      "info",
      `구간 ${fmtTime(r.startMs / 1000)} ~ ${fmtTime(r.endMs / 1000)} — 편집 › 내보내기에서 클립·GIF로 저장합니다`,
    );
  };

  // ── 전사 ──
  const start = (opts: TranscribeOpts) => {
    const go = () => {
      setPopup("none");
      setSel(null);
      setEditing(null);
      void useCaptionDoc.getState().transcribe(projectId, path, opts);
      void rememberSttChoice(opts.modelId, opts.language)
        .then((changed) => {
          if (changed) void qc.invalidateQueries({ queryKey: ["settings"] });
        })
        .catch((err) => pushToast("error", `모델·언어 기본값을 기억하지 못했습니다 — ${errorMessage(err)}`));
    };
    if (doc)
      askConfirm({
        title: "다시 인식",
        message: "지금 자막(편집 포함)을 새 인식 결과로 바꿉니다. 직전 판은 한 세대 백업으로 남습니다.",
        confirmLabel: "다시 인식",
        danger: true,
        onConfirm: go,
      });
    else go();
  };

  // ── 자막 파일 내보내기 ──
  // 글(P4): 원문 · 번역 · 원문 아래 번역 2단. 번역이 있는 언어가 없으면 원문뿐이다. 언어는 [번역] 팝업·행과 같은 값.
  const trLangs = useMemo(() => captionTranslationLangs(doc), [doc]);
  const subsLangAvail = trLangs.includes(transLang) ? transLang : (trLangs[0] ?? null);
  const subsTextEff: SubText = subsLangAvail ? subsText : "caption";
  const subsLang = subsTextEff === "caption" ? null : subsLangAvail;
  const subsPlan = entry?.plan ?? null;
  // 내보낼 줄 중 번역이 빠진 수 — 백엔드(`select_sub_text`)도 원문으로 채우지 않고 거절한다. 편집본이면 plan의 줄만.
  const subsGap = useMemo(() => {
    if (!doc || !subsLang) return null;
    const ids = subsTl === "edited" ? new Set((subsPlan?.outCues ?? []).map((c) => c.cueId)) : undefined;
    return captionTranslationCounts(doc, subsLang, ids);
  }, [doc, subsLang, subsTl, subsPlan]);
  const subsSuggested = baseName(subsOutRel(path, fmt, subsTl, subsLang, subsTextEff === "both"));
  useEffect(() => {
    if (!nameEditedRef.current) setOutName(subsSuggested);
  }, [subsSuggested]);
  const pickFormat = (f: SubFormat) => {
    setFmt(f);
    if (nameEditedRef.current) setOutName((prev) => prev.replace(/\.[^.]*$/, "") + "." + f);
  };
  const nameInvalid =
    !outName.trim() || /[\\/]|\.\./.test(outName) || !outName.trim().toLowerCase().endsWith(`.${fmt}`);
  const exportSubs = async (overwrite: boolean) => {
    const name = outName.trim();
    // 저장 대기(flush) 동안에도 버튼을 막는다 — 그 사이 한 번 더 누르면 같은 파일을 두 번 쓴다.
    setExporting(true);
    try {
      // 내보내기는 Rust가 **저장본**을 읽는다 — 대기 중인 편집을 먼저 디스크에 보낸다.
      if (!(await useCaptionDoc.getState().flush(key))) {
        pushToast("error", "저장되지 않은 편집이 있어 내보내지 않았습니다 — 패널 위 안내를 먼저 해결하세요");
        return;
      }
      const rel = await ipc.captionExportSubs(projectId, path, {
        format: fmt,
        timeline: subsTl,
        text: subsTextEff,
        lang: subsLang,
        outRel: splitPath(path).dir + name,
        overwrite,
      });
      pushToast("success", `자막 파일 저장 — ${baseName(rel)}`);
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      setPopup("none");
    } catch (err) {
      if (isIpcError(err) && err.code === "ALREADY_EXISTS" && !overwrite)
        askConfirm({
          title: "덮어쓰기",
          message: `${name} 파일이 이미 있습니다. 덮어쓸까요?`,
          confirmLabel: "덮어쓰기",
          danger: true,
          onConfirm: () => void exportSubs(true),
        });
      else pushToast("error", errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const saveLabel = !entry
    ? ""
    : entry.saving
      ? "저장 중…"
      : entry.dirty
        ? "저장 대기"
        : doc && !readOnly
          ? "저장됨"
          : "";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-gpv="transcript-panel"
      className="flex h-full min-h-0 flex-col text-xs text-fg-muted outline-none"
    >
      {/* 헤더 */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge px-2">
        <span className="font-semibold text-fg">대본</span>
        {saveLabel && <span className="ml-1.5 text-[10px] text-fg-dim">{saveLabel}</span>}
        <div className="flex-1" />
        {doc && (
          <>
            <button onClick={() => openFind(false)} title={`찾기 (${modLabel}+F)`} className={iconBtn}>
              <Search size={13} />
            </button>
            <button
              onClick={() => openFind(true)}
              disabled={locked}
              title={`찾아 바꾸기 (${isMac ? "⌥⌘F" : "Ctrl+H"})`}
              className={iconBtn}
            >
              <Replace size={13} />
            </button>
            <button
              onClick={() => useCaptionDoc.getState().undo(key)}
              disabled={locked || !entry?.past.length}
              title={`되돌리기 (${modLabel}+Z)${entry?.past.length ? ` · ${entry.past.length}단계` : ""}`}
              className={iconBtn}
            >
              <Undo2 size={13} />
            </button>
            <button
              onClick={() => useCaptionDoc.getState().redo(key)}
              disabled={locked || !entry?.future.length}
              title={isMac ? "다시 실행 (⇧⌘Z)" : "다시 실행 (Ctrl+Y)"}
              className={iconBtn}
            >
              <Redo2 size={13} />
            </button>
            <button
              onClick={setRangeFromSelection}
              disabled={!range}
              title={
                range
                  ? "선택한 자막 줄 구간을 플레이어 구간(In/Out)으로 — 편집 › 내보내기에서 클립·GIF로"
                  : "단어를 클릭(Shift+클릭·드래그로 범위)해 자막 줄을 먼저 고르세요"
              }
              className={`${iconBtn} flex items-center gap-0.5`}
            >
              <Scissors size={13} />
              <span className="text-[11px]">구간</span>
            </button>
            <button
              data-gpv="silence-toggle"
              onClick={() => setPopup((p) => (p === "silence" ? "none" : "silence"))}
              title={doc.silenceKeepMs != null ? "무음 줄이기 — 적용됨" : "무음 줄이기 — 긴 쉼을 짧게"}
              className={`${iconBtn} ${popup === "silence" ? "bg-raised" : ""} ${
                popup === "silence" || doc.silenceKeepMs != null ? "text-accent" : ""
              }`}
            >
              <Timer size={13} />
            </button>
            <button
              data-gpv="hide-cut-toggle"
              onClick={() => setHideCut((v) => !v)}
              aria-pressed={hideCut}
              title={hideCut ? "잘린 부분 보이기" : "잘린 부분 숨기기"}
              className={`${iconBtn} ${hideCut ? "bg-raised text-accent" : ""}`}
            >
              <EyeOff size={13} />
            </button>
            <button
              data-gpv="translate-toggle"
              onClick={() => setPopup((p) => (p === "translate" ? "none" : "translate"))}
              title={
                translating
                  ? "번역 중 — 진행·취소"
                  : entry?.translateError
                    ? `번역 자막 — ${entry.translateError}`
                    : "번역 자막 — 로컬 AI로 자막 줄마다 번역"
              }
              className={`${iconBtn} ${popup === "translate" ? "bg-raised" : ""} ${
                popup === "translate" || translating ? "text-accent" : entry?.translateError ? "text-warn" : ""
              }`}
            >
              <Languages size={13} />
            </button>
            <button
              data-gpv="subs-export-toggle"
              onClick={() => setPopup((p) => (p === "export" ? "none" : "export"))}
              disabled={!!job}
              title={job ? "자막을 만드는 중에는 내보낼 수 없습니다" : "자막 파일(SRT·VTT·TXT)로 저장"}
              className={`${iconBtn} ${popup === "export" ? "bg-raised text-accent" : ""}`}
            >
              <Download size={13} />
            </button>
            <button
              onClick={() => setPopup((p) => (p === "form" ? "none" : "form"))}
              disabled={!!job || readOnly || translating}
              title={
                readOnly
                  ? "새 버전 앱에서 만든 자막 문서라 다시 인식해도 저장할 수 없습니다 — 앱을 업데이트하세요"
                  : translating
                    ? "번역 중에는 다시 인식할 수 없습니다 — 번역을 끝내거나 취소하세요"
                    : "다시 인식 — 모델·언어를 골라 자막을 새로 만듭니다"
              }
              className={`${iconBtn} ${popup === "form" ? "bg-raised text-accent" : ""}`}
            >
              <RefreshCw size={13} />
            </button>
          </>
        )}
      </div>

      {/* 진행 */}
      {job && (
        <div data-gpv="stt-progress" className="shrink-0 space-y-1 border-b border-edge px-3 py-2">
          <div className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-accent" />
            <span className="text-fg">{STT_PHASE_LABEL[job.phase]} 중…</span>
            <span className="font-mono tabular-nums">{job.percent}%</span>
            {job.remainingMs != null && (
              <span data-gpv="stt-eta" className="text-fg-dim" title="지금까지의 인식 속도로 잰 추정입니다">
                {job.remainingMs < 60_000 ? "1분 안에 끝남" : `약 ${Math.ceil(job.remainingMs / 60_000)}분 남음`}
              </span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => useCaptionDoc.getState().cancelTranscribe(key)}
              className={`${smallBtn} text-warn`}
            >
              취소
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-raised">
            <div className="h-full rounded bg-accent transition-[width]" style={{ width: `${job.percent}%` }} />
          </div>
          <div className="text-[11px] text-fg-dim">
            CPU로 인식합니다 — 긴 영상은 수 분 걸립니다. 그동안 이 영상의 편집·내보내기·분할은 잠깁니다.
          </div>
        </div>
      )}

      {/* 안내 배너 */}
      {entry?.jobError && (
        <div className="shrink-0 border-b border-edge bg-danger/10 px-3 py-1.5 text-danger">{entry.jobError}</div>
      )}
      {entry?.loadError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-edge bg-danger/10 px-3 py-1.5 text-danger">
          <span className="min-w-0 flex-1">자막 문서를 읽지 못했습니다 — {entry.loadError}</span>
          <button onClick={() => void useCaptionDoc.getState().reload(key)} className={smallBtn}>
            다시 읽기
          </button>
        </div>
      )}
      {readOnly && (
        <div className="shrink-0 border-b border-edge bg-warn/10 px-3 py-1.5 text-warn">
          새 버전 앱에서 만든 자막 문서라 읽기만 합니다 — 앱을 업데이트하면 고칠 수 있습니다.
        </div>
      )}
      {entry?.stale && doc && (
        <div className="shrink-0 border-b border-edge bg-warn/10 px-3 py-1.5 text-warn">
          원본 영상이 바뀌어 자막 시각이 어긋날 수 있습니다 — 오른쪽 위 ⟳로 다시 인식하세요.
        </div>
      )}
      {doc && !cutAllowed && !readOnly && (
        <div data-gpv="approx-note" className="shrink-0 border-b border-edge bg-warn/10 px-3 py-1.5 text-warn">
          {APPROX_CUT}
        </div>
      )}
      {entry?.conflict && (
        <div className="shrink-0 space-y-1 border-b border-edge bg-warn/10 px-3 py-1.5 text-warn">
          <div>다른 창에서 이 자막을 고쳐 저장했습니다. 여기 편집은 아직 저장되지 않았습니다.</div>
          <div className="flex gap-1.5">
            <button onClick={() => void useCaptionDoc.getState().reload(key)} className={smallBtn}>
              다시 불러오기(여기 편집 버림)
            </button>
            <button onClick={() => void useCaptionDoc.getState().overwriteConflict(key)} className={smallBtn}>
              여기 편집으로 덮어쓰기
            </button>
          </div>
        </div>
      )}
      {entry?.saveError && !entry.conflict && (
        <div className="flex shrink-0 items-start gap-2 border-b border-edge bg-danger/10 px-3 py-1.5 text-danger">
          <span className="min-w-0 flex-1">저장하지 못했습니다 — {entry.saveError}</span>
          <button onClick={() => void useCaptionDoc.getState().flush(key)} className={smallBtn}>
            다시 저장
          </button>
        </div>
      )}

      {/* 찾기·바꾸기 */}
      {find.open && doc && (
        <div data-gpv="transcript-find" className="shrink-0 space-y-1 border-b border-edge px-2 py-1.5">
          <div className="flex items-center gap-1">
            <input
              ref={findRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHit(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepHit(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeFind();
                }
              }}
              placeholder="찾기 (Enter 다음 · Shift+Enter 이전)"
              spellCheck={false}
              className={`${fieldCls} min-w-0 flex-1`}
            />
            <span className="w-12 shrink-0 text-center font-mono text-[10px] tabular-nums text-fg-dim">
              {query.trim() ? `${matches.length ? curHit + 1 : 0}/${matches.length}` : ""}
            </span>
            <button onClick={() => stepHit(-1)} disabled={!matches.length} title="이전" className={iconBtn}>
              ↑
            </button>
            <button onClick={() => stepHit(1)} disabled={!matches.length} title="다음" className={iconBtn}>
              ↓
            </button>
            <button
              data-gpv="find-cut-all"
              onClick={cutAllFound}
              disabled={!matches.length || locked || !cutAllowed}
              title="찾은 곳 모두 컷 — 단어 전체와 맞은 곳만 자릅니다(일부만 맞은 곳은 건너뜀)"
              className={iconBtn}
            >
              <Scissors size={12} />
            </button>
            <button
              data-gpv="filler-toggle"
              onClick={() => setFillerOpen((v) => !v)}
              disabled={locked || !cutAllowed}
              title="추임새 단어 목록 — 한 번에 자르기"
              className={`${iconBtn} text-[11px] ${fillerOpen ? "bg-raised text-accent" : ""}`}
            >
              추임새
            </button>
            <button
              onClick={() => setFind((f) => ({ ...f, replace: !f.replace }))}
              disabled={locked}
              title="바꾸기 열기/닫기"
              className={`${iconBtn} ${find.replace ? "text-accent" : ""}`}
            >
              <Replace size={12} />
            </button>
            <button onClick={closeFind} title="닫기 (Esc)" className={iconBtn}>
              <X size={12} />
            </button>
          </div>
          {find.replace && !locked && (
            <div className="flex items-center gap-1">
              <input
                value={repl}
                onChange={(e) => setRepl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    replaceOne();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                  }
                }}
                placeholder="바꿀 글 (텍스트만 — 영상·시각은 그대로)"
                spellCheck={false}
                className={`${fieldCls} min-w-0 flex-1`}
              />
              <button onClick={replaceOne} disabled={!cur} className={smallBtn}>
                바꾸기
              </button>
              <button onClick={replaceAll} disabled={!matches.length} className={smallBtn}>
                모두
              </button>
            </div>
          )}
          {fillerOpen && !locked && cutAllowed && (
            <div data-gpv="filler-row" className="space-y-1">
              <div className="flex items-center gap-1">
                <input
                  value={fillerText}
                  onChange={(e) => changeFillers(e.target.value)}
                  placeholder="추임새 단어 — 쉼표로 (예: 음, 어, 그)"
                  spellCheck={false}
                  className={`${fieldCls} min-w-0 flex-1`}
                />
                <button onClick={cutFillers} disabled={fillerIds.length === 0} className={smallBtn}>
                  {fillerIds.length}곳 모두 컷
                </button>
              </div>
              <div className="text-[11px] text-fg-dim">
                단어 전체가 목록과 같은 곳만 자릅니다(앞뒤 문장부호 무시). 인식 엔진이 추임새를 빼고 적는 일이 많아
                전부 잡히지는 않습니다.
              </div>
            </div>
          )}
        </div>
      )}

      {/* 무음 줄이기 */}
      {popup === "silence" && doc && (
        <SilencePanel
          doc={doc}
          blocked={readOnly ? "읽기 전용 문서입니다" : job ? "자막을 만드는 중입니다" : cutAllowed ? null : APPROX_CUT}
          locked={locked}
          onApply={(minMs, keepMs) => edit((d) => setCaptionSilence(d, { minMs, keepMs }))}
          onClear={() => edit((d) => setCaptionSilence(d, null))}
          onSeek={onSeekDocMs}
        />
      )}

      {/* 자막 파일 내보내기 */}
      {popup === "export" && doc && (
        <div data-gpv="subs-export" className="shrink-0 space-y-1.5 border-b border-edge px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-fg-dim">형식</span>
            <div className="flex overflow-hidden rounded border border-edge">
              {(["srt", "vtt", "txt"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => pickFormat(f)}
                  className={`px-2 py-0.5 uppercase ${fmt === f ? "bg-raised text-accent" : "hover:bg-raised"}`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-fg-dim">시각</span>
            <div className="flex overflow-hidden rounded border border-edge">
              {(["source", "edited"] as const).map((tl) => (
                <button
                  key={tl}
                  data-gpv={`subs-timeline-${tl}`}
                  onClick={() => setSubsTl(tl)}
                  title={
                    tl === "source"
                      ? "원본 영상의 시각 — 자른 말도 들어갑니다(원본에는 그 소리가 있다)"
                      : "편집본(대본 편집 반영 mp4)의 시각 — 자른 말을 빼고 뒤를 당깁니다"
                  }
                  className={`px-2 py-0.5 ${subsTl === tl ? "bg-raised text-accent" : "hover:bg-raised"}`}
                >
                  {tl === "source" ? "원본 시각" : "편집본 시각"}
                </button>
              ))}
            </div>
          </div>
          {subsLangAvail && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-fg-dim">글</span>
              <div className="flex overflow-hidden rounded border border-edge">
                {(["caption", "translation", "both"] as const).map((t) => (
                  <button
                    key={t}
                    data-gpv={`subs-text-${t}`}
                    onClick={() => setSubsText(t)}
                    className={`px-2 py-0.5 ${subsTextEff === t ? "bg-raised text-accent" : "hover:bg-raised"}`}
                  >
                    {t === "caption" ? "원문" : t === "translation" ? "번역" : "2단"}
                  </button>
                ))}
              </div>
              {subsTextEff !== "caption" &&
                (trLangs.length > 1 ? (
                  <select
                    aria-label="번역 언어"
                    value={subsLangAvail}
                    onChange={(e) => setTransPick(e.target.value)}
                    className={fieldCls}
                  >
                    {trLangs.map((l) => (
                      <option key={l} value={l}>
                        {captionLangLabel(l)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[11px]">{captionLangLabel(subsLangAvail)}</span>
                ))}
            </div>
          )}
          {subsGap && subsGap.missing > 0 && (
            <div data-gpv="subs-trans-missing" className="text-[11px] text-warn">
              {captionLangLabel(subsLang ?? "")} 번역이 {subsGap.missing}줄 빠졌습니다 — 원문으로 채우지 않으니 [번역]에서
              이어서 번역하세요.
            </div>
          )}
          {subsGap && subsGap.missing === 0 && subsGap.stale > 0 && (
            <div className="text-[11px] text-warn">
              원문을 고친 뒤 다시 번역하지 않은 줄 {subsGap.stale}개가 옛 번역 그대로 들어갑니다.
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-fg-dim" title={splitPath(path).dir || "./"}>
              {splitPath(path).dir || "./"}
            </span>
            <input
              value={outName}
              onChange={(e) => {
                nameEditedRef.current = true;
                setOutName(e.target.value);
              }}
              spellCheck={false}
              className={`${fieldCls} min-w-0 flex-1 font-mono`}
            />
          </div>
          {nameInvalid && (
            <div className="text-[11px] text-warn">
              파일명이 비었거나 \ / .. 를 포함하거나, 확장자가 .{fmt}가 아닙니다
            </div>
          )}
          <button
            onClick={() => void exportSubs(false)}
            disabled={nameInvalid || exporting || !!job || (!!subsGap && subsGap.missing > 0)}
            className="w-full rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted"
          >
            {exporting ? "저장 중…" : "자막 파일 저장"}
          </button>
        </div>
      )}

      {/* 번역 자막(P4) */}
      {popup === "translate" && doc && (
        <TranslatePanel
          capKey={key}
          doc={doc}
          lang={transLang}
          onLang={setTransPick}
          blocked={
            readOnly
              ? "새 버전 앱에서 만든 자막 문서라 읽기만 합니다"
              : job
                ? "자막을 만드는 중에는 번역할 수 없습니다"
                : null
          }
        />
      )}

      {/* 다시 인식 */}
      {popup === "form" && doc && !job && !readOnly && !translating && (
        <div className="shrink-0 border-b border-edge px-3 py-2">
          <TranscribeForm
            tool={tool}
            hasAudio={hasAudio}
            audioStreams={audioStreams}
            defaultTrack={doc.source.audioStream}
            label="다시 인식"
            onStart={start}
          />
        </div>
      )}

      {/* 본문 */}
      {doc ? (
        <div ref={listRef} className="min-h-0 flex-1 select-none overflow-y-auto">
          {doc.cues.map((cue, i) => {
            const [a, b] = spans[i];
            if (hideCut && rowTokens[i].every((t) => t.cut)) return null;
            const on = !!range && range[0] <= b && range[1] >= a;
            return (
              <CueRow
                key={cue.id}
                cue={cue}
                tokens={rowTokens[i]}
                first={a}
                selLo={on ? range[0] : -1}
                selHi={on ? range[1] : -1}
                captionText={captionTexts[i]}
                hits={hitsByCue.get(i)}
                curHit={cur && cur.cueIndex === i ? (cur.kind === "caption" ? "caption" : cur.tokenId) : null}
                editingTokenId={i === editingRow && editing?.kind === "word" ? editing.tokenId : null}
                editingCaption={editing?.kind === "caption" && editing.cueId === cue.id}
                trans={transRows?.[i].text}
                transStale={!!transRows?.[i].stale}
                editingTrans={editing?.kind === "trans" && editing.cueId === cue.id}
                readOnly={locked}
                hideCut={hideCut}
                silenceKeepMs={doc.silenceKeepMs}
                silenceMinMs={doc.silenceMinMs}
                h={h}
              />
            );
          })}
          {doc.cues.length === 0 && <div className="px-3 py-4 text-fg-dim">인식된 말이 없습니다.</div>}
        </div>
      ) : entry?.loading ? (
        <div className="px-3 py-4 text-fg-dim">자막 문서를 읽는 중…</div>
      ) : job ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <div className="mb-1 font-semibold text-fg">아직 자막이 없습니다</div>
          <div className="mb-3 text-fg-dim">
            이 영상의 음성을 이 컴퓨터에서 인식해 자막 초안을 만듭니다. 인터넷은 엔진·모델을 받을 때만 씁니다.
          </div>
          <TranscribeForm
            tool={tool}
            hasAudio={hasAudio}
            audioStreams={audioStreams}
            defaultTrack={0}
            label="자막 만들기"
            onStart={start}
          />
        </div>
      )}
    </div>
  );
});
