// 편집기 단축키의 **단일 출처** — 표 하나에서 매칭(`matchShortcut`)과 표기(`formatShortcut`)가
// 함께 나온다. 키 리스너는 표를 읽기만 하고 자기 조건문을 갖지 않는다.
//
// 매칭이 `e.key` 가 아니라 **`e.code`** 인 것이 이 파일의 존재 이유다. 한글 IME 를 켜면 V 가
// `key='ㅍ'` 로, Mac ⌥A 는 `key='å'` 로 온다 — `key` 로 비교하면 그 두 환경에서 도구 전환이
// 통째로 죽는다(현행 `AnnotationLayer` 의 `TOOL_KEYS` 가 정확히 그 상태다). 반대로 `Escape`·
// `Enter`·`ArrowLeft` 같은 명명 키는 `code` 가 물리 자판(`Numpad*`·`NumpadEnter`)으로 갈라지므로
// `key` 로 본다. 글자·숫자·괄호류 = `code`, 명명 키 = `key` — 표의 한 칸이 어느 쪽인지는
// `resolveKeyToken` 이 토큰 모양만 보고 정한다.
//
// 수식자는 **정확 일치**다. `Ctrl+K` 행이 `Ctrl+Alt+Shift+K` 를 먹으면 안 된다 —
// `KeyboardShortcuts.tsx:122-126` 이 `altKey` 를 안 봐서 간격 정리 키가 `git push` 를 쏘는
// 실제 버그가 있고, 이 표는 그것을 반복하지 않는다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.3~3.4

import type { Mode } from "../../stores/imageEditor";
import { isMac } from "../platform";
import type { Node } from "./types";

export type ShortcutId =
  // 도구(§3.4 도구 · §3.5 레일)
  | "tool.select"
  | "tool.scale"
  | "tool.frame"
  | "tool.vpen"
  | "tool.pen"
  | "tool.highlight"
  | "tool.eraser"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.line"
  | "tool.arrow"
  | "tool.text"
  | "tool.badge"
  | "tool.mosaic"
  | "tool.eyedropper"
  | "tool.slice"
  | "mode.crop"
  | "hand"
  // 편집
  | "undo"
  | "redo"
  | "duplicate"
  | "copy"
  | "cut"
  | "copyPng"
  | "selectAll"
  | "delete"
  | "nudge"
  | "rename"
  // 모드
  | "enter"
  | "esc"
  // 구조
  | "group"
  | "ungroup"
  | "frame"
  | "mask"
  | "front"
  | "back"
  | "forward"
  | "backward"
  // 정렬·분배
  | "align.left"
  | "align.hcenter"
  | "align.right"
  | "align.top"
  | "align.vcenter"
  | "align.bottom"
  | "distribute.h"
  | "distribute.v"
  | "tidy"
  // 불리언
  | "bool.union"
  | "bool.subtract"
  | "bool.intersect"
  | "bool.exclude"
  | "flatten"
  | "outline"
  // 컴포넌트
  | "component.make"
  | "component.detach"
  // 뷰
  | "zoom.in"
  | "zoom.out"
  | "zoom.100"
  | "zoom.fit"
  | "zoom.sel"
  | "view.rulers"
  | "view.pixelGrid"
  | "view.snapPixel"
  | "view.pixelPreview"
  | "measure.hold"
  // 파일
  | "file.save"
  | "file.saveAs"
  | "file.export"
  | "file.close";

/**
 * 표 한 행.
 *
 * `win`/`mac` 은 표기 문자열이자 **매칭 명세**다(둘을 갈라 두면 툴팁과 실제 키가 조용히
 * 어긋난다). 대안 키는 `·` 로 잇는다(`Ctrl+Shift+Z·Ctrl+Y`) — 표기·매칭 모두 그대로 쓴다.
 * `owner` 는 이 행의 **액션**을 구현하는 태스크다. 아직 도착하지 않은 태스크의 행은 표에는
 * 있고 액션 맵에는 없다 — 그래야 키 스코프가 한 번에 완성되고 후속 태스크는 표를 안 건드린다.
 */
export interface Shortcut {
  id: ShortcutId;
  win: string;
  mac: string;
  label: string;
  when: "always" | "design" | "hasSelection" | "multi" | "nodeEdit" | "crop" | "textEdit";
  consume: boolean;
  owner: 37 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 50 | 51 | 52;
}

/**
 * §3.4 전 행. **배열 순서가 우선순위**다 — 같은 키에 여러 행이 걸리면 `when` 게이트를
 * 통과하는 첫 행이 이긴다.
 *
 * Mac 열은 시안 ⑧ 글리프 그대로다. Ctrl→⌘ 일괄 치환이 **아니다** — `distribute.h` 는
 * Win `Ctrl+Alt+H` / Mac `⌃⌥H` 로 Control 이 그대로 남고, `mask` 는 `⌃⌘M` 다.
 */
export const EDITOR_SHORTCUTS: readonly Shortcut[] = [
  // ── 도구 ──────────────────────────────────────────────────────────────────
  { id: "tool.select", win: "V", mac: "V", label: "선택", when: "design", consume: true, owner: 42 },
  { id: "tool.scale", win: "K", mac: "K", label: "이동", when: "design", consume: true, owner: 42 },
  { id: "tool.frame", win: "F", mac: "F", label: "프레임", when: "design", consume: true, owner: 42 },
  { id: "tool.vpen", win: "P", mac: "P", label: "펜", when: "design", consume: true, owner: 47 },
  { id: "tool.pen", win: "Shift+P", mac: "⇧P", label: "연필", when: "design", consume: true, owner: 42 },
  { id: "tool.highlight", win: "H", mac: "H", label: "형광펜", when: "design", consume: true, owner: 42 },
  { id: "tool.eraser", win: "E", mac: "E", label: "지우개", when: "design", consume: true, owner: 42 },
  { id: "tool.rect", win: "R", mac: "R", label: "사각형", when: "design", consume: true, owner: 42 },
  { id: "tool.ellipse", win: "O", mac: "O", label: "타원", when: "design", consume: true, owner: 42 },
  { id: "tool.line", win: "L", mac: "L", label: "직선", when: "design", consume: true, owner: 42 },
  { id: "tool.arrow", win: "A·Shift+L", mac: "A·⇧L", label: "화살표", when: "design", consume: true, owner: 42 },
  { id: "tool.text", win: "T", mac: "T", label: "텍스트", when: "design", consume: true, owner: 42 },
  { id: "tool.badge", win: "N", mac: "N", label: "번호 뱃지", when: "design", consume: true, owner: 42 },
  { id: "tool.mosaic", win: "M", mac: "M", label: "모자이크", when: "design", consume: true, owner: 42 },
  { id: "tool.eyedropper", win: "I", mac: "I", label: "스포이드", when: "design", consume: true, owner: 45 },
  { id: "tool.slice", win: "S", mac: "S", label: "슬라이스", when: "design", consume: true, owner: 52 },
  { id: "mode.crop", win: "C", mac: "C", label: "크롭", when: "design", consume: true, owner: 42 },
  // 홀드 도구 — keyup 에서 `restoreTool()`. 홀드 짝은 `useEditorKeys` 가 keyup capture 로 단다.
  { id: "hand", win: "Space", mac: "Space", label: "손", when: "design", consume: true, owner: 42 },

  // ── 편집 ──────────────────────────────────────────────────────────────────
  { id: "undo", win: "Ctrl+Z", mac: "⌘Z", label: "실행 취소", when: "always", consume: true, owner: 42 },
  { id: "redo", win: "Ctrl+Shift+Z·Ctrl+Y", mac: "⇧⌘Z", label: "다시 실행", when: "always", consume: true, owner: 42 },
  { id: "duplicate", win: "Ctrl+D", mac: "⌘D", label: "복제", when: "hasSelection", consume: true, owner: 42 },
  { id: "copy", win: "Ctrl+C", mac: "⌘C", label: "복사", when: "hasSelection", consume: true, owner: 42 },
  { id: "cut", win: "Ctrl+X", mac: "⌘X", label: "잘라내기", when: "hasSelection", consume: true, owner: 42 },
  { id: "copyPng", win: "Ctrl+Shift+C", mac: "⇧⌘C", label: "PNG 복사", when: "hasSelection", consume: true, owner: 42 },
  // 선택이 0일 때 눌러야 의미가 있는 키라 `always` 다(§3.4 "편집 always" — 보고 참조).
  { id: "selectAll", win: "Ctrl+A", mac: "⌘A", label: "전체 선택", when: "always", consume: true, owner: 42 },
  { id: "delete", win: "Delete·Backspace", mac: "Delete·Backspace", label: "삭제", when: "hasSelection", consume: true, owner: 42 },
  // 방향키 auto-repeat(K5) 무시는 액션 쪽 몫이다 — 표에 `repeat` 칸이 없다(§4 계약 고정).
  { id: "nudge", win: "Arrow·Shift+Arrow", mac: "Arrow·⇧Arrow", label: "미세 이동", when: "hasSelection", consume: true, owner: 42 },
  // 노드 편집(47 §3.6). 위 두 행은 `hasSelection` = **design 전용** 게이트라 `nodeEdit` 에서는
  // 어떤 행도 안 맞고, 그러면 `consume` 도 안 돼 Delete·방향키가 앱의 다른 window 리스너로 샌다.
  // 그래서 **같은 id 로 게이트만 다른 행**을 둔다: 액션은 하나이고 그 안에서 모드로 갈린다
  // (표를 훑는 곳은 전부 `find`(첫 행) 또는 `filter(consume)` 라 id 가 겹쳐도 안전하다).
  { id: "delete", win: "Delete·Backspace", mac: "Delete·Backspace", label: "노드 삭제", when: "nodeEdit", consume: true, owner: 47 },
  { id: "nudge", win: "Arrow·Shift+Arrow", mac: "Arrow·⇧Arrow", label: "노드 미세 이동", when: "nodeEdit", consume: true, owner: 47 },
  { id: "rename", win: "F2", mac: "F2", label: "이름 바꾸기", when: "hasSelection", consume: true, owner: 44 },

  // ── 모드 ──────────────────────────────────────────────────────────────────
  { id: "enter", win: "Enter", mac: "Enter", label: "적용 · 편집 진입", when: "always", consume: true, owner: 42 },
  { id: "esc", win: "Escape", mac: "Escape", label: "취소 · 종료", when: "always", consume: true, owner: 42 },

  // ── 구조 ──────────────────────────────────────────────────────────────────
  { id: "group", win: "Ctrl+G", mac: "⌘G", label: "그룹", when: "multi", consume: true, owner: 42 },
  { id: "ungroup", win: "Ctrl+Shift+G", mac: "⇧⌘G", label: "그룹 해제", when: "hasSelection", consume: true, owner: 42 },
  { id: "frame", win: "Ctrl+Alt+G", mac: "⌥⌘G", label: "프레임으로 감싸기", when: "hasSelection", consume: true, owner: 42 },
  { id: "mask", win: "Ctrl+Alt+M", mac: "⌃⌘M", label: "마스크 만들기", when: "multi", consume: true, owner: 42 },
  { id: "front", win: "Ctrl+Alt+]", mac: "⌥⌘]", label: "맨 앞으로", when: "hasSelection", consume: true, owner: 42 },
  { id: "back", win: "Ctrl+Alt+[", mac: "⌥⌘[", label: "맨 뒤로", when: "hasSelection", consume: true, owner: 42 },
  { id: "forward", win: "]·Ctrl+]", mac: "]·⌘]", label: "앞으로", when: "hasSelection", consume: true, owner: 42 },
  { id: "backward", win: "[·Ctrl+[", mac: "[·⌘[", label: "뒤로", when: "hasSelection", consume: true, owner: 42 },

  // ── 정렬·분배 ─────────────────────────────────────────────────────────────
  { id: "align.left", win: "Alt+A", mac: "⌥A", label: "왼쪽 정렬", when: "multi", consume: true, owner: 45 },
  { id: "align.hcenter", win: "Alt+H", mac: "⌥H", label: "가로 가운데 정렬", when: "multi", consume: true, owner: 45 },
  { id: "align.right", win: "Alt+D", mac: "⌥D", label: "오른쪽 정렬", when: "multi", consume: true, owner: 45 },
  { id: "align.top", win: "Alt+W", mac: "⌥W", label: "위 정렬", when: "multi", consume: true, owner: 45 },
  { id: "align.vcenter", win: "Alt+V", mac: "⌥V", label: "세로 가운데 정렬", when: "multi", consume: true, owner: 45 },
  { id: "align.bottom", win: "Alt+S", mac: "⌥S", label: "아래 정렬", when: "multi", consume: true, owner: 45 },
  // 분배는 3개 이상이어야 뜻이 있으나 `when` 에 그 값이 없다 — 게이트는 multi, 개수 판정은 45.
  { id: "distribute.h", win: "Ctrl+Alt+H", mac: "⌃⌥H", label: "가로 균등 분배", when: "multi", consume: true, owner: 45 },
  { id: "distribute.v", win: "Ctrl+Alt+V", mac: "⌃⌥V", label: "세로 균등 분배", when: "multi", consume: true, owner: 45 },
  { id: "tidy", win: "Ctrl+Alt+Shift+K", mac: "⌃⌥⌘K", label: "간격 정리", when: "multi", consume: true, owner: 45 },

  // ── 불리언 ────────────────────────────────────────────────────────────────
  { id: "bool.union", win: "Ctrl+Alt+U", mac: "⌥⌘U", label: "합집합", when: "multi", consume: true, owner: 46 },
  { id: "bool.subtract", win: "Ctrl+Alt+S", mac: "⌥⌘S", label: "빼기", when: "multi", consume: true, owner: 46 },
  { id: "bool.intersect", win: "Ctrl+Alt+I", mac: "⌥⌘I", label: "교집합", when: "multi", consume: true, owner: 46 },
  { id: "bool.exclude", win: "Ctrl+Alt+X", mac: "⌥⌘X", label: "배타", when: "multi", consume: true, owner: 46 },
  { id: "flatten", win: "Ctrl+E", mac: "⌘E", label: "평탄화", when: "hasSelection", consume: true, owner: 46 },
  // 액션 하나가 선택 kind 로 갈린다(path→46 outlineStroke · text→50 outlineText).
  { id: "outline", win: "Ctrl+Shift+O", mac: "⇧⌘O", label: "윤곽선화", when: "hasSelection", consume: true, owner: 46 },

  // ── 컴포넌트 ──────────────────────────────────────────────────────────────
  { id: "component.make", win: "Ctrl+Alt+K", mac: "⌥⌘K", label: "컴포넌트 만들기", when: "hasSelection", consume: true, owner: 51 },
  { id: "component.detach", win: "Ctrl+Alt+B", mac: "⌥⌘B", label: "인스턴스 분리", when: "hasSelection", consume: true, owner: 51 },

  // ── 뷰 ────────────────────────────────────────────────────────────────────
  { id: "zoom.in", win: "Ctrl+=·NumpadAdd", mac: "⌘=", label: "확대", when: "always", consume: true, owner: 42 },
  { id: "zoom.out", win: "Ctrl+-·NumpadSubtract", mac: "⌘-", label: "축소", when: "always", consume: true, owner: 42 },
  { id: "zoom.100", win: "Shift+0", mac: "⇧0", label: "100%", when: "always", consume: true, owner: 42 },
  { id: "zoom.fit", win: "Shift+1", mac: "⇧1", label: "화면 맞춤", when: "always", consume: true, owner: 42 },
  { id: "zoom.sel", win: "Shift+2", mac: "⇧2", label: "선택 맞춤", when: "always", consume: true, owner: 42 },
  { id: "view.rulers", win: "Shift+R", mac: "⇧R", label: "눈금자", when: "always", consume: true, owner: 42 },
  { id: "view.pixelGrid", win: "Ctrl+'", mac: "⌘'", label: "픽셀 그리드", when: "always", consume: true, owner: 42 },
  { id: "view.snapPixel", win: "Ctrl+Shift+'", mac: "⇧⌘'", label: "픽셀 스냅", when: "always", consume: true, owner: 42 },
  { id: "view.pixelPreview", win: "Ctrl+Alt+Y", mac: "⌥⌘Y", label: "픽셀 미리보기", when: "always", consume: true, owner: 42 },
  // 홀드. `consume` 이지만 소비는 preventDefault 까지다(버블은 막지 않는다) — §3.4 뷰 행 각주.
  { id: "measure.hold", win: "Alt", mac: "⌥", label: "측정 (왼쪽 Alt 홀드)", when: "design", consume: true, owner: 43 },

  // ── 파일 ──────────────────────────────────────────────────────────────────
  { id: "file.save", win: "Ctrl+S", mac: "⌘S", label: "저장", when: "always", consume: true, owner: 42 },
  { id: "file.saveAs", win: "Ctrl+Shift+S", mac: "⇧⌘S", label: "다른 이름으로 저장", when: "always", consume: true, owner: 42 },
  { id: "file.export", win: "Ctrl+Shift+E", mac: "⇧⌘E", label: "내보내기", when: "always", consume: true, owner: 52 },
  { id: "file.close", win: "Ctrl+W", mac: "⌘W", label: "편집기 닫기", when: "always", consume: true, owner: 42 },
];

// ── 명세 파싱 ───────────────────────────────────────────────────────────────

interface KeySpec {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** `e.code` 로 비교할 물리 키(글자·숫자·괄호류·Space·Numpad). `key` 와 배타. */
  code: string | null;
  /** `e.key` 로 비교할 명명 키(Escape·Enter·Arrow…). `code` 와 배타. */
  key: string | null;
}

type ModKey = "ctrl" | "alt" | "shift" | "meta";

const GLYPH_MOD: Record<string, ModKey> = { "⌘": "meta", "⌃": "ctrl", "⌥": "alt", "⇧": "shift" };
const WORD_MOD: Record<string, ModKey> = { Ctrl: "ctrl", Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "meta", Cmd: "meta" };

/** 자판 각인 → `e.code`. 여기 없는 토큰은 명명 키로 떨어진다. */
const PUNCT_CODE: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  "=": "Equal",
  "-": "Minus",
  ",": "Comma",
  ".": "Period",
  "'": "Quote",
};

function resolveKeyToken(token: string): Pick<KeySpec, "code" | "key"> {
  if (/^[A-Za-z]$/.test(token)) return { code: "Key" + token.toUpperCase(), key: null };
  if (/^[0-9]$/.test(token)) return { code: "Digit" + token, key: null };
  const punct = PUNCT_CODE[token];
  if (punct) return { code: punct, key: null };
  if (token === "Space" || token.startsWith("Numpad")) return { code: token, key: null };
  return { code: null, key: token };
}

// 표는 고정이라 한 번 판 명세는 다시 안 판다 — 매 keydown 마다 69행 × 문자열 분해를 도는 것을 막는다.
const specCache = new Map<string, readonly KeySpec[]>();

function parseSpec(spec: string): readonly KeySpec[] {
  const hit = specCache.get(spec);
  if (hit) return hit;
  const parsed = spec.split("·").map((alt): KeySpec => {
    const mods = { ctrl: false, alt: false, shift: false, meta: false };
    let rest = alt;
    while (rest.length > 0 && GLYPH_MOD[rest[0]]) {
      mods[GLYPH_MOD[rest[0]]] = true;
      rest = rest.slice(1);
    }
    let token = "";
    for (const part of rest.split("+")) {
      const word = WORD_MOD[part];
      if (word) mods[word] = true;
      else token = part;
    }
    // 수식자 이름만 있는 행(`measure.hold` 의 `Alt`·`⌥`) — 그 수식자 자체가 눌린 키다.
    if (token === "") token = mods.alt ? "Alt" : mods.ctrl ? "Control" : mods.shift ? "Shift" : "Meta";
    return { ...mods, ...resolveKeyToken(token) };
  });
  specCache.set(spec, parsed);
  return parsed;
}

// ── 매칭 ────────────────────────────────────────────────────────────────────

/**
 * `e.code` 를 얻되, 비어 있으면 `e.key` 에서 되살린다.
 *
 * e2e 헬퍼(`tests/e2e/suites/30-image-annotate.mjs` 의 `A.key`)는 `code` 없이 `key` 만 실은
 * 합성 이벤트를 보낸다 — 이 폴백이 없으면 기존 스위트의 글자 키가 전부 빗나간다.
 */
export function codeOf(e: KeyboardEvent | KeyboardEventInit): string {
  if (e.code) return e.code;
  const k = e.key ?? "";
  if (/^[a-z]$/i.test(k)) return "Key" + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return "Digit" + k;
  return k;
}

export interface ShortcutContext {
  mode: Mode;
  sel: number;
  /** 46 `outline`·45 컨텍스트 바가 kind 로 갈릴 때 쓴다 — 현재 표의 게이트는 개수만 본다. */
  selKinds: Set<Node["kind"]>;
  textEditing: boolean;
}

function eligible(s: Shortcut, ctx: ShortcutContext): boolean {
  // 텍스트 편집 중에는 글자가 그대로 입력돼야 한다 — textEdit 행과 Escape(계층 2)만 남긴다.
  if (ctx.textEditing && s.when !== "textEdit" && s.id !== "esc") return false;
  switch (s.when) {
    case "always":
      return true;
    case "design":
      return ctx.mode.kind === "design";
    case "hasSelection":
      return ctx.mode.kind === "design" && ctx.sel >= 1;
    case "multi":
      return ctx.mode.kind === "design" && ctx.sel >= 2;
    case "nodeEdit":
      return ctx.mode.kind === "nodeEdit";
    case "crop":
      return ctx.mode.kind === "crop";
    case "textEdit":
      return ctx.textEditing;
  }
}

function hits(k: KeySpec, e: KeyboardEvent | KeyboardEventInit, code: string, key: string): boolean {
  if (k.ctrl !== !!e.ctrlKey || k.alt !== !!e.altKey || k.shift !== !!e.shiftKey || k.meta !== !!e.metaKey) return false;
  if (k.code !== null) return code === k.code;
  // `Arrow` 는 네 방향을 한 행으로 묶은 가짜 키다 — 방향 판정은 액션이 `e.key` 로 한다.
  if (k.key === "Arrow") return key.startsWith("Arrow") || code.startsWith("Arrow");
  return key === k.key || code === k.key;
}

/**
 * 표에서 이 이벤트가 발화하는 행 하나를 고른다. 게이트를 통과하는 **첫 행**이 이긴다(표 순서 = 우선순위).
 *
 * `platform` 을 명시하면 그 열로 본다 — e2e 가 한 머신에서 두 플랫폼을 검증한다.
 */
export function matchShortcut(
  e: KeyboardEvent | KeyboardEventInit,
  ctx: ShortcutContext,
  platform: "win" | "mac" = isMac ? "mac" : "win",
): ShortcutId | null {
  // 조합 중인 한글 입력을 단축키로 먹으면 첫 자모만 삼키고 글자가 깨진다
  // (`terminal-engine.ts:286-289` 와 같은 가드).
  if (e.isComposing || e.keyCode === 229) return null;
  const code = codeOf(e);
  const key = e.key ?? "";
  for (const s of EDITOR_SHORTCUTS) {
    if (!eligible(s, ctx)) continue;
    if (parseSpec(platform === "mac" ? s.mac : s.win).some((k) => hits(k, e, code, key))) return s.id;
  }
  return null;
}

/** 툴팁·단축키 표 표기 — `'Ctrl+Alt+H'` 또는 `'⌃⌥H'`. */
export function formatShortcut(s: Shortcut): string {
  return isMac ? s.mac : s.win;
}
