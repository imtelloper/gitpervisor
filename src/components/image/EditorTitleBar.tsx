// 편집기 타이틀바(48px) — 브레드크럼·편집됨 표시·디자인/픽셀 미리보기 세그먼트·줌·undo/redo·닫기.
//
// 문서 쪽 값(경로·저장 상태·배율·히스토리 가부)은 **전부 prop** 이다. 이 컴포넌트가
// `useImageDocPersist` 나 히스토리를 다시 부르면 훅 인스턴스가 둘이 되어 저장 상태가 갈린다.
// 반대로 `pixelPreview` 처럼 순수 UI 상태는 스토어를 직접 구독한다 — 그래야 배율 한 번 바뀔
// 때마다 ImageEditor(1,400줄)가 같이 리렌더되지 않는다.
//
// 줌 계산은 여기 없다. `View` 는 ImageEditor 가 갖고 있고 100% 는 `1/displayScale` 이라
// (42 §3.6) 이 바가 알 수 없다 — 고른 배율을 `onZoom` 으로 넘길 뿐이다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.6

import { Redo2, Undo2, X } from "lucide-react";

import { useMessages } from "../../i18n/ui-language";
import { EDITOR_SHORTCUTS, formatShortcut, type ShortcutId } from "../../lib/annotate/shortcuts";
import { useProjects } from "../../queries";
import { useImageEditorUi } from "../../stores/imageEditor";

export interface EditorTitleBarProps {
  /** 브레드크럼 앞칸용. 임베디드 저장소 id 면 목록에 없을 수 있다 — 그때는 파일명만 나온다. */
  projectId: string | null;
  path: string;
  /** 41 `persist.state !== 'clean'`. 계산은 호출자가 한다(훅을 여기서 다시 부르지 않는다). */
  dirty: boolean;
  /** 화면에 실제로 보이는 배율(1 = 100%). */
  zoom: number;
  /** 숫자는 배율(1 = 100%) — 화면 좌표로의 환산은 부모 몫이다. */
  onZoom(target: number | "fit" | "selection"): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onClose(): void;
}

const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * 툴팁 `<라벨> (<키>)` — 표기의 출처는 단축키 표 하나다(Mac 에서 자동으로 글리프가 된다).
 *
 * 대안 키가 있는 행(`redo` = `Ctrl+Shift+Z·Ctrl+Y`)은 **첫 번째만** 쓴다. 둘 다 붙이면
 * e2e 30 이 이 버튼을 찾는 `실행 취소 (Ctrl+Z)` 형식이 깨진다.
 */
function tip(id: ShortcutId): string {
  const s = EDITOR_SHORTCUTS.find((x) => x.id === id);
  return s ? `${s.label} (${formatShortcut(s).split("·")[0]})` : "";
}

const iconBtn =
  "shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40";

export default function EditorTitleBar({
  projectId,
  path,
  dirty,
  zoom,
  onZoom,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClose,
}: EditorTitleBarProps) {
  const msg = useMessages();
  const { data: projects } = useProjects();
  const pixelPreview = useImageEditorUi((s) => s.pixelPreview);
  const setPixelPreview = useImageEditorUi((s) => s.setPixelPreview);

  const project = projects?.find((p) => p.id === projectId);
  // 경로 구분자는 창마다 다르다(Windows `\`, doc 창이 받은 값은 `/` 일 수 있다) — 둘 다 자른다.
  const basename = path.split(/[\\/]/).pop() || path;
  const pct = Math.round(zoom * 100);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3">
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]" title={path}>
        {project && (
          <>
            <span className="truncate text-fg-muted">{project.name}</span>
            <span className="shrink-0 text-fg-dim">/</span>
          </>
        )}
        <span className="truncate text-fg">{basename}</span>
      </div>

      {dirty && (
        <span
          title={msg.imageEditor.titleBar.unsavedTitle}
          className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-warn" />
          {msg.imageEditor.titleBar.edited}
        </span>
      )}

      <div className="flex-1" />

      <div className="flex shrink-0 items-center rounded bg-raised p-0.5 text-[11px]">
        {/* 활성은 **색으로만** 표현되지 않는다 — aria-pressed 가 없으면 스크린리더에서
            어느 쪽이 켜졌는지 알 방법이 아예 없다(레일·상태바 토글과 같은 계약). */}
        <button
          type="button"
          aria-pressed={pixelPreview === 0}
          onClick={() => setPixelPreview(0)}
          className={`rounded px-2 py-0.5 ${
            pixelPreview === 0 ? "bg-panel text-fg" : "text-fg-dim hover:text-fg"
          }`}
        >
          {msg.imageEditor.titleBar.design}
        </button>
        <button
          type="button"
          aria-pressed={pixelPreview > 0}
          // 이미 켜져 있으면 건드리지 않는다 — 45 가 넣는 2x 를 1x 로 조용히 떨어뜨리지 않기 위해서다.
          onClick={() => pixelPreview === 0 && setPixelPreview(1)}
          className={`rounded px-2 py-0.5 ${
            pixelPreview > 0 ? "bg-panel text-fg" : "text-fg-dim hover:text-fg"
          }`}
        >
          {msg.imageEditor.titleBar.pixelPreview}
        </button>
      </div>

      {/* 현재 배율은 프리셋과 어긋나는 값(휠 줌)이 대부분이라 **첫 옵션**으로 보여 주고,
          고른 뒤에는 다시 그 자리로 돌아온다(`value=""`). 네이티브 select 라 Esc·바깥 클릭·
          키보드 이동이 공짜다 — 편집기 안에 window 키 리스너를 새로 달 수 없는 제약과도 맞는다. */}
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v === "fit" || v === "selection") onZoom(v);
          else onZoom(Number(v));
        }}
        title={msg.imageEditor.zoom.selectTitle(pct)}
        className="shrink-0 rounded border border-edge bg-base px-1 py-0.5 text-[11px] tabular-nums text-fg-muted outline-none focus:border-accent"
      >
        <option value="">{pct}%</option>
        {ZOOM_PRESETS.map((p) => (
          <option key={p} value={p} className="text-fg">
            {p * 100}%
          </option>
        ))}
        <option value="fit" className="text-fg">
          {msg.imageEditor.zoom.fit}
        </option>
        <option value="selection" className="text-fg">
          {msg.imageEditor.zoom.fitSelection}
        </option>
      </select>

      <button type="button" title={tip("undo")} onClick={onUndo} disabled={!canUndo} className={iconBtn}>
        <Undo2 size={15} />
      </button>
      <button type="button" title={tip("redo")} onClick={onRedo} disabled={!canRedo} className={iconBtn}>
        <Redo2 size={15} />
      </button>

      {/* `내보내기` 버튼 자리 — 52 가 도착하기 전에는 렌더하지 않는다(없는 기능은 안 보인다). */}

      <button type="button" title={tip("file.close")} onClick={onClose} className={iconBtn}>
        <X size={16} />
      </button>
    </div>
  );
}
