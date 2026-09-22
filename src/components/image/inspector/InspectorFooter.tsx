// 인스펙터 푸터 4버튼(시안 ①) — `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)`.
//
// **문구가 곧 계약이다.** e2e 30·34 는 `textContent + ' ' + title` 을 정규식으로 훑어 버튼을
// 찾는다: `/다른 이름으로/`(30:295)·`/^\s*저장/`(30:1741)·`/저장 \(/`. 특히 `/^\s*저장/` 은
// **모달 안에서 처음 걸리는 버튼**을 집으므로, 이 앞에 "저장"으로 시작하는 버튼을 새로
// 만들면 저장 케이스가 엉뚱한 버튼을 누른다.
//
// v1 에 있던 `취소` 는 없다 — 닫기는 타이틀바 X 와 Esc 계층이다(45 §3.3, e2e 에 `/취소/`
// 클릭 0건).
//
// 상태를 들지 않는다. 핸들러 넷은 전부 v1 것 그대로(`resetAll`·`copyToClipboard`·
// `saveAs`·`saveInPlace`)이고, 이 파일은 배치와 비활성 조건만 안다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.3

import { Copy, Loader2 } from "lucide-react";

import { useMessages } from "../../../i18n/ui-language";
import { extOf, type ImgFormat } from "../../../lib/image-codec";

export interface InspectorFooterProps {
  format: ImgFormat;
  /** 저장·복사가 도는 중 — 두 번 눌러 인코딩이 겹치는 것을 막는다. */
  busy: boolean;
  /** 이미지가 아직 안 실렸으면 저장할 것이 없다. */
  canSave: boolean;
  onReset(): void;
  onCopy(): void;
  onSaveAs(): void;
  onSave(): void;
}

export function InspectorFooter({
  format,
  busy,
  canSave,
  onReset,
  onCopy,
  onSaveAs,
  onSave,
}: InspectorFooterProps) {
  const msg = useMessages();
  return (
    <>
      <button
        onClick={onReset}
        disabled={busy}
        className="mr-auto rounded px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
      >
        {msg.imageInspector.footer.reset}
      </button>
      <button
        onClick={onCopy}
        disabled={busy || !canSave}
        title={msg.imageInspector.footer.copyTitle}
        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
      >
        <Copy size={14} /> {msg.imageInspector.footer.copy}
      </button>
      <button
        onClick={onSaveAs}
        disabled={busy || !canSave}
        className="rounded border border-edge px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
      >
        {msg.imageInspector.footer.saveAs}
      </button>
      <button
        onClick={onSave}
        disabled={busy || !canSave}
        className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {msg.imageInspector.footer.save(extOf(format))}
      </button>
    </>
  );
}
