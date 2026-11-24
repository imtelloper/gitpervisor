// 메모 편집기의 라이브 프리뷰 — 본문(평문)의 이미지 토큰과 줄 머리 체크박스를 **그 자리에서** 위젯으로 보인다.
// 문서는 한 글자도 바꾸지 않는다: 위젯은 글자를 가리는 장식일 뿐이고, 조작(체크·크기 조절)은 그 글자를 고치는
// 트랜잭션이라 실행 취소가 된다(DOCS/memo-todo-category-image-design.md §6.3·§7.3).

import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import { currentMessages } from "../i18n/ui-language";
import {
  addMemoImage,
  memoImageIsEncoding,
  memoImagePngFallbackUrl,
  memoImageUrl,
} from "./memo-image-pipeline";
import {
  findMemoImageTokens,
  findMemoTaskMarkers,
  MEMO_IMAGE_MIN_WIDTH,
  memoImageToken,
  withMemoImageWidth,
  type MemoImageToken,
} from "./memo-tokens";

// 다른 창이 토큰을 파일보다 먼저 받는 경우(저장은 인코딩 뒤에 온다) — 못 찾으면 한 번만 다시 묻는다.
const IMAGE_RETRY_MS = 3000;

/** 위젯 DOM 이 놓인 자리 근처에서 이 id 의 토큰을 찾는다. 위젯은 자기 위치를 들고 있지 않다(편집으로 계속 밀린다). */
function tokenAtWidget(view: EditorView, dom: HTMLElement, id: string): MemoImageToken | null {
  const pos = view.posAtDOM(dom);
  let best: MemoImageToken | null = null;
  for (const t of findMemoImageTokens(view.state.doc.toString())) {
    if (t.id !== id) continue;
    if (t.from <= pos && pos <= t.to) return t;
    if (!best || Math.abs(t.from - pos) < Math.abs(best.from - pos)) best = t;
  }
  return best;
}

class MemoTaskCheckbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  // 기본 eq 는 false 다 — 안 주면 문서를 훑을 때마다 DOM 이 새로 만들어져 깜빡이고, 위젯 옆에서 한글을
  // 조합할 때 IME 가 깨질 수 있다(§6.4).
  eq(other: MemoTaskCheckbox): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-memo-task";
    // 포커스와 선택을 뺏지 않는다 — 체크 한 번에 커서가 그 줄로 튀면 치던 자리를 잃는다.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      // posAtDOM 이 가려진 세 글자의 앞을 줄지 뒤를 줄지에 기대지 않고 양쪽을 다 본다.
      const pos = view.posAtDOM(box);
      const doc = view.state.doc;
      for (const from of [pos, pos - 3]) {
        if (from < 0) continue;
        const marker = doc.sliceString(from, from + 3);
        if (!/^\[[ xX]\]$/.test(marker)) continue;
        view.dispatch({
          changes: { from, to: from + 3, insert: marker === "[ ]" ? "[x]" : "[ ]" },
          userEvent: "input",
        });
        return;
      }
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MemoImageWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly width: number | null,
    readonly selected: boolean,
  ) {
    super();
  }

  eq(other: MemoImageWidget): boolean {
    return other.id === this.id && other.width === this.width && other.selected === this.selected;
  }

  private applyTo(wrap: HTMLElement) {
    const img = wrap.querySelector("img");
    if (img) img.style.width = this.width ? `${this.width}px` : "";
    wrap.classList.toggle("cm-memo-image-selected", this.selected);
  }

  // 폭·선택만 바뀐 경우 DOM 을 재사용한다 — 새로 만들면 그림을 다시 불러와 깜빡인다.
  updateDOM(dom: HTMLElement, view: EditorView, from: this): boolean {
    if (from.id !== this.id) return false;
    this.applyTo(dom);
    view.requestMeasure();
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const t = currentMessages().notes.memoPanel;
    const { id } = this;
    const wrap = document.createElement("span");
    wrap.className = "cm-memo-image";
    wrap.dataset.memoImage = id;
    wrap.dataset.state = "loading";
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    const status = document.createElement("span");
    status.className = "cm-memo-image-status";
    status.textContent = memoImageIsEncoding(id) ? t.imageEncoding : t.imageLoading;
    const handle = document.createElement("span");
    handle.className = "cm-memo-image-handle";
    wrap.append(img, status, handle);
    this.applyTo(wrap);

    const fail = () => {
      wrap.dataset.state = "missing";
      status.textContent = t.imageMissing;
      view.requestMeasure();
    };
    const show = (url: string) => {
      img.src = url;
    };
    img.addEventListener("load", () => {
      wrap.dataset.state = "ready";
      // 줄 높이가 그림 높이로 바뀐다 — 편집기의 높이 지도를 다시 재게 한다.
      view.requestMeasure();
    });
    // 받은 바이트를 <img> 가 못 그린다 = AVIF 를 못 푸는 웹뷰(배포판 WebKitGTK). 한 번만 PNG 로 풀어 본다.
    let triedPng = false;
    img.addEventListener("error", () => {
      if (triedPng) return fail();
      triedPng = true;
      memoImagePngFallbackUrl(id).then(show, fail);
    });
    memoImageUrl(id).then(show, () => {
      setTimeout(() => memoImageUrl(id).then(show, fail), IMAGE_RETRY_MS);
    });

    // 위젯은 기본적으로 이벤트를 편집기에 넘기지 않는다(ignoreEvent) — 클릭으로 고르는 것도 직접 한다.
    img.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const token = tokenAtWidget(view, wrap, id);
      if (!token) return;
      view.focus();
      view.dispatch({ selection: { anchor: token.from, head: token.to } });
    });

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = img.getBoundingClientRect().width;
      const content = getComputedStyle(view.contentDOM);
      const lineEl = wrap.closest<HTMLElement>(".cm-line");
      const linePad = lineEl ? getComputedStyle(lineEl) : null;
      const maxWidth = Math.max(
        MEMO_IMAGE_MIN_WIDTH,
        view.contentDOM.clientWidth -
          (parseFloat(content.paddingLeft) || 0) -
          (parseFloat(content.paddingRight) || 0) -
          (linePad ? (parseFloat(linePad.paddingLeft) || 0) + (parseFloat(linePad.paddingRight) || 0) : 0),
      );
      let width = startWidth;
      // 끄는 동안은 DOM 폭만 바꾼다 — 놓을 때 본문을 한 번 고친다(= 실행 취소 한 번).
      const move = (ev: PointerEvent) => {
        width = Math.min(maxWidth, Math.max(MEMO_IMAGE_MIN_WIDTH, startWidth + ev.clientX - startX));
        img.style.width = `${Math.round(width)}px`;
        view.requestMeasure();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        const token = tokenAtWidget(view, wrap, id);
        const next = Math.round(width);
        if (!token || next === token.width) return;
        const text = view.state.doc.sliceString(token.from, token.to);
        view.dispatch({
          changes: { from: token.from, to: token.to, insert: withMemoImageWidth(text, next) },
          userEvent: "input",
        });
      };
      // 창에 건다(메모 목록 드래그와 같은 방식) — 핸들은 12px 라 포인터가 금방 벗어난다.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ponytail: 문서 전체를 훑는다 — 메모가 수백 KB 가 되면 보이는 범위만 훑는 ViewPlugin 으로 바꾼다.
function buildMemoDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const sel = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  for (const m of findMemoTaskMarkers(text)) {
    ranges.push(Decoration.replace({ widget: new MemoTaskCheckbox(m.checked) }).range(m.from, m.to));
  }
  for (const token of findMemoImageTokens(text)) {
    const selected = !sel.empty && sel.from <= token.from && sel.to >= token.to;
    ranges.push(
      Decoration.replace({ widget: new MemoImageWidget(token.id, token.width, selected) }).range(
        token.from,
        token.to,
      ),
    );
  }
  return Decoration.set(ranges, true);
}

const memoDecorations = StateField.define<DecorationSet>({
  create: buildMemoDecorations,
  // 선택이 바뀔 때도 다시 만든다 — 이미지의 "선택됨" 테두리가 선택 범위에서 나온다.
  update: (deco, tr) => (tr.docChanged || tr.selection ? buildMemoDecorations(tr.state) : deco),
  provide: (field) => [
    EditorView.decorations.from(field),
    // 가려진 글자 사이에 커서가 서지 않게 — 화살표는 위젯을 한 칸으로 건너뛰고, 지우기는 토큰을 통째로 지운다.
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

const memoPreviewTheme = EditorView.baseTheme({
  ".cm-memo-task": {
    margin: "0 0.15em 0 0",
    verticalAlign: "middle",
    cursor: "pointer",
    accentColor: "var(--color-accent)",
  },
  ".cm-memo-image": {
    position: "relative",
    display: "inline-block",
    maxWidth: "100%",
    verticalAlign: "bottom",
  },
  ".cm-memo-image img": {
    display: "none",
    maxWidth: "100%",
    height: "auto",
    borderRadius: "4px",
    cursor: "default",
  },
  '.cm-memo-image[data-state="ready"] img': { display: "block" },
  ".cm-memo-image-status": {
    display: "inline-block",
    padding: "0 8px",
    border: "1px dashed var(--color-edge)",
    borderRadius: "4px",
    fontSize: "12px",
    color: "var(--color-fg-dim)",
  },
  '.cm-memo-image[data-state="ready"] .cm-memo-image-status': { display: "none" },
  ".cm-memo-image-selected img": { outline: "2px solid var(--color-accent)", outlineOffset: "1px" },
  // 고른 그림 위에 브라우저의 선택 색이 통째로 덮이면 그림이 안 보인다 — 선택 표시는 위 테두리가 맡는다.
  ".cm-memo-image img::selection": { background: "transparent" },
  ".cm-memo-image-handle": {
    display: "none",
    position: "absolute",
    right: "-5px",
    bottom: "-5px",
    width: "12px",
    height: "12px",
    borderRadius: "3px",
    border: "2px solid var(--color-panel)",
    background: "var(--color-accent)",
    cursor: "nwse-resize",
    touchAction: "none",
  },
  '.cm-memo-image[data-state="ready"]:hover .cm-memo-image-handle': { display: "block" },
  '.cm-memo-image-selected[data-state="ready"] .cm-memo-image-handle': { display: "block" },
});

/** 이미지들을 메모 이미지로 넣고 그 토큰을 `from`~`to` 자리에 쓴다(여러 장은 줄을 나눈다). */
export function insertMemoImages(view: EditorView, images: Blob[], from: number, to = from) {
  if (images.length === 0) return;
  const insert = images.map((image) => memoImageToken(addMemoImage(image))).join("\n");
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.paste",
  });
}

export function memoLivePreview(): Extension {
  return [memoDecorations, memoPreviewTheme];
}
