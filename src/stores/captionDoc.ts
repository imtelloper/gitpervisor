// 대본(자막 문서) 편집 상태 — 창마다 하나, 키 = projectId + relPath(태스크 72 §3.5).
//
// - 여기 두는 이유: 대본 패널은 토글·파일 전환(key={path})에 언마운트되는데, 자동 저장 대기(500ms)·전사 잡·
//   되돌리기 스택은 그보다 오래 살아야 한다(videoSplit 스토어와 같은 이유). 오버레이도 패널 없이 문서를 읽는다.
// - 저장은 **직렬**이다. 저장 중에 편집이 들어오면 끝난 뒤 한 번 더 저장한다 — 겹쳐 보내면 두 번째가 옛
//   base_rev로 가서 스스로 CONFLICT를 낸다.
// - 전사 종결은 invoke 응답과 `stt://finished` 중 먼저 온 쪽이 한 번만 처리한다(Windows 응답 유실,
//   videoSplit.ts 패턴). 결과는 이미 디스크에 있으므로 이벤트 쪽은 다시 읽는다. 토스트는 events.ts(localSttJobs).
// - 되돌리기는 패널 전용 불변 스냅샷 스택(상한 200, 편집 한 번 = 한 단계) — VideoPlayer의 editSnap과 섞지 않는다.
// - 번역(P4)도 여기서 돈다 — 배치마다 `edit`으로 문서에 쓰므로(되돌리기 한 단계·자동 저장) 창을 닫아도 번역한
//   데까지 남고, 다시 열면 빈 줄부터 이어 한다. 잡 자체는 창 수명이다.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  captionTranslatePending,
  setCaptionTranslations,
  translateCaptionItems,
  type CaptionChat,
} from "../lib/captionTranslate";
import { markLocalSttJob } from "../lib/events";
import { chatWithBusyRetry } from "../lib/llm";
import { sttRemainingMs } from "../lib/stt";
import type {
  CaptionChangedEvent,
  CaptionDoc,
  CaptionLoaded,
  CaptionPlan,
  SttFinishedEvent,
  SttPhase,
  SttProgressEvent,
} from "../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../lib/ipc";

const UNDO_LIMIT = 200;
const SAVE_DEBOUNCE_MS = 500;

export interface CaptionJob {
  id: string;
  phase: SttPhase;
  percent: number;
  /** 인식 단계에 들어간 시각(Date.now) — 남은 시간 추정의 기준. 그 전이면 null. */
  transcribeStartedAt: number | null;
  /** 남은 시간 추정(ms, `sttRemainingMs`) — 진행 보고 때마다 다시 잰다. 모르면 null. */
  remainingMs: number | null;
}

/** 번역 잡(P4) — done·failed는 이번 잡에서 처리한 cue 수(total 중). */
export interface CaptionTranslateJob {
  lang: string;
  total: number;
  done: number;
  failed: number;
  /** 사용자에게 보일 한 줄(모델 로드 중·다른 AI 작업 대기) — 번역이 흐르면 null. */
  status: string | null;
}

export interface CaptionEntry {
  projectId: string;
  relPath: string;
  loading: boolean;
  loadError: string | null;
  doc: CaptionDoc | null;
  /** 마지막으로 읽거나 저장한 rev — 저장의 base_rev. */
  baseRev: number;
  stale: boolean;
  plan: CaptionPlan | null;
  /** 디스크에 아직 안 간 편집이 있다. */
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  /** 다른 창이 먼저 저장했다 — 풀 때까지 저장하지 않는다(배너가 다시 읽기/덮어쓰기를 고르게 한다). */
  conflict: boolean;
  past: CaptionDoc[];
  future: CaptionDoc[];
  job: CaptionJob | null;
  jobError: string | null;
  translate: CaptionTranslateJob | null;
  /** 번역이 멈춘 이유 또는 끝났지만 못 한 줄의 안내. 취소면 null. */
  translateError: string | null;
}

export interface TranscribeOpts {
  modelId: string;
  language: string;
  prompt: string | null;
  /** 오디오 트랙(`VideoMeta.audioStreams[].index`). 없으면 백엔드 기본 0. */
  audioStream?: number;
}

/** 새 앱이 만든 문서(version > 1)는 읽기만 한다 — 옛 앱이 저장하면 모르는 필드를 버린다(백엔드도 거절). */
export function captionReadOnly(doc: CaptionDoc | null): boolean {
  return !!doc && doc.version > 1;
}

export function captionKey(projectId: string, relPath: string): string {
  return `${projectId}\n${relPath}`;
}

interface CaptionDocState {
  entries: Record<string, CaptionEntry>;
  /** 없으면 읽는다(이미 있거나 읽는 중이면 no-op). 플레이어가 파일을 열 때 부른다(오버레이). */
  ensureLoaded(projectId: string, relPath: string): void;
  /** 디스크 판으로 되돌린다 — 로컬 편집·되돌리기 스택을 버린다. */
  reload(key: string): Promise<void>;
  /** 편집 한 번 = 되돌리기 한 단계. fn이 null·같은 문서를 돌려주면 아무 것도 안 한다. 적용했으면 true. */
  edit(key: string, fn: (doc: CaptionDoc) => CaptionDoc | null): boolean;
  undo(key: string): void;
  redo(key: string): void;
  /** 대기 중인 저장을 지금 끝낸다 — 내보내기는 Rust가 저장본을 읽으므로 먼저 부른다. 깨끗하면 true. */
  flush(key: string): Promise<boolean>;
  /** 충돌 해소 — 디스크의 현재 rev를 기준으로 내 편집을 덮어쓴다. */
  overwriteConflict(key: string): Promise<void>;
  transcribe(projectId: string, relPath: string, opts: TranscribeOpts): Promise<void>;
  cancelTranscribe(key: string): void;
  /** 빠졌거나 원문이 바뀐 cue만 `lang`으로 번역한다(기본 LLM 모델). ctx = 설정 `llmContext`. */
  translate(key: string, lang: string, ctx: number): Promise<void>;
  /** 진행 중인 LLM 요청까지 끊는다(llm_cancel). 번역한 배치는 남는다. */
  cancelTranslate(key: string): void;
}

const blank = (projectId: string, relPath: string): CaptionEntry => ({
  projectId,
  relPath,
  loading: false,
  loadError: null,
  doc: null,
  baseRev: 0,
  stale: false,
  plan: null,
  dirty: false,
  saving: false,
  saveError: null,
  conflict: false,
  past: [],
  future: [],
  job: null,
  jobError: null,
  translate: null,
  translateError: null,
});

const saveTimers = new Map<string, number>();
const translateAborts = new Map<string, AbortController>();
/** 저장 중에 또 저장이 요청된 키 — 끝난 뒤 한 번 더 돈다. */
const saveQueued = new Set<string>();

let changedAttached = false;

export const useCaptionDoc = create<CaptionDocState>((set, get) => {
  const patch = (key: string, p: Partial<CaptionEntry>) =>
    set((s) => (s.entries[key] ? { entries: { ...s.entries, [key]: { ...s.entries[key], ...p } } } : s));

  const applyLoaded = (key: string, loaded: CaptionLoaded | null) =>
    patch(key, {
      loading: false,
      loadError: null,
      doc: loaded?.doc ?? null,
      baseRev: loaded?.doc.rev ?? 0,
      stale: loaded?.stale ?? false,
      plan: loaded?.plan ?? null,
      dirty: false,
      saveError: null,
      conflict: false,
      past: [],
      future: [],
    });

  const cancelTimer = (key: string) => {
    const t = saveTimers.get(key);
    if (t !== undefined) window.clearTimeout(t);
    saveTimers.delete(key);
  };

  const schedule = (key: string) => {
    cancelTimer(key);
    saveTimers.set(
      key,
      window.setTimeout(() => {
        saveTimers.delete(key);
        void save(key);
      }, SAVE_DEBOUNCE_MS),
    );
  };

  async function save(key: string): Promise<void> {
    const e = get().entries[key];
    if (!e?.doc || !e.dirty || e.conflict || captionReadOnly(e.doc)) return;
    if (e.saving) {
      saveQueued.add(key);
      return;
    }
    const sent = e.doc;
    patch(key, { saving: true });
    try {
      const r = await ipc.captionDocSave(e.projectId, e.relPath, sent, e.baseRev);
      const cur = get().entries[key];
      patch(key, { baseRev: r.rev, plan: r.plan, saving: false, saveError: null, dirty: cur?.doc !== sent });
    } catch (err) {
      if (isIpcError(err) && err.code === "CONFLICT") patch(key, { saving: false, conflict: true });
      else patch(key, { saving: false, saveError: errorMessage(err) });
    }
    // 저장 중에 들어온 편집 — 끝난 지금 한 번 더(실패·충돌이면 멈춘다: 다음 편집이나 배너가 다시 연다).
    saveQueued.delete(key);
    const after = get().entries[key];
    if (after?.dirty && !after.conflict && !after.saveError) await save(key);
  }

  // 다른 창의 저장·전사 — 미저장 편집이 없으면 다시 읽고, 있으면 충돌 배너(§3.4). 창 수명 동안 한 번만 단다.
  const attachChanged = () => {
    if (changedAttached) return;
    changedAttached = true;
    void listen<CaptionChangedEvent>("caption://changed", (ev) => {
      const key = captionKey(ev.payload.projectId, ev.payload.relPath);
      const e = get().entries[key];
      if (!e || ev.payload.rev === e.baseRev) return; // 우리가 방금 저장한 것(응답이 먼저 왔다)
      if (e.saving && ev.payload.rev === e.baseRev + 1) return; // 우리 저장의 메아리(이벤트가 먼저 왔다)
      if (e.job) return; // 우리 전사 결과 — 종결 처리가 다시 읽는다
      if (e.dirty) patch(key, { conflict: true });
      else void get().reload(key);
    });
  };

  const ensureEntry = (projectId: string, relPath: string) => {
    const key = captionKey(projectId, relPath);
    if (!get().entries[key]) set((s) => ({ entries: { ...s.entries, [key]: blank(projectId, relPath) } }));
    return key;
  };

  return {
    entries: {},

    ensureLoaded: (projectId, relPath) => {
      attachChanged();
      const key = captionKey(projectId, relPath);
      if (get().entries[key]) return;
      ensureEntry(projectId, relPath);
      void get().reload(key);
    },

    reload: async (key) => {
      const e = get().entries[key];
      if (!e) return;
      cancelTimer(key);
      saveQueued.delete(key);
      patch(key, { loading: true, loadError: null });
      try {
        applyLoaded(key, await ipc.captionDocLoad(e.projectId, e.relPath));
      } catch (err) {
        patch(key, { loading: false, loadError: errorMessage(err) });
      }
    },

    edit: (key, fn) => {
      const e = get().entries[key];
      if (!e?.doc || captionReadOnly(e.doc) || e.job) return false;
      const next = fn(e.doc);
      if (!next || next === e.doc) return false;
      const past = [...e.past, e.doc];
      if (past.length > UNDO_LIMIT) past.shift();
      patch(key, { doc: next, past, future: [], dirty: true, saveError: null });
      schedule(key);
      return true;
    },

    undo: (key) => {
      const e = get().entries[key];
      const prev = e?.past[e.past.length - 1];
      if (!e?.doc || !prev || e.job) return;
      patch(key, { doc: prev, past: e.past.slice(0, -1), future: [...e.future, e.doc], dirty: true });
      schedule(key);
    },

    redo: (key) => {
      const e = get().entries[key];
      const next = e?.future[e.future.length - 1];
      if (!e?.doc || !next || e.job) return;
      patch(key, { doc: next, future: e.future.slice(0, -1), past: [...e.past, e.doc], dirty: true });
      schedule(key);
    },

    flush: async (key) => {
      cancelTimer(key);
      // 저장 실패로 멈춘 문서도 한 번 다시 보낸다('다시 저장' 버튼·내보내기 직전) — 아래 고리는 **이번 호출 안에서**
      // 다시 실패했을 때만 멈춘다. 지우지 않으면 첫 검사에서 바로 false라 다시 저장이 아무 일도 안 한다.
      if (get().entries[key]?.saveError) patch(key, { saveError: null });
      // 진행 중인 저장이 끝나고 큐까지 비울 때까지 기다린다.
      for (;;) {
        const e = get().entries[key];
        if (!e?.doc) return false;
        if (!e.dirty && !e.saving) return true;
        if (e.conflict || e.saveError || captionReadOnly(e.doc)) return false;
        if (!e.saving) await save(key);
        else await new Promise((r) => window.setTimeout(r, 50));
      }
    },

    overwriteConflict: async (key) => {
      const e = get().entries[key];
      if (!e?.doc) return;
      try {
        const cur = await ipc.captionDocLoad(e.projectId, e.relPath);
        patch(key, { baseRev: cur?.doc.rev ?? 0, conflict: false, dirty: true, saveError: null });
        await save(key);
      } catch (err) {
        patch(key, { saveError: errorMessage(err) });
      }
    },

    transcribe: async (projectId, relPath, opts) => {
      attachChanged();
      const key = ensureEntry(projectId, relPath);
      // 번역 중엔 시작하지 않는다 — 재전사는 cue id를 새로 만들어 번역 배치가 붙을 곳이 사라진다(버튼도 막혀 있다).
      if (get().entries[key].job || get().entries[key].translate) return;
      // 대기 중인 자동 저장을 먼저 끝낸다 — 전사가 쓴 새 rev 뒤에 옛 base_rev 저장이 도착하면 CONFLICT가 나고,
      // 전사가 실패·취소되면 그 편집은 그대로 남아야 한다. 결과(충돌 등)와 무관하게 전사는 진행한다(사용자가 확인했다).
      await get().flush(key);
      if (get().entries[key].job) return;
      const id = crypto.randomUUID();
      patch(key, {
        job: { id, phase: "extract", percent: 0, transcribeStartedAt: null, remainingMs: null },
        jobError: null,
      });

      let settled = false;
      let unsubs: Array<() => void> = [];
      const settle = async (
        r: { ok: true; loaded: CaptionLoaded | null } | { ok: false; cancelled: boolean; error: string },
      ) => {
        if (settled) return;
        settled = true;
        unsubs.forEach((f) => f());
        if (r.ok) {
          if (r.loaded) applyLoaded(key, r.loaded);
          else await get().reload(key);
          patch(key, { job: null });
        } else {
          patch(key, { job: null, jobError: r.cancelled ? null : r.error });
        }
      };
      // 종결 리스너를 먼저 단다 — 초고속 실패가 등록 전에 지나가도 invoke 거부가 settle한다.
      try {
        unsubs = await Promise.all([
          listen<SttProgressEvent>("stt://progress", (ev) => {
            if (ev.payload.jobId !== id || settled) return;
            const { phase, percent } = ev.payload;
            const prev = get().entries[key]?.job;
            const now = Date.now();
            // 인식 단계 시작 시각 — 깨진 UTF-8 greedy 재시도는 진행이 10%로 되돌아가므로 그때 다시 잰다.
            const t0 =
              phase !== "transcribe"
                ? null
                : prev?.phase === "transcribe" && prev.transcribeStartedAt != null && prev.percent <= percent
                  ? prev.transcribeStartedAt
                  : now;
            patch(key, {
              job: {
                id,
                phase,
                percent,
                transcribeStartedAt: t0,
                remainingMs: t0 == null ? null : sttRemainingMs(now - t0, percent),
              },
            });
          }),
          listen<SttFinishedEvent>("stt://finished", (ev) => {
            if (ev.payload.jobId !== id) return;
            void settle(
              ev.payload.ok
                ? { ok: true, loaded: null }
                : { ok: false, cancelled: ev.payload.cancelled, error: ev.payload.error ?? "자막 만들기 실패" },
            );
          }),
        ]);
      } catch (err) {
        // 이벤트 없이 시작하면 응답 유실 때 영영 끝나지 않는 잡이 된다 — 시작하지 않는다.
        await settle({ ok: false, cancelled: false, error: `진행 이벤트를 구독하지 못했습니다 — ${errorMessage(err)}` });
        return;
      }
      markLocalSttJob(id, relPath.split("/").pop() ?? relPath);
      void ipc
        .sttTranscribe({ jobId: id, projectId, relPath, ...opts })
        .then(
          (loaded) => settle({ ok: true, loaded }),
          (err) =>
            settle({
              ok: false,
              cancelled: isIpcError(err) && err.code === "CANCELLED",
              error: errorMessage(err),
            }),
        );
    },

    cancelTranscribe: (key) => {
      const job = get().entries[key]?.job;
      if (!job) return;
      void ipc.sttTranscribeCancel(job.id).catch((err) => patch(key, { jobError: errorMessage(err) }));
    },

    translate: async (key, lang, ctx) => {
      const e = get().entries[key];
      if (!e?.doc || e.job || e.translate || captionReadOnly(e.doc)) return;
      const items = captionTranslatePending(e.doc, lang);
      if (items.length === 0) return;
      // 잡 도중 손으로 고친 번역 줄을 늦게 온 배치가 덮지 않게 — 시작할 때의 번역과 비교한다(setCaptionTranslations).
      const base = e.doc.translations?.[lang] ?? {};
      const ac = new AbortController();
      translateAborts.set(key, ac);
      patch(key, { translate: { lang, total: items.length, done: 0, failed: 0, status: null }, translateError: null });
      const bump = (p: Partial<CaptionTranslateJob> | ((j: CaptionTranslateJob) => Partial<CaptionTranslateJob>)) => {
        const j = get().entries[key]?.translate;
        if (j) patch(key, { translate: { ...j, ...(typeof p === "function" ? p(j) : p) } });
      };
      // 모델은 61처럼 설정의 기본 모델(modelId 없음). 배치 사이에 다른 AI 요청이 끼어들면 Busy 대기 후 이어 간다.
      // 토큰마다 스토어를 건드리면 패널이 토큰 수만큼 다시 그려진다 — 안내 줄이 있을 때만 지운다.
      const clearStatus = () => {
        if (get().entries[key]?.translate?.status) bump({ status: null });
      };
      const chat: CaptionChat = (messages, o) =>
        chatWithBusyRetry(messages, clearStatus, {
          ...o,
          signal: ac.signal,
          onProgress: (_phase, message) => bump({ status: message ?? null }),
          onBusy: () => bump({ status: "다른 AI 작업이 끝나면 이어서 번역합니다…" }),
        });
      try {
        await translateCaptionItems({
          items,
          lang,
          ctx,
          chat,
          signal: ac.signal,
          onChunk: (got, failedIds) => {
            // 번역한 데까지 곧바로 문서에 — 자동 저장·되돌리기 한 단계.
            const d = get().entries[key]?.doc;
            if (!d) throw new Error("자막 문서가 사라져 번역을 멈췄습니다");
            const next = got.length ? setCaptionTranslations(d, lang, got, base) : null;
            // edit이 거절하면(다른 창이 저장한 읽기 전용 새 판을 다시 읽었다 등) 번역이 문서에 안 들어간다 — 세지 않고 멈춘다.
            if (next && !get().edit(key, () => next))
              throw new Error("자막 문서를 고칠 수 없는 상태가 돼 번역을 멈췄습니다");
            bump((j) => ({ done: j.done + got.length, failed: j.failed + failedIds.length, status: null }));
          },
        });
        const failed = get().entries[key]?.translate?.failed ?? 0;
        patch(key, {
          translate: null,
          translateError: failed
            ? `${failed}줄은 모델이 형식에 맞게 답하지 않아 번역하지 못했습니다 — 다시 번역하면 그 줄만 다시 합니다`
            : null,
        });
      } catch (err) {
        const cancelled = ac.signal.aborted || (isIpcError(err) && err.code === "CANCELLED");
        patch(key, { translate: null, translateError: cancelled ? null : `번역 실패 — ${errorMessage(err)}` });
      } finally {
        translateAborts.delete(key);
      }
    },

    cancelTranslate: (key) => {
      translateAborts.get(key)?.abort();
    },
  };
});
