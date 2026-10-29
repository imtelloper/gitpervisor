// 저장 안 한 PDF 편집의 세션 간 초안(태스크 75 T5, 설계 §8.3) — 앱을 강제로 꺼도 다음에 같은 판을 열면 복원한다.
//
// 저장소는 이미지 편집기 사이드카(commands/image_doc.rs, kind "doc")를 그대로 쓴다: 키가 sha256(projectId \0 relPath)
// 라 PDF 경로가 이미지 문서와 겹칠 수 없고(이미지 편집기는 이미지에만 열린다), 원자적 쓰기(tmp→rename)·32MB 상한·
// 레포 오염 0 이 이미 거기 있다. 봉투 모양만 다르다 — 이 파일만 읽고 쓴다.
//
// 장부의 `saved`(노드 **참조**)는 직렬화할 수 없다. 복원은 디스크를 다시 가져온 결과(importAnnotations)에서 **ref 로**
// saved 를 다시 잇는다(restoreDraft). id 로 잇지 않는 이유: /NM 없는 다른 앱 주석은 가져올 때마다 새 UUID 를 받는다.
// stamp 가 다르면 refs 가 엉뚱한 객체를 가리키므로 복원하지 않는다(pro 설계 부록 D 의 교훈).

import { normalizeDoc } from "../annotate/schema";
import type { EditorDoc } from "../annotate/types";
import { ipc } from "../ipc";
import type { PageOp, PdfLedger, PdfMarkup } from "./model";

const DEBOUNCE_MS = 2000;

type PageOfValue = PdfLedger["pageOf"] extends Map<string, infer V> ? V : never;

/** 초안에 담는 편집 상태 — 세션에서 히스토리·폰트·infos 를 뺀 것. */
export interface PdfDraftInput {
  /** 편집이 올라탄 디스크 판. */
  stamp: string;
  pages: EditorDoc[];
  markups: PdfMarkup[];
  pageOps: PageOp[];
  ledger: PdfLedger;
}

export interface PdfDraft {
  v: 1;
  stamp: string;
  savedAt: number;
  pages: EditorDoc[];
  markups: PdfMarkup[];
  pageOps: PageOp[];
  refs: [string, string][];
  pageOf: [string, PageOfValue][];
}

export function serializeDraft(d: PdfDraftInput): string {
  const out: PdfDraft = {
    v: 1,
    stamp: d.stamp,
    savedAt: Date.now(),
    pages: d.pages,
    markups: d.markups,
    pageOps: d.pageOps,
    refs: [...d.ledger.refs],
    pageOf: [...d.ledger.pageOf],
  };
  return JSON.stringify(out);
}

/** 사이드카 문자열 → 초안. 모양이 틀리면 던진다(조용히 빈 편집으로 복원하면 사용자는 편집이 사라졌다고 본다). */
export function parseDraft(json: string): PdfDraft {
  const raw: unknown = JSON.parse(json);
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PdfDraft>; // 외부 데이터 경계
  if (r.v !== 1 || typeof r.stamp !== "string" || !Array.isArray(r.pages) || !Array.isArray(r.refs) || !Array.isArray(r.pageOf)) {
    throw new Error(`parseDraft: not a PDF draft envelope (v=${String(r.v)})`);
  }
  return {
    v: 1,
    stamp: r.stamp,
    savedAt: typeof r.savedAt === "number" ? r.savedAt : 0,
    pages: r.pages.map((p) => normalizeDoc(p)),
    markups: Array.isArray(r.markups) ? r.markups : [],
    pageOps: Array.isArray(r.pageOps) ? r.pageOps : [],
    refs: r.refs,
    pageOf: r.pageOf,
  };
}

/**
 * 초안 + 같은 판을 다시 가져온 장부 → 복원 상태. saved 는 ref 로 잇고, 내용이 디스크와 같은 노드는 가져온 노드 참조로
 * 바꿔 끼운다 — 그래야 손대지 않은 주석이 dirty 로 잡혀 다음 저장에서 다시 쓰이지 않는다.
 */
export function restoreDraft(
  d: PdfDraft,
  imported: PdfLedger,
): { pages: EditorDoc[]; markups: PdfMarkup[]; pageOps: PageOp[]; ledger: PdfLedger } {
  const byRef = new Map<string, string>();
  for (const [id, ref] of imported.refs) byRef.set(ref, id);
  const ledger: PdfLedger = { refs: new Map(d.refs), saved: new Map(), pageOf: new Map(d.pageOf) };
  for (const [id, ref] of ledger.refs) {
    const from = byRef.get(ref);
    const v = from === undefined ? undefined : imported.saved.get(from);
    if (v !== undefined) ledger.saved.set(id, v);
  }
  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
  const pages = d.pages.map((doc) => ({
    ...doc,
    objects: doc.objects.map((n) => {
      const s = ledger.saved.get(n.id);
      return s && "kind" in s && same(s, n) ? s : n;
    }),
  }));
  const markups = d.markups.map((mk) => {
    const s = ledger.saved.get(mk.id);
    return s && !("kind" in s) && same(s, mk) ? s : mk;
  });
  return { pages, markups, pageOps: d.pageOps, ledger };
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export async function readPdfDraft(projectId: string, path: string): Promise<PdfDraft | null> {
  const r = await ipc.imageDocRead(projectId, path, "doc");
  return r.json === null ? null : parseDraft(r.json);
}

export function deletePdfDraft(projectId: string, path: string): Promise<void> {
  return ipc.imageDocDelete(projectId, path);
}

/**
 * 편집마다 부르는 2초 디바운스 저장기. 쓰기·지우기는 한 줄로 이어 돈다 — 저장 직후의 지우기가 아직 날아가는 쓰기보다
 * 먼저 끝나 초안이 되살아나지 않게.
 */
export function createDraftSaver(projectId: string, path: string, onError: (e: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => PdfDraftInput | null) | null = null;
  /** 디스크에 이 파일의 초안이 있을 수 있나 — 없으면 clear 가 IPC 를 부르지 않는다. */
  let stored = false;
  let chain: Promise<void> = Promise.resolve();
  const run = (op: () => Promise<void>) => (chain = chain.then(op).catch(onError));

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    const get = pending;
    pending = null;
    const body = get?.();
    if (!body) return chain;
    stored = true;
    return run(async () => {
      await ipc.imageDocWrite(projectId, path, "doc", serializeDraft(body));
    });
  };

  return {
    /** `get` 은 쓰는 순간 불린다 — 2초 안의 편집이 모두 마지막 상태 하나로 묶인다. null 이면 쓰지 않는다. */
    schedule(get: () => PdfDraftInput | null) {
      pending = get;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    flush,
    /** 저장 성공·편집 버림 — 예약을 취소하고 초안을 지운다. */
    clear(): Promise<void> {
      clearTimeout(timer);
      pending = null;
      if (!stored) return chain;
      stored = false;
      return run(() => deletePdfDraft(projectId, path));
    },
    /** 디스크에서 초안을 찾았을 때 — 이후 clear 가 실제로 지우게. */
    markStored() {
      stored = true;
    },
  };
}

export type PdfDraftSaver = ReturnType<typeof createDraftSaver>;
