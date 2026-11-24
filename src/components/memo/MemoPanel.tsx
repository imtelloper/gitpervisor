import { ImagePlus, Plus, StickyNote, Tag, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";

import { useMessages } from "../../i18n/ui-language";
import { registerDraftFlush } from "../../lib/drafts";
import { shortDate } from "../../lib/format";
import { errorMessage, ipc, type Memo } from "../../lib/ipc";
import { addMemoImage, blobFromBase64 } from "../../lib/memo-image-pipeline";
import {
  MEMO_SORTS,
  memoCategories,
  memoFilterValue,
  memoTitle,
  parseMemoFilter,
  parseMemoSort,
  visibleMemos,
  type MemoCategoryFilter,
  type MemoSort,
} from "../../lib/memo-list";
import { memoImageToken } from "../../lib/memo-tokens";
import { assignProjectSlots, useAppliedProjectPalette } from "../../lib/project-color";
import {
  useAddMemo,
  useDeleteMemo,
  useNotes,
  useRenameMemoCategory,
  useReorderMemos,
  useSetMemoCategory,
  useUpdateMemo,
} from "../../queries";
import { useUi } from "../../stores/ui";
import { MarkdownBody } from "../diff/MarkdownView";
import { MemoCategoryMenu } from "./MemoCategoryMenu";
import type { MemoEditorHandle } from "./MemoEditor";
import { MemoMarkdownImage } from "./MemoMarkdownImage";

// CodeMirror 는 메모장을 처음 열 때만 불러온다 — 타이틀바(메모장 버튼)는 앱이 뜨는 순간부터 있다.
const MemoEditor = lazy(() => import("./MemoEditor"));

// MD 보기에서도 메모 이미지가 보이게 — 본문의 `memo-img/…` 주소를 앱 데이터의 이미지로 푼다.
const MEMO_MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => (
    <MemoMarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />
  ),
};

// 정렬은 스코프 공통 취향(gp:memo-md 와 같은 급), 카테고리 필터는 스코프마다 따로다 — 카테고리 집합이 스코프마다 다르다.
const MEMO_SORT_KEY = "gp:memo-sort";

/**
 * 편집 중인 본문과 **그 주인**. 둘을 따로 두면 어긋난다 — 메모를 바꾼 직후나 "새 메모" 직후에는 화면의
 * active 가 아직 따라오지 않은 렌더가 있고, 그때 본문만 보고 저장하면 다른 메모가 덮인다.
 * - base = 이 메모에서 마지막으로 불러왔거나 저장한 본문. text !== base 면 "내가 고친 게 있다".
 */
interface MemoDraft {
  ownerId: string | null;
  text: string;
  base: string;
}

interface MemoPanelProps {
  /** 메모가 묶이는 키 — 프로젝트 id 또는 GLOBAL_NOTES_ID */
  scopeId: string;
  /** 목록 헤더에 보일 이름(프로젝트명 또는 "전역 메모") */
  scopeLabel: string;
  /** 닫기 버튼(X) 클릭 */
  onClose: () => void;
  /** 부모가 닫기 직전에 호출할 flush 함수를 심어 준다(빈 메모 정리 + 미저장분 즉시 저장). */
  flushRef?: React.RefObject<(() => void) | null>;
  /** 목록 헤더 왼쪽에 아이콘+이름 대신 놓을 것 — 전역 메모 팝오버의 "메모 | 할 일" 탭. */
  headerLead?: React.ReactNode;
}

/**
 * 메모 목록(좌) + 편집기(우) 패널 — scopeId만 갈아끼우면 프로젝트 메모/전역 메모 어느 쪽에도 쓴다.
 *
 * 크기·테두리·배경·그림자는 **부모(모달/팝오버)가 갖는다**. 같은 UI가 820x560 모달과
 * 720x420 팝오버 두 껍데기에 들어가야 해서, 여기서 크기를 정하면 한쪽이 반드시 깨진다.
 * Esc·바깥 클릭 닫기도 껍데기마다 달라 부모 몫이다.
 */
export function MemoPanel({
  scopeId,
  scopeLabel,
  onClose,
  flushRef,
  headerLead,
}: MemoPanelProps) {
  const msg = useMessages();
  const t = msg.notes.memoPanel;
  const { data: notes } = useNotes();

  const addMemo = useAddMemo();
  const updateMemo = useUpdateMemo();
  const deleteMemo = useDeleteMemo();
  const setMemoCategory = useSetMemoCategory();
  const renameMemoCategory = useRenameMemoCategory();

  // 배열 순서가 정본(notes.json Vec). add_memo가 push하므로 역순 = 새 메모가 위 — 이것이 "수동 순서"다.
  // 정렬·필터는 아래 visibleMemos 가 **표시만** 바꾸고 이 배열은 건드리지 않는다.
  const scopeMemos = useMemo(
    () => [...(notes?.[scopeId] ?? [])].reverse(),
    [notes, scopeId],
  );
  const categories = useMemo(() => memoCategories(scopeMemos), [scopeMemos]);

  const [sort, setSort] = useState<MemoSort>(() =>
    parseMemoSort(localStorage.getItem(MEMO_SORT_KEY)),
  );
  function changeSort(next: MemoSort) {
    if (next === "manual") localStorage.removeItem(MEMO_SORT_KEY);
    else localStorage.setItem(MEMO_SORT_KEY, next);
    setSort(next);
  }

  const filterKey = `gp:memo-category:${scopeId}`;
  const [storedFilter, setStoredFilter] = useState<MemoCategoryFilter>(() =>
    parseMemoFilter(localStorage.getItem(filterKey)),
  );
  function changeFilter(next: MemoCategoryFilter) {
    if (next.kind === "all") localStorage.removeItem(filterKey);
    else localStorage.setItem(filterKey, memoFilterValue(next));
    setStoredFilter(next);
  }
  // 기억해 둔 카테고리가 사라졌으면(마지막 메모가 지워짐·다른 분류로 옮김) 전체로 본다. 저장값은 두어서
  // 그 카테고리가 다시 생기면 돌아온다.
  const filter: MemoCategoryFilter =
    storedFilter.kind === "category" &&
    !categories.some((c) => c.name === storedFilter.name)
      ? { kind: "all" }
      : storedFilter;

  // 마지막으로 보던 메모를 스코프별로 기억한다 — 전역/프로젝트가 서로를 덮지 않게 키를 나눈다.
  const activeKey = `gp:memo-active:${scopeId}`;
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(activeKey),
  );
  // "새 메모" 직후, 낙관적 추가가 캐시에 닿기 전까지 그 메모를 대신한다. 없으면 그 사이 active 가
  // 목록의 첫 메모로 넘어갔다 돌아오면서 편집기가 남의 본문을 한 번 싣는다.
  const [pendingAdd, setPendingAdd] = useState<Memo | null>(null);
  // **활성 메모는 표시 목록이 아니라 스코프 전체에서 찾는다.** 필터를 바꾸거나 이 메모의 카테고리를 바꿔
  // 필터에서 빠져도 활성으로 남는다 — 표시 목록에서 찾으면 그 순간 다른 메모로 넘어가면서 치던 마지막
  // 입력이 flush 없이 버려진다.
  const active =
    scopeMemos.find((m) => m.id === activeId) ??
    (pendingAdd?.id === activeId ? pendingAdd : null) ??
    visibleMemos(scopeMemos, { sort, filter })[0] ??
    null;
  const memos = visibleMemos(scopeMemos, { sort, filter, keepId: active?.id });
  // 순서 바꾸기는 수동 순서 + 전체일 때만. 정렬된 표시 순서를 reorder_memos 로 보내면 그게 정본이 되고,
  // 필터로 빠진 메모는 "목록에 없는 id" 취급을 받아 꼬리로 밀린다(notes.rs).
  const canDragReorder = sort === "manual" && filter.kind === "all";

  const palette = useAppliedProjectPalette();
  const categorySlots = useMemo(
    () => assignProjectSlots(categories.map((c) => c.name)),
    [categories],
  );
  function categoryColor(name: string): string | undefined {
    const slot = categorySlots.get(name);
    return slot === undefined ? undefined : palette[slot].stripe;
  }

  const [draft, setDraft] = useState<MemoDraft>({ ownerId: null, text: "", base: "" });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editorRef = useRef<MemoEditorHandle | null>(null);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const categoryWrapRef = useRef<HTMLSpanElement>(null);

  // MD 모드는 전역 설정(스코프 공통) — 전역 메모와 프로젝트 메모를 오갈 때 모드가 바뀌면
  // 같은 패널이 껍데기에 따라 달리 보인다.
  const [mdMode, setMdMode] = useState(
    () => localStorage.getItem("gp:memo-md") === "1",
  );
  // 반대로 "지금 이 메모를 고쳐 쓰는 중"은 과도 상태라 영속하지 않는다 — 다시 열면
  // 렌더된 본문부터 보는 게 MD 모드를 켠 이유다.
  const [editing, setEditing] = useState(false);
  function toggleMdMode() {
    const next = !mdMode;
    if (next) localStorage.setItem("gp:memo-md", "1");
    else localStorage.removeItem("gp:memo-md");
    setMdMode(next);
    setEditing(false);
  }
  // 편집기는 이 setState 뒤에 마운트되면서 스스로 포커스를 잡고 커서를 끝에 둔다(MemoEditor 의 autoFocus).
  // 여기서 타이머로 잡으면 lazy 청크가 아직 안 온 첫 진입에서 헛돈다.
  function startEditing() {
    setEditing(true);
  }

  // 스코프가 바뀌면 그 스코프가 마지막에 보던 메모·필터로 갈아끼운다 — 이전 스코프의 것이 남으면
  // 첫 렌더에서 엉뚱한 메모를 가리킨다.
  useEffect(() => {
    setActiveId(localStorage.getItem(activeKey));
    setStoredFilter(parseMemoFilter(localStorage.getItem(filterKey)));
    setPendingAdd(null);
  }, [activeKey]);

  useEffect(() => {
    if (pendingAdd && scopeMemos.some((m) => m.id === pendingAdd.id)) setPendingAdd(null);
  }, [scopeMemos, pendingAdd]);

  // active 메모가 바뀌면 본문 로드. 기억은 activeId가 아니라 **실효 active.id**로 — 아무것도
  // 고르지 않고 첫 메모를 보다 닫은 경우도 그 메모로 복원된다.
  useEffect(() => {
    const text = active?.text ?? "";
    setDraft({ ownerId: active?.id ?? null, text, base: text });
    setCategoryMenuOpen(false);
    if (active?.id) localStorage.setItem(activeKey, active.id);
  }, [active?.id]);

  // 같은 메모의 저장된 본문이 **밖에서** 바뀌었고(다른 창이 고침 → notes://changed → 재조회) 내가 고친 게
  // 없으면 따라간다. 안 따라가면 이 창은 옛 본문을 든 채로 남고, 떠날 때의 정리(flush)가 "빈 메모"로 보고
  // 그 창이 쓴 내용을 지운다. 내가 고친 게 있으면 그대로 둔다 — 마지막 저장이 이긴다.
  useEffect(() => {
    if (!active) return;
    const saved = active.text;
    const d = draftRef.current;
    // 편집기가 떠 있으면 "내가 고친 게 있나"는 그 문서로 본다 — 방금 친 글자가 아직 draft 로 렌더되지 않았을 수 있다.
    const typed = editorRef.current ? editorRef.current.getDoc() : d.text;
    if (d.ownerId !== active.id || typed !== d.base || saved === d.base) return;
    editorRef.current?.replaceDoc(saved);
    setDraft((cur) =>
      cur.ownerId === active.id && cur.text === cur.base
        ? { ...cur, text: saved, base: saved }
        : cur,
    );
  }, [active?.text]);

  function saveDraftText(memoId: string, text: string) {
    updateMemo.mutate({ projectId: scopeId, memoId, text });
    setDraft((d) => (d.ownerId === memoId ? { ...d, base: text } : d));
  }

  // 디바운스 자동 저장 — 고친 게 없으면(text === base) 쓸 것이 없고, 주인이 다르면 아직 화면의
  // active가 따라오지 않은 과도기다(위 MemoDraft 주석).
  useEffect(() => {
    if (!active || draft.ownerId !== active.id || draft.text === draft.base) return;
    const memoId = active.id;
    const text = draft.text;
    const timer = setTimeout(() => saveDraftText(memoId, text), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.text, draft.base, draft.ownerId]);

  // 부모가 닫기 직전에 부를 수 있도록 최신 flush를 심어 둔다(deps 없음 = 매 렌더 갱신).
  // **언마운트 정리에서 flush하면 안 된다** — 이 앱은 React.StrictMode라 개발 모드에서 마운트가
  // 즉시 한 번 버려지고, 그때 아직 비어 있는 새 메모가 "빈 메모 정리"에 걸려 지워진다.
  // 그래서 정리 시점이 아니라 부모의 명시적 호출로만 flush한다.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  });

  // health 경보(warn↑) 때도 같은 flush를 돌린다 — OS가 메모리 부족으로 앱을 죽이면 500ms
  // 디바운스에 걸려 있던 본문이 통째로 날아간다(2026-09-02 NTS, lib/drafts.ts).
  // 등록은 마운트 때 한 번이고, 최신 flush는 ref로 따라간다(매 렌더 재등록 방지).
  const flushLatest = useRef(flush);
  flushLatest.current = flush;
  useEffect(() => registerDraftFlush(() => flushLatest.current()), []);

  // 떠날 때: 고친 게 있으면 즉시 저장(비웠으면 삭제), 손대지 않은 빈 메모는 정리.
  // - 주인 불일치(= 메모 전환·새 메모 직후의 과도기)에는 손대지 않는다.
  // - 손대지 않은 메모는 **저장된 본문도 비었을 때만** 지운다. 이 창의 draft 만 보고 지우면, 다른 창이
  //   그 사이 채운 메모를 "빈 메모"로 보고 지운다.
  function flush() {
    const d = draftRef.current;
    if (!active || d.ownerId !== active.id) return;
    // 편집기가 떠 있으면 본문은 그 문서에서 읽는다 — draft 는 편집기의 onChange 가 렌더를 거쳐야 따라오므로,
    // 방금 친 글자가 아직 안 실렸을 수 있다. textarea 때는 입력이 React 이벤트라 이 틈이 없었다.
    const text = editorRef.current ? editorRef.current.getDoc() : d.text;
    if (text !== d.base) {
      if (text.trim() === "") deleteMemo.mutate({ projectId: scopeId, memoId: active.id });
      else saveDraftText(active.id, text);
    } else if (text.trim() === "" && active.text.trim() === "") {
      deleteMemo.mutate({ projectId: scopeId, memoId: active.id });
    }
  }
  function selectMemo(id: string) {
    // 이미 보고 있는 메모를 다시 누른 것은 "떠남"이 아니다 — flush 하면 방금 만든 빈 메모가 그 클릭에 지워진다.
    if (id !== active?.id) flush();
    setActiveId(id);
    setEditing(false);
  }
  function handleAdd() {
    flush();
    const id = crypto.randomUUID();
    // 필터가 걸려 있으면 그 카테고리로 만든다 — 미분류로 만들면 만든 메모가 지금 목록에 속하지 않는다.
    const category = filter.kind === "category" ? filter.name : undefined;
    addMemo.mutate({ projectId: scopeId, memoId: id, category });
    const now = new Date().toISOString();
    setPendingAdd({
      id,
      text: "",
      createdAt: now,
      updatedAt: now,
      ...(category ? { category } : {}),
    });
    setActiveId(id);
    setDraft({ ownerId: id, text: "", base: "" });
    setEditing(true);
  }

  // 헤더의 "이미지" 버튼 — 붙여넣기·드롭이 안 되는 환경에서도 통하는 길이다.
  async function pickImage() {
    if (!active) return;
    const memoId = active.id;
    try {
      const picked = await ipc.assetPickFile();
      // 대화상자가 떠 있는 동안 다른 메모로 넘어갔으면 넣지 않는다 — 엉뚱한 메모에 들어간다.
      if (!picked || draftRef.current.ownerId !== memoId) return;
      const image = blobFromBase64(picked.base64, picked.mime);
      if (editorRef.current) {
        editorRef.current.insertImages([image]);
      } else {
        // 편집기가 없다(MD 보기 — 대화상자가 포커스를 가져가며 렌더 뷰로 돌아갔다). 커서가 없으니 끝에 붙인다.
        const token = memoImageToken(addMemoImage(image));
        setDraft((d) =>
          d.ownerId === memoId ? { ...d, text: d.text ? `${d.text}\n${token}` : token } : d,
        );
      }
    } catch (e) {
      useUi.getState().pushToast("error", errorMessage(e));
    }
  }

  // ── 카테고리 ──
  // 메뉴 바깥을 누르면 닫는다. 칩 버튼까지 "안"으로 쳐야 한다 — 칩을 다시 눌러 닫을 때 이 리스너가 먼저
  // 닫고 click 이 다시 여는 왕복이 생긴다.
  useEffect(() => {
    if (!categoryMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && categoryWrapRef.current?.contains(e.target)) return;
      setCategoryMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [categoryMenuOpen]);

  function assignCategory(name: string | null) {
    if (!active) return;
    setMemoCategory.mutate({ projectId: scopeId, memoId: active.id, category: name });
    setCategoryMenuOpen(false);
  }
  function renameCategory(from: string, to: string | null) {
    renameMemoCategory.mutate({ projectId: scopeId, from, to });
    // 걸어 둔 필터가 그 카테고리였으면 새 이름을 따라간다(해제면 전체로).
    if (storedFilter.kind === "category" && storedFilter.name === from)
      changeFilter(to ? { kind: "category", name: to } : { kind: "all" });
  }

  // ── 드래그 순서 정렬 (포인터 기반, ProjectList와 같은 방식) ──
  // HTML5 drag&drop은 WebView2에서 불안정하다. 좌클릭 후 임계(5px)를 넘게 움직이면 드래그로
  // 전환 → 항목 중점 기준으로 삽입 위치(overId, null=맨 끝) 표시 → 떼면 재정렬한다.
  const reorder = useReorderMemos();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 드래그가 성립하면 뒤따르는 click 한 번을 up()이 캡처 단계에서 삼킨다(아래 주석).
  function beginDrag(e: React.PointerEvent, id: string) {
    if (e.button !== 0 || !canDragReorder) return; // 좌클릭만, 수동 순서 + 전체일 때만
    const startY = e.clientY;
    let dragging = false;
    let over: string | null = null;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return; // 클릭/드래그 구분 임계
        dragging = true;
        setDragId(id);
      }
      const cont = listRef.current;
      if (!cont) return;
      let target: string | null = null;
      for (const el of cont.querySelectorAll<HTMLElement>("[data-memo-id]")) {
        // 끌고 있는 행 자신은 후보에서 뺀다 — 넣어 두면 그 행의 위쪽 절반에서 놓았을 때
        // over === id 가 되고, 아래 up()이 splice 후 indexOf에서 -1을 받아 **맨 끝으로** 보낸다
        // (표시선도 안 뜨는 상태라 사용자는 이유를 못 본다). 빼면 바로 다음 행이 잡혀 제자리다.
        if (el.dataset.memoId === id) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          target = el.dataset.memoId ?? null;
          break;
        }
      }
      over = target;
      setOverId(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragId(null);
      setOverId(null);
      if (!dragging) return; // 임계 미달 = 단순 클릭 → onClick이 선택 처리
      // 드래그 뒤 따라오는 click 한 번을 **캡처 단계에서** 삼킨다. 행의 onClick만 막으면
      // 부족하다 — 포인터를 모달 배경 위에서 놓으면 click은 pointerdown(행)과 pointerup(배경)의
      // 공통 조상인 배경 div로 가고, 그 onClick이 메모장을 닫아 버린다(MemoDialog.tsx).
      const swallow = (ev: MouseEvent) => ev.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      // click이 아예 안 오는 경우(창 밖에서 놓기 등)를 위해 같은 태스크에서 걷어낸다.
      setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        0,
      );
      const ids = memos.map((m) => m.id);
      const fromIdx = ids.indexOf(id);
      if (fromIdx === -1) return;
      ids.splice(fromIdx, 1);
      let at = over == null ? ids.length : ids.indexOf(over);
      if (at === -1) at = ids.length;
      ids.splice(at, 0, id);
      // 표시가 배열의 역순이므로 저장할 순서도 되뒤집는다.
      reorder.mutate({ projectId: scopeId, orderedIds: ids.reverse() });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function handleDelete() {
    if (!active) return;
    const idx = memos.findIndex((m) => m.id === active.id);
    deleteMemo.mutate({ projectId: scopeId, memoId: active.id });
    const next = memos[idx + 1] ?? memos[idx - 1] ?? null;
    setActiveId(next?.id ?? null);
  }

  // 수동 순서가 아니면 새 메모·방금 고친 메모가 화면 밖에 놓일 수 있다.
  useEffect(() => {
    if (!active?.id) return;
    listRef.current
      ?.querySelector(`[data-memo-id="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.id, sort]);

  function sortLabel(s: MemoSort): string {
    switch (s) {
      case "manual":
        return t.sortManual;
      case "updated":
        return t.sortUpdated;
      case "created":
        return t.sortCreated;
      case "title":
        return t.sortByTitle;
      default: {
        const unreachable: never = s;
        return unreachable;
      }
    }
  }
  const selectClass =
    "rounded border border-edge bg-raised px-1 py-0.5 text-[11px] text-fg-muted outline-none hover:text-fg focus:border-accent";

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 좌: 메모 목록 */}
      <div className="flex w-[240px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2.5">
          {headerLead ?? (
            <>
              <StickyNote size={14} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                {scopeLabel}
              </span>
            </>
          )}
          <span className="ml-auto text-[11px] text-fg-dim">{memos.length}</span>
        </div>

        <div className="flex items-center gap-1 border-b border-edge px-2 py-1.5">
          {/* 카테고리가 하나도 없으면 고를 것이 없다 — 정렬만 보인다. */}
          {categories.length > 0 && (
            <select
              data-memo-filter
              value={memoFilterValue(filter)}
              onChange={(e) => changeFilter(parseMemoFilter(e.target.value))}
              title={t.filterTitle}
              className={`min-w-0 flex-1 ${selectClass}`}
            >
              <option value="all">{t.filterAll(scopeMemos.length)}</option>
              <option value="none">
                {t.filterUncategorized(scopeMemos.filter((m) => !m.category).length)}
              </option>
              {categories.map((c) => (
                <option key={c.name} value={memoFilterValue({ kind: "category", name: c.name })}>
                  {t.filterCategory(c.name, c.count)}
                </option>
              ))}
            </select>
          )}
          <select
            data-memo-sort
            value={sort}
            onChange={(e) => changeSort(parseMemoSort(e.target.value))}
            title={t.sortTitle}
            className={`ml-auto shrink-0 ${selectClass}`}
          >
            {MEMO_SORTS.map((s) => (
              <option key={s} value={s}>
                {sortLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {memos.map((m) => (
            <button
              key={m.id}
              data-memo-id={m.id}
              onPointerDown={(e) => beginDrag(e, m.id)}
              onClick={() => selectMemo(m.id)}
              className={`relative block w-full border-b border-edge/40 px-3 py-2 text-left ${
                active?.id === m.id ? "bg-selection" : "hover:bg-raised"
              } ${dragId === m.id ? "opacity-40" : ""}`}
            >
              {overId === m.id && dragId !== m.id && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent"
                />
              )}
              <div className="truncate text-[13px] text-fg">
                {memoTitle(m.text, t.untitledMemo)}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-dim">
                {m.category && (
                  <>
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: categoryColor(m.category) }}
                    />
                    <span className="min-w-0 truncate">{m.category}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                {/* 생성일순으로 볼 때는 줄을 세운 그 날짜를 보인다. */}
                <span className="shrink-0">
                  {shortDate(sort === "created" ? m.createdAt : m.updatedAt)}
                </span>
              </div>
            </button>
          ))}
          {/* 맨 끝에 삽입할 때의 표시선 */}
          {dragId && overId === null && <div className="mx-2 h-0.5 bg-accent" />}
          {memos.length === 0 && (
            <div className="px-3 py-4 text-[12px] leading-5 text-fg-dim">
              {scopeMemos.length === 0 ? (
                <>
                  {t.emptyListLine1}
                  <br />
                  {t.emptyListLine2}
                </>
              ) : (
                t.emptyFilteredList
              )}
            </div>
          )}
        </div>

        <button
          data-memo-add
          onClick={handleAdd}
          className="flex items-center gap-1.5 border-t border-edge px-3 py-2.5 text-[13px] text-fg-muted hover:bg-raised hover:text-fg"
        >
          <Plus size={14} /> {t.newMemo}
        </button>
      </div>

      {/* 우: 편집기 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg-dim">
            {active ? memoTitle(active.text, t.untitledMemo) : t.editorFallbackTitle}
          </span>
          {active && (
            <span ref={categoryWrapRef} className="relative shrink-0">
              <button
                data-memo-category-chip
                // 포커스를 뺏지 않는다 — MD 모드에서는 blur 가 편집기를 렌더 뷰로 되돌린다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCategoryMenuOpen((open) => !open)}
                title={t.categoryChipTitle}
                className={`flex max-w-[130px] items-center gap-1 rounded px-1.5 py-1 text-[11px] hover:bg-raised hover:text-fg ${
                  categoryMenuOpen ? "bg-raised text-fg" : "text-fg-dim"
                }`}
              >
                {active.category ? (
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: categoryColor(active.category) }}
                  />
                ) : (
                  <Tag size={12} className="shrink-0" />
                )}
                <span className="truncate">{active.category ?? t.categoryChipEmpty}</span>
              </button>
              {categoryMenuOpen && (
                <MemoCategoryMenu
                  categories={categories}
                  colorOf={categoryColor}
                  current={active.category}
                  onAssign={assignCategory}
                  onRename={renameCategory}
                  onClose={() => setCategoryMenuOpen(false)}
                />
              )}
            </span>
          )}
          {active && (
            <button
              data-memo-insert-image
              // 포커스를 뺏지 않는다 — 편집기의 커서 자리에 넣어야 한다.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void pickImage()}
              title={t.insertImageTitle}
              className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
            >
              <ImagePlus size={14} />
            </button>
          )}
          <button
            onClick={toggleMdMode}
            title={t.markdownModeTitle}
            className={`rounded p-1 text-[11px] font-semibold ${
              mdMode
                ? "bg-selection text-accent"
                : "text-fg-dim hover:bg-raised hover:text-fg"
            }`}
          >
            MD
          </button>
          {active && (
            <button
              onClick={handleDelete}
              title={t.deleteMemoTitle}
              className="rounded p-1 text-fg-dim hover:bg-raised hover:text-danger"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            title={t.closeTitle}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        {/* 빈 본문은 MD 모드에서도 입력칸을 보인다 — 렌더할 것이 없고, 새 메모는 바로 써야 한다.
            편집기가 사라져도 본문은 draft에 남아 디바운스 저장·flush는 그대로 돈다. */}
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-fg-dim">
            {t.noneSelected}
          </div>
        ) : !mdMode || editing || draft.text.trim() === "" ? (
          draft.ownerId === active.id ? (
            <Suspense fallback={<div className="min-h-0 flex-1" />}>
              {/* key: 메모마다 다시 마운트한다 — 편집기는 본문을 마운트 때 한 번만 읽고(같은 draft 에서 나온
                  주인과 본문이라 어긋날 수 없다), 실행 취소 기록도 메모마다 갈린다. 안 가르면 메모를 바꾼 뒤의
                  Ctrl+Z 가 앞 메모의 변경을 지금 문서에 되감는다. */}
              <MemoEditor
                key={active.id}
                ref={editorRef}
                initialText={draft.text}
                autoFocus
                placeholder={t.editorPlaceholder}
                onChange={(text) => {
                  setDraft((d) => ({ ...d, text }));
                  // 빈 메모는 editing 없이도 입력칸이 보인다(위 주석) — 첫 글자가 들어가는 순간
                  // 본문이 비지 않게 되어 렌더 뷰로 튕기지 않도록, 타이핑 자체를 편집 중으로 친다.
                  if (mdMode && !editing) setEditing(true);
                }}
                onBlur={() => mdMode && setEditing(false)}
              />
            </Suspense>
          ) : (
            // 본문의 주인이 아직 이 메모가 아니다(메모 전환·새 메모 직후의 한 렌더) — 그대로 띄우면 편집기가
            // 앞 메모의 본문을 싣고, 한 글자만 쳐도 그 본문이 이 메모에 저장된다.
            <div className="min-h-0 flex-1" />
          )
        ) : (
          <div
            onClick={startEditing}
            className="min-h-0 flex-1 cursor-text overflow-y-auto"
          >
            <MarkdownBody
              content={draft.text}
              className="memo-md"
              components={MEMO_MARKDOWN_COMPONENTS}
            />
          </div>
        )}
      </div>
    </div>
  );
}
