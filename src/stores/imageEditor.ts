// 이미지 편집기의 **창별** UI 상태 — 도구·모드·선택·호버·토글·탭이 사는 한 곳.
//
// 창(JS 컨텍스트)마다 인스턴스가 따로다. doc 창은 별도 웹뷰라 메인 창과 상태를 나누지 않는
// 것이 의도다(DocWindow.tsx 머리말의 useUi 와 같은 관례) — 두 창이 서로 다른 이미지를 열고
// 각자의 선택·도구를 든다.
//
// **문서는 여기 없다.** `EditorDoc` 변경은 ImageEditor 의 `applyDoc/patchDoc` 깔때기 하나만
// 지난다 — 문서를 스토어로 올리면 히스토리·저장 경로가 둘로 갈라진다(태스크 42 §3.1 대안 D).
//
// 앱 전역 `useUi` 에 얹지 않는 이유: 호버는 초당 60회 바뀌는데, 전역 스토어에 두면 편집기와
// 무관한 셀렉터(`selectBlockingOverlay` 등)가 그 60회를 전부 따라 돈다.
//
// `Tool` 이 문서 타입(`annotate/types.ts`)이 아니라 여기 있는 이유: 도구는 문서에 저장되지
// 않는 **화면 상태**다. `mode` 는 도구와 직교한다 — 크롭 중에 도구 키를 눌러도 크롭이 조용히
// 취소되지 않는다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.1·§3.2

import { create } from "zustand";

import type { ObjId } from "../lib/annotate/types";

/**
 * 레일에서 고를 수 있는 도구 22종(시안 레일 23 중 곡률은 토글, 크롭은 모드라 빠진다).
 * 소유 태스크가 도착하기 전의 도구는 레일에 그려지지 않을 뿐, 타입에는 처음부터 다 있다.
 */
export type Tool =
  | "select"
  | "scale"
  | "frame"
  | "vpen"
  | "pen"
  | "highlight"
  | "eraser"
  | "rect"
  | "ellipse"
  | "polygon"
  | "line"
  | "arrow"
  | "text"
  | "image"
  | "badge"
  | "callout"
  | "mosaic"
  | "blur"
  | "eyedropper"
  | "measure"
  | "slice"
  | "hand";

/** 편집 모드 — 도구와 직교한다. Esc 계층·배너·상태바 요약이 이 값으로 갈린다. */
export type Mode = { kind: "design" } | { kind: "nodeEdit"; id: ObjId } | { kind: "crop" };

/** 선택 항목 — 노드 id 또는 이미지 배경 의사 id. */
type SelId = ObjId | "__base";

export interface EditorUiState {
  tool: Tool;
  /** 일시 도구(Space 손·스포이드) 진입 전 도구. 슬롯 하나 — `restoreTool()` 이 비운다. */
  prevTool: Tool | null;
  mode: Mode;
  pixelPreview: 0 | 1 | 2;
  /** 캔버스 텍스트 편집 중 — 키 스코프가 글자 키를 도구 전환으로 먹지 않게 한다. */
  textEditing: boolean;
  /**
   * 선택 목록. **순서를 보존한다** — 마지막이 정렬 기준이다(45).
   * `'__base'`(이미지 배경 의사 id)는 **단독 선택만** 가능하다: 노드 id 와 섞이면 노드가 이긴다.
   */
  selectedIds: SelId[];
  hoverId: ObjId | null;
  leftTab: "layers" | "assets" | "history";
  inspectorTab: "props" | "text" | "adjust" | "export";
  /** 정리(tidy) 간격(45 §3.5). `'auto'` 는 선택에서 추론. */
  tidyGap: number | "auto";
  /** 인스펙터 W/H 비율 잠금(45 §3.6). */
  ratioLock: boolean;
  /** 색 피커 최근 사용색(45), 상한 12. */
  recentColors: string[];
  toggles: {
    snap: boolean;
    smartGuides: boolean;
    pixelGrid: boolean;
    rulers: boolean;
    guidesVisible: boolean;
    snapObjects: boolean;
    snapGuides: boolean;
    snapPixel: boolean;
    gapBadges: boolean;
    grid: 0 | 8 | 16;
    curvature: boolean;
    cropOverlay: "none" | "thirds" | "quarters" | "golden" | "diagonal";
  };
  /** 스냅 흡착 반경(css px). */
  snapThresholdCss: number;
  /** 상태바 모드 요약 슬롯 — 47 노드 힌트·48 크롭 크기 등이 채운다. */
  hint: string | null;
  /**
   * 도구 전환. `temporary` 면 지금 도구를 `prevTool` 에 넣어 `restoreTool()` 로 돌아온다.
   *
   * `select`/`vpen` 밖으로 나가면 `nodeEdit` 을 종료한다(47 §3.2) — 안 그러면 편집 중이던
   * 패스가 화면에 남은 채 조작만 안 되는 유령 상태가 된다.
   */
  setTool(t: Tool, o?: { temporary?: boolean }): void;
  restoreTool(): void;
  setMode(m: Mode): void;
  select(ids: SelId[], o?: { append?: boolean; toggle?: boolean }): void;
  setHover(id: ObjId | null): void;
  setToggle<K extends keyof EditorUiState["toggles"]>(
    k: K,
    v: EditorUiState["toggles"][K],
  ): void;
  /**
   * 좌 패널·인스펙터 탭 전환.
   *
   * "사용자가 직접 골랐다"를 기억하는 플래그는 **두지 않는다.** 45 의 자동 전환은 선택 종류가
   * 바뀔 때만 도는 이펙트(`ImageEditor` 의 `AUTO_TAB`)라 그 의존성이 곧 계약이고, 여기에 플래그를
   * 더해도 아무도 읽지 않는 상태가 하나 늘 뿐이다 — 실제로 그렇게 한 번 늘었다가 걷어냈다.
   * 반대로 플래그를 **읽게** 만들면 한 번 탭을 고른 뒤로 자동 전환이 영구히 죽는다(ins-1f 위반).
   */
  setTab(
    ...a:
      | ["left", EditorUiState["leftTab"]]
      | ["inspector", EditorUiState["inspectorTab"]]
  ): void;
  setPixelPreview(n: 0 | 1 | 2): void;
  setTextEditing(v: boolean): void;
  setHint(s: string | null): void;
  /** 편집기 마운트·`path` 변경 시. `toggles`·`recentColors` 는 사용자 취향이라 유지한다. */
  reset(): void;
}

const TOGGLES_KEY = "gp:ie:toggles";

const DEFAULT_TOGGLES: EditorUiState["toggles"] = {
  snap: true,
  smartGuides: true,
  pixelGrid: false,
  rulers: false,
  guidesVisible: true,
  snapObjects: true,
  snapGuides: true,
  // 픽셀 스냅은 좌표를 정수로 강제한다 — 켠 채로 시작하면 확대해서 찍은 점이 조용히 밀린다.
  snapPixel: false,
  gapBadges: true,
  grid: 0,
  curvature: false,
  cropOverlay: "thirds",
};

/**
 * 영속된 토글 읽기. 접근 자체가 던지는 환경(사생활 보호 모드·저장소 차단)이 있어 try/catch 다.
 *
 * 읽은 값은 신뢰하지 않는다 — 옛 버전이 남긴 **부분 객체**가 오므로 기본값 위에 얹고, 타입이
 * 다른 값은 버린다(그대로 넣으면 `toggles.grid` 가 문자열인 채로 렌더까지 흘러간다).
 * 값 범위(`grid` 0|8|16 등)까지는 보지 않는다 — 어긋나도 그 기능 하나가 무의미해질 뿐이다.
 */
function loadToggles(): EditorUiState["toggles"] {
  try {
    const raw = localStorage.getItem(TOGGLES_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object") return { ...DEFAULT_TOGGLES };
    const out = { ...DEFAULT_TOGGLES } as Record<string, unknown>;
    for (const [k, d] of Object.entries(DEFAULT_TOGGLES)) {
      const v = (p as Record<string, unknown>)[k];
      if (typeof v === typeof d) out[k] = v;
    }
    return out as EditorUiState["toggles"];
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
}

/**
 * 선택 목록 정규화 — 중복 제거(순서 보존) + `'__base'` 단독 규칙.
 *
 * 중복이 남으면 상태바 `N개 선택`·정렬 기준이 같은 객체를 두 번 센다. `'__base'` 가 노드와
 * 섞이면 45 의 이미지 컨텍스트 바와 노드 인스펙터가 동시에 뜬다 — 노드를 남긴다.
 */
function normalizeSelection(ids: readonly SelId[]): SelId[] {
  const out: SelId[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out.length > 1 ? out.filter((id) => id !== "__base") : out;
}

/** `reset()` 과 초기 상태가 공유하는 값 — 여기 없는 것(`toggles`·`recentColors`)은 reset 이 유지한다. */
function freshState(): Pick<
  EditorUiState,
  | "tool"
  | "prevTool"
  | "mode"
  | "pixelPreview"
  | "textEditing"
  | "selectedIds"
  | "hoverId"
  | "leftTab"
  | "inspectorTab"
  | "tidyGap"
  | "ratioLock"
  | "hint"
> {
  return {
    tool: "select",
    prevTool: null,
    mode: { kind: "design" },
    pixelPreview: 0,
    textEditing: false,
    selectedIds: [],
    hoverId: null,
    leftTab: "layers",
    inspectorTab: "props",
    tidyGap: "auto",
    ratioLock: false,
    hint: null,
  };
}

export const useImageEditorUi = create<EditorUiState>((set) => ({
  ...freshState(),
  recentColors: [],
  toggles: loadToggles(),
  snapThresholdCss: 4,
  setTool: (t, o) =>
    set((s) => ({
      tool: t,
      // 같은 도구로의 일시 전환은 슬롯을 덮지 않는다 — Space 홀드는 keydown auto-repeat 로
      // 계속 들어오는데, 덮으면 `prevTool` 이 'hand' 가 돼 손을 떼도 손 도구에 갇힌다.
      prevTool: o?.temporary && s.tool !== t ? s.tool : s.prevTool,
      // 노드 편집 중에 다른 도구를 고르면 편집하던 패스가 화면에 남은 채 조작만 안 되는
      // 유령 상태가 되므로 편집을 끝낸다(47 §3.2). 단 **일시 전환은 예외**다 — Space 팬은
      // 도구를 잠깐 빌리는 것이지 편집을 끝내겠다는 뜻이 아니다. 예외가 없으면 벡터 편집
      // 중에 화면을 한 번 미는 것만으로 편집이 조용히 풀린다.
      mode:
        !o?.temporary &&
        s.mode.kind === "nodeEdit" &&
        t !== "select" &&
        t !== "vpen"
          ? { kind: "design" }
          : s.mode,
    })),
  restoreTool: () =>
    set((s) => (s.prevTool ? { tool: s.prevTool, prevTool: null } : s)),
  setMode: (m) => set({ mode: m }),
  select: (ids, o) =>
    set((s) => {
      if (o?.toggle) {
        const next = [...s.selectedIds];
        for (const id of ids) {
          const i = next.indexOf(id);
          if (i >= 0) next.splice(i, 1);
          else next.push(id);
        }
        return { selectedIds: normalizeSelection(next) };
      }
      return {
        selectedIds: normalizeSelection(o?.append ? [...s.selectedIds, ...ids] : ids),
      };
    }),
  setHover: (id) => set({ hoverId: id }),
  setToggle: (k, v) =>
    set((s) => {
      const toggles = { ...s.toggles, [k]: v };
      try {
        localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles));
      } catch {
        /* localStorage 불가 환경 무시 */
      }
      return { toggles };
    }),
  setTab: (...a) => {
    const [which, tab] = a;
    set(which === "left" ? { leftTab: tab } : { inspectorTab: tab });
  },
  setPixelPreview: (n) => set({ pixelPreview: n }),
  setTextEditing: (v) => set({ textEditing: v }),
  setHint: (s) => set({ hint: s }),
  reset: () => set(freshState()),
}));
