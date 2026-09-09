// 이미지 편집기 스타일·컴포넌트 라이브러리 — 앱 전역 파일 하나를 창마다 캐시한다(태스크 51 §3.1·§3.7).
//
// 진실은 `app_data_dir/image-library.json`(commands/library.rs) 하나인데 zustand 인스턴스는
// **창마다 따로**다(stores/imageEditor.ts 머리말과 같은 구조). 그래서 양방향이 필요하다:
// 내 창의 변경은 300ms 디바운스로 파일에 쓰고, 남의 창의 변경은 `image-library://changed` 를
// 듣고 통째로 다시 읽는다.
//
// **자기 origin 이벤트는 버린다.** 안 버리면 내가 쓴 것을 내가 다시 읽고, 그 재로드가 `lib`
// 참조를 바꿔 편집기의 `useEffect([lib])` 재동기가 또 돌고, 그 결과가 또 저장을 부른다 —
// 멈추는 조건이 없는 왕복이다.
//
// 디바운스가 300ms 인 이유: 스타일 이름을 한 글자씩 고칠 때마다 최대 8MB 파일을 통째로 쓴다.
//
// 병합은 하지 않는다 — 두 창이 300ms 안에 저장하면 **나중 저장이 이긴다**(51 §3.1). 마우스가
// 하나라 실사용 발생 조건이 없다. `ponytail: 41의 stamp+Conflict 재사용이 필요해지면 그때`.

import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import { normalizeNode } from "../lib/annotate/schema";
import {
  DEFAULT_TEXT_STYLE,
  type ColorStyle,
  type ComponentDef,
  type ComponentId,
  type Effect,
  type EffectStyle,
  type Fill,
  type ImageLibrary,
  type Node,
  type StyleId,
  type TextNode,
  type TextStyleDef,
  type TextStyleProps,
} from "../lib/annotate/types";
import { errorMessage, ipc } from "../lib/ipc";
import { useUi } from "./ui";

/** Rust 가 거절하는 상한 — UI 가 저장 전에 같은 값으로 미리 거를 수 있게 내보낸다. */
export const LIBRARY_MAX_BYTES = 8 * 1024 * 1024;

/** 저장 디바운스. 이름 한 글자마다 파일을 쓰지 않게 묶는 값이자 창 간 반영 지연의 하한이다. */
const SAVE_DEBOUNCE_MS = 300;

/**
 * 스타일 슬롯. 3단계의 `annotate/styles.ts` 가 `StyleSlot` 이라는 이름으로 **같은 리터럴**을
 * 내보내기로 돼 있어(51 §4) 여기서는 이름을 만들지 않는다 — 같은 개념에 두 이름을 두면
 * 어느 쪽이 정본인지 다음 사람이 알 수 없다(00-INDEX §10.4).
 */
type Slot = "fill" | "stroke" | "text" | "effect";

/** 슬롯 → 라이브러리 슬라이스. `fill`·`stroke` 는 **같은 색 스타일 목록**을 본다(시안 ④는 목록 하나다). */
const SLICE: Record<Slot, "colorStyles" | "textStyles" | "effectStyles"> = {
  fill: "colorStyles",
  stroke: "colorStyles",
  text: "textStyles",
  effect: "effectStyles",
};

interface LibraryChanged {
  origin: string;
}

/** 이 창의 라벨. 창 밖(테스트 하네스 등)에서는 못 얻을 수 있어 빈 문자열로 떨어뜨린다 —
 *  그러면 모든 이벤트를 남의 것으로 보고 재로드한다(느릴 뿐, 틀리지는 않는다). */
const MY_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "";
  }
})();

// ── 정규화(경계) ─────────────────────────────────────────────────────────────
//
// 파일에서 읽은 것은 **옛 버전이 쓴 것이거나 손이 닿아 깨진 것**일 수 있다. 41 parseImageDoc·
// 42 loadToggles 와 같은 규칙으로 기본값 위에 얹고 타입이 다른 값은 버린다. 여기서 걸러 두지
// 않으면 `lib.colorStyles[0].paint.type` 같은 접근이 렌더 한복판에서 터진다.

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/**
 * 페인트·효과·타이포 정규화는 schema.ts 것을 **빌려 쓴다**(그 함수들이 모듈 비공개다).
 *
 * 다시 구현하면 두 벌이 갈라지고, 갈라지는 순간 라이브러리에서 적용한 값과 노드가 직접 든
 * 값이 미세하게 달라져 `styleState` 가 영원히 `stale` 을 돌려준다 — 사용자에게는 "갱신 가능"
 * 배지가 눌러도 사라지지 않는 버그로 보인다. 텍스트 리프 하나를 통과시켜 결과만 꺼낸다.
 */
function launder(patch: Rec): TextNode {
  // kind 가 'text' 라 null 이 나올 수 없다(normalizeNode 는 **모르는 kind** 에만 null).
  return normalizeNode({ kind: "text", ...patch }) as TextNode;
}

function normFill(v: unknown): Fill | null {
  // 객체가 아니면 버린다 — schema 의 normPaint 는 `{}` 를 기본 빨강으로 채워 주므로,
  // 여기서 먼저 거르지 않으면 페인트가 통째로 없는 스타일이 빨간 색 스타일로 부활한다.
  if (!isRec(v)) return null;
  const fills = launder({ fills: [v] }).fills;
  return fills.length ? fills[0] : null;
}

function normEffects(v: unknown): Effect[] {
  return launder({ effects: arr(v) }).effects;
}

function normTypo(v: unknown): TextStyleProps {
  const t = launder(isRec(v) ? v : {});
  return {
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    italic: t.italic,
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    paragraphSpacing: t.paragraphSpacing,
    indent: t.indent,
    underline: t.underline,
    strike: t.strike,
    textCase: t.textCase,
    features: t.features,
  };
}

/** id 가 없는 항목은 참조도 삭제도 불가능하다 — 이름만 남은 유령이 되므로 버린다. */
function idOf(v: unknown): string | null {
  return isRec(v) && typeof v.id === "string" && v.id ? v.id : null;
}

function normColorStyle(v: unknown): ColorStyle | null {
  const id = idOf(v);
  if (!id || !isRec(v)) return null;
  const paint = normFill(v.paint);
  if (!paint) return null;
  return { id, name: str(v.name, "색"), paint, updatedAt: num(v.updatedAt) };
}

function normTextStyleDef(v: unknown): TextStyleDef | null {
  const id = idOf(v);
  if (!id || !isRec(v)) return null;
  return {
    id,
    name: str(v.name, "텍스트"),
    style: normTypo(v.style),
    updatedAt: num(v.updatedAt),
  };
}

function normEffectStyle(v: unknown): EffectStyle | null {
  const id = idOf(v);
  if (!id || !isRec(v)) return null;
  return {
    id,
    name: str(v.name, "효과"),
    effects: normEffects(v.effects),
    updatedAt: num(v.updatedAt),
  };
}

function normComponent(v: unknown): ComponentDef | null {
  const id = idOf(v);
  if (!id || !isRec(v)) return null;
  const nodes = arr(v.nodes).map(normalizeNode);
  // 하나라도 못 읽었거나 `nodes[0]` 이 루트 프레임이 아니면 **컴포넌트째** 버린다.
  // 중간 노드가 빠진 서브트리는 부모 없는 자식을 남겨 배치하는 순간 트리 불변식(38)을 깨고,
  // 프레임이 없으면 재물질화가 기준 rect 를 잃어 인스턴스가 원점으로 무너진다(51 §3.4).
  if (!nodes.length || nodes.some((n) => n === null) || nodes[0]?.kind !== "frame") {
    return null;
  }
  // 참조 정합까지 봐야 위 문장이 실제로 지켜진다. `normalizeNode` 는 **모르는 kind** 에만
  // null 을 낼 뿐 id·parentId 는 문자열이기만 하면 통과시키므로(schema `normBase`), 여기서
  // 걸러 두지 않으면 매달린 `parentId` 가 그대로 산다. 그 컴포넌트를 배치하면
  // `applyOverrides` 가 없는 부모를 `inst/<없는 id>` 로 접두만 붙여 문서에 심고 —
  // DEV 는 배치 커밋의 `assertTreeInvariant` 에서 '부모가 앞에 없다'로 즉사하고, 릴리스는
  // `subtreeRange` 가 그 노드에서 끊긴 슬라이스를 `resolveInstances` 가 splice 하며 id 를
  // 중복시킨다. 문서 쪽 `normalizeDoc` 이 이미 같은 방어를 하는데(고아 승격) 여기만 없었다.
  //
  // 고아를 루트로 올리지 않고 **버리는** 이유는 위 정책과 같다: 중간 노드가 빠진 서브트리는
  // 마스터의 모양 자체가 이미 다른 것이라, 반쯤 살려 두면 인스턴스가 조용히 틀리게 그려진다.
  const seen = new Set<string>();
  for (const n of nodes as Node[]) {
    if (!n.id || seen.has(n.id)) return null;
    if (n.parentId !== null && !seen.has(n.parentId)) return null;
    seen.add(n.id);
  }
  return {
    id,
    name: str(v.name, "컴포넌트"),
    nodes: nodes as Node[],
    w: Math.max(0, num(v.w)),
    h: Math.max(0, num(v.h)),
    thumb: str(v.thumb),
    updatedAt: num(v.updatedAt),
  };
}

function normList<T>(v: unknown, one: (x: unknown) => T | null): T[] {
  return arr(v)
    .map(one)
    .filter((x): x is T => x !== null);
}

/**
 * 파일 1벌 정규화.
 *
 * **모르는 키를 보존한다**: 태스크 52가 내보내기 프리셋을 같은 파일에 얹는다(51 §3.1).
 * 여기서 알고 있는 키만 남기면 52를 먼저 쓴 창이 저장한 값을 이 코드가 조용히 지운다.
 */
function normalizeLibrary(raw: unknown): ImageLibrary {
  const r = isRec(raw) ? raw : {};
  return {
    ...r,
    v: 1,
    colorStyles: normList(r.colorStyles, normColorStyle),
    textStyles: normList(r.textStyles, normTextStyleDef),
    effectStyles: normList(r.effectStyles, normEffectStyle),
    components: normList(r.components, normComponent),
    seeded: r.seeded === true,
  };
}

// ── 시드 ─────────────────────────────────────────────────────────────────────

/**
 * 내장 텍스트 스타일 3종(시안 ②).
 *
 * id 를 uuid 가 아니라 **고정 문자열**로 두는 이유: 두 창이 첫 실행에 동시에 심어도 같은
 * 3개로 수렴한다(uuid면 나중 저장이 이기면서 앞 창이 이미 노드에 남긴 `styleRefs` 가 통째로
 * `missing` 이 된다). `updatedAt` 0 도 같은 이유 — 두 창의 시드가 바이트까지 같아야 한다.
 *
 * 글꼴은 시안의 Pretendard 가 아니라 앱 기본 스택(`DEFAULT_TEXT_STYLE`)이다: 번들에 없는
 * 글꼴 이름을 심으면 캔버스가 조용히 대체 글꼴로 그려, 스타일 이름과 화면이 어긋난다.
 */
const SEED_TEXT_STYLES: readonly TextStyleDef[] = [
  seedTextStyle("seed-text-h1", "제목 / H1", 28, 700, 130),
  seedTextStyle("seed-text-body", "본문 / Body", 14, 400, 150),
  seedTextStyle("seed-text-caption", "캡션 / Caption", 11, 500, 140),
];

function seedTextStyle(
  id: StyleId,
  name: string,
  fontSize: number,
  fontWeight: number,
  lineHeight: number,
): TextStyleDef {
  return {
    id,
    name,
    style: { ...normTypo(DEFAULT_TEXT_STYLE), fontSize, fontWeight, lineHeight },
    updatedAt: 0,
  };
}

// ── 저장(디바운스·단일 비행) ─────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
/** 아직 파일에 반영되지 않은 변경이 있는가. flush 가 "쓸 게 없으면 안 쓴다"를 판정한다. */
let dirty = false;

/** 모든 변경 함수의 마지막 줄. */
function schedule() {
  dirty = true;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * 단일 비행 저장 — 쓰는 중에 또 바뀌면 플래그만 세우고 끝난 뒤 한 번 더 쓴다.
 * 겹쳐 보내면 Rust `SAVE_LOCK` 에서 줄을 서서 마지막 응답까지 사용자가 기다린다.
 *
 * 돌려주는 프로미스는 **뒤따르는 재저장까지** 포함해 끝난다(flush 가 이걸 기다린다).
 */
function save(): Promise<void> {
  if (inFlight) return inFlight;
  if (!dirty) return Promise.resolve();
  const p = (async () => {
    let ok = false;
    try {
      dirty = false;
      await ipc.imageLibrarySet(JSON.stringify(useImageLibrary.getState().lib));
      ok = true;
    } catch (e) {
      // 조용히 삼키면 사용자는 스타일이 저장된 줄 안다. 파일 자체는 안전하다 —
      // 8MB 초과·JSON 파손은 쓰기 전에 거절되고 쓰기는 원자 rename 이라 마지막 성공본이 남는다.
      dirty = true; // 다음 변경이나 flush 가 다시 시도한다
      useUi
        .getState()
        .pushToast("error", `이미지 라이브러리 저장 실패 — ${errorMessage(e)}`);
    } finally {
      inFlight = null;
    }
    // 쓰는 **동안** 들어온 변경만 이어서 한 번 더 쓴다. 실패로 되살린 dirty 로도 돌면
    // 실패가 그대로 무한 재시도 + 토스트 폭주가 된다(디스크가 꽉 찬 상황이 정확히 그렇다).
    if (ok && dirty) await save();
  })();
  inFlight = p;
  return p;
}

// ── 스토어 ───────────────────────────────────────────────────────────────────

const EMPTY_LIBRARY: ImageLibrary = {
  v: 1,
  colorStyles: [],
  textStyles: [],
  effectStyles: [],
  components: [],
  seeded: false,
};

/** id 로 갈아 끼우거나 없으면 뒤에 붙인다(목록 순서 = 만든 순서, 시안 ④). */
function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

/**
 * 슬롯이 가리키는 목록은 색·텍스트·효과 중 하나라 정적 타입이 유니온이다. 이름 변경·삭제는
 * `id`·`name` 만 보므로 공통 상위 모양으로 좁혀 한 벌로 다룬다 — 슬라이스마다 같은 3줄을
 * 세 번 쓰면 나중에 한 곳만 고치는 사고가 난다.
 */
type LibItem = { id: string; name: string; updatedAt: number };

function renameById<T extends LibItem>(items: readonly T[], id: string, name: string): T[] {
  return items.map((x) => (x.id === id ? { ...x, name, updatedAt: Date.now() } : x));
}

export interface ImageLibraryState {
  lib: ImageLibrary;
  /** 첫 로드가 끝났는가. false 동안 UI 는 빈 목록 대신 아무것도 단정하지 않아야 한다. */
  ready: boolean;
  /** 첫 사용 시 1회 — 로드·시드·이벤트 구독. 여러 번 불러도 한 번만 돈다. */
  ensure(): Promise<void>;
  /** 디바운스 대기분을 지금 쓰고 끝날 때까지 기다린다(창 닫기 경로). */
  flush(): Promise<void>;
  upsertColorStyle(s: ColorStyle): void;
  upsertTextStyle(s: TextStyleDef): void;
  upsertEffectStyle(s: EffectStyle): void;
  removeStyle(slot: Slot, id: StyleId): void;
  renameStyle(slot: Slot, id: StyleId, name: string): void;
  upsertComponent(d: ComponentDef): void;
  removeComponent(id: ComponentId): void;
  renameComponent(id: ComponentId, name: string): void;
}

/** `ensure()` 단일 비행 — 편집기·인스펙터·에셋 패널이 각자 마운트에서 부른다. */
let ensured: Promise<void> | null = null;

export const useImageLibrary = create<ImageLibraryState>((set) => ({
  lib: EMPTY_LIBRARY,
  ready: false,
  ensure: () => (ensured ??= init()),
  flush: async () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save();
  },
  upsertColorStyle: (s) => {
    set((st) => ({ lib: { ...st.lib, colorStyles: upsertById(st.lib.colorStyles, s) } }));
    schedule();
  },
  upsertTextStyle: (s) => {
    set((st) => ({ lib: { ...st.lib, textStyles: upsertById(st.lib.textStyles, s) } }));
    schedule();
  },
  upsertEffectStyle: (s) => {
    set((st) => ({ lib: { ...st.lib, effectStyles: upsertById(st.lib.effectStyles, s) } }));
    schedule();
  },
  removeStyle: (slot, id) => {
    const key = SLICE[slot];
    set((st) => ({
      lib: { ...st.lib, [key]: st.lib[key].filter((x) => x.id !== id) },
    }));
    schedule();
  },
  renameStyle: (slot, id, name) => {
    const key = SLICE[slot];
    set((st) => ({
      lib: { ...st.lib, [key]: renameById(st.lib[key] as LibItem[], id, name) },
    }));
    schedule();
  },
  upsertComponent: (d) => {
    set((st) => ({ lib: { ...st.lib, components: upsertById(st.lib.components, d) } }));
    schedule();
  },
  removeComponent: (id) => {
    // 참조하던 인스턴스는 여기서 건드리지 않는다 — 열린 문서는 편집기의 재동기(51 §3.7)가,
    // 닫힌 문서는 다음 로드가 분리한다. 스토어가 문서를 만지면 히스토리 깔때기가 둘이 된다.
    set((st) => ({ lib: { ...st.lib, components: st.lib.components.filter((c) => c.id !== id) } }));
    schedule();
  },
  renameComponent: (id, name) => {
    set((st) => ({ lib: { ...st.lib, components: renameById(st.lib.components, id, name) } }));
    schedule();
  },
}));

async function reload(): Promise<void> {
  let raw: unknown = null;
  try {
    const json = await ipc.imageLibraryGet();
    raw = json ? JSON.parse(json) : null;
  } catch {
    // 없거나 손상 — 기본값으로 시작한다. 원본 격리·로그는 Rust(state.rs)가 이미 했다.
    // 여기서 토스트를 띄우면 첫 실행마다 뜬다(파일 없음이 정상 상태다).
  }
  useImageLibrary.setState({ lib: normalizeLibrary(raw) });
}

async function init(): Promise<void> {
  await reload();

  void listen<LibraryChanged>("image-library://changed", (e) => {
    if (e.payload.origin === MY_LABEL) return; // 내가 쓴 것 — 다시 읽으면 왕복이 된다
    void reload();
  });
  // 디바운스 대기분은 창이 닫히면 사라진다. persist.ts 와 같은 자리에서 비운다.
  window.addEventListener("pagehide", () => {
    void useImageLibrary.getState().flush();
  });

  // 시드는 로드 **뒤**다 — 남의 창이 이미 심었으면 `seeded` 가 true 로 온다.
  const lib = useImageLibrary.getState().lib;
  if (!lib.seeded) {
    useImageLibrary.setState({
      lib: { ...lib, textStyles: [...SEED_TEXT_STYLES, ...lib.textStyles], seeded: true },
    });
    schedule();
  }
  useImageLibrary.setState({ ready: true });
}
