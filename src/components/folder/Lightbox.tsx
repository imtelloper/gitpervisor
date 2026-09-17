import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { ipc } from "../../lib/ipc";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 즐겨찾기 폴더 이미지 라이트박스 — 원본을 `fav_read` 로 읽어 크게 보인다. 키보드(← → Esc)는
 * **쓰는 쪽이** 건다: 폴더 창은 자기 키 처리에 섞어 두었고, 타이틀바 미리보기는 드롭다운의 Esc 보다
 * 먼저 잡아야 해서 방식이 다르다.
 */
export function Lightbox({
  path,
  name,
  index,
  total,
  onClose,
  onStep,
}: {
  path: string;
  name: string;
  index: number;
  total: number;
  onClose: () => void;
  onStep: (d: number) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(null);
    void ipc
      .favRead(path)
      .then((b) => alive && setSrc(`data:${b.mime};base64,${b.base64}`))
      .catch((e) => alive && setErr(msg(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-base/95"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-fg-dim">
          {index + 1} / {total}
        </span>
        <span className="ml-auto shrink-0 text-fg-dim">← → 이동 · Esc 닫기</span>
        <button onClick={onClose} className="shrink-0 rounded p-1 hover:bg-raised hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-3"
        onClick={(e) => e.stopPropagation()}
      >
        {err ? (
          <div className="text-xs text-danger">{err}</div>
        ) : src ? (
          // 끝에서는 멈춘다(순환 없음) — 태스크 56의 뷰어 규약과 같다.
          <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="text-xs text-fg-dim">읽는 중…</div>
        )}
      </div>
      <div
        className="flex shrink-0 items-center justify-center gap-4 pb-3 text-fg-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          disabled={index === 0}
          onClick={() => onStep(-1)}
          className="rounded px-3 py-1 text-xs hover:bg-raised disabled:opacity-30"
        >
          이전
        </button>
        <button
          disabled={index === total - 1}
          onClick={() => onStep(1)}
          className="rounded px-3 py-1 text-xs hover:bg-raised disabled:opacity-30"
        >
          다음
        </button>
      </div>
    </div>
  );
}
