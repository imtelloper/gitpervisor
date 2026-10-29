// 서명 패드(M3 T3) — 펜으로 그리고, 이름 붙여 저장하고, 저장한 것을 골라 놓는다. 놓기(클릭 위치·path 노드)는 PdfView 몫.
//
// 저장 위치는 localStorage `gp:pdf-signatures` 다. 이유: (1) 같은 WebView2 프로필이라 메인 창·문서 창(float-pool)이 한 목록을
// 공유하고 앱 재시작 뒤에도 남는다 — DiffViewer 초안·커밋 메시지 초안과 같은 경로다. (2) 서명은 획 점열 몇 KB 라 Rust 사이드카
// 커맨드를 새로 둘 무게가 아니다. (3) dev 앱(.dev identifier)은 WebView2 폴더가 달라 설치본 목록과 섞이지 않는다.
// 한계: WebView2 사용자 데이터를 지우면 함께 사라진다 — 서명 원본은 사용자가 다시 그릴 수 있는 값이라 받아들인다.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

import { useMessages } from "../../i18n/ui-language";
import { errorMessage } from "../../lib/ipc";
import type { SignatureStrokes } from "../../lib/pdf/markup";
import { useOccludesWebview } from "../../stores/occlusion";
import { useUi } from "../../stores/ui";

export interface SavedSignature extends SignatureStrokes {
  id: string;
  name: string;
}

const STORE_KEY = "gp:pdf-signatures";
const PAD_W = 480;
const PAD_H = 180;
const INK = "#0D1B4C";

function isSaved(v: unknown): v is SavedSignature {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>; // 외부 데이터 경계(localStorage)
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.w === "number" &&
    typeof r.h === "number" &&
    Array.isArray(r.strokes) &&
    r.strokes.every((s) => Array.isArray(s) && s.every((n) => typeof n === "number"))
  );
}

export function loadSignatures(): SavedSignature[] {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 손상된 값 — 고칠 정보가 없다. 빈 목록으로 보이고, 다음 저장이 덮어써 스스로 낫는다.
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
}

/** 용량 초과(QuotaExceededError)는 던진다 — 호출부가 토스트로 알린다. */
function storeSignatures(list: SavedSignature[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

function Preview({ sig, className }: { sig: SignatureStrokes; className: string }) {
  return (
    <svg viewBox={`0 0 ${sig.w} ${sig.h}`} className={className} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {sig.strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.join(" ")}
          fill="none"
          stroke={INK}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export interface PdfSignaturePadProps {
  onPlace: (sig: SignatureStrokes) => void;
  onClose: () => void;
}

export default function PdfSignaturePad({ onPlace, onClose }: PdfSignaturePadProps) {
  const t = useMessages().pdf.markup;
  const pushToast = useUi((s) => s.pushToast);
  useOccludesWebview(true);
  const [list, setList] = useState<SavedSignature[]>(loadSignatures);
  const [strokes, setStrokes] = useState<number[][]>([]);
  const [name, setName] = useState(() => t.padDefaultName(loadSignatures().length + 1));
  const cur = useRef<number[] | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = PAD_W * dpr;
    cv.height = PAD_H * dpr;
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 3;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = INK;
    for (const s of strokes) {
      g.beginPath();
      g.moveTo(s[0], s[1]);
      for (let i = 2; i + 1 < s.length; i += 2) g.lineTo(s[i], s[i + 1]);
      if (s.length === 2) g.lineTo(s[0] + 0.01, s[1]);
      g.stroke();
    }
  }, [strokes]);

  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * PAD_W) / r.width, ((e.clientY - r.top) * PAD_H) / r.height];
  };

  const persist = (next: SavedSignature[]): boolean => {
    try {
      storeSignatures(next);
    } catch (e) {
      pushToast("error", t.padStoreFailed(errorMessage(e)));
      return false;
    }
    setList(next);
    return true;
  };

  const saveAndPlace = () => {
    if (!strokes.length) return;
    // 그린 범위로 잘라 저장한다 — 패드 여백까지 담으면 놓을 때 서명이 실제보다 작게·치우쳐 보인다.
    const all = strokes.flat();
    const xs = all.filter((_, i) => i % 2 === 0);
    const ys = all.filter((_, i) => i % 2 === 1);
    const pad = 4;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    const sig: SavedSignature = {
      id: crypto.randomUUID(),
      name: name.trim() || t.padDefaultName(list.length + 1),
      w: Math.max(...xs) + pad - x0,
      h: Math.max(...ys) + pad - y0,
      strokes: strokes.map((s) => s.map((v, i) => Math.round((v - (i % 2 === 0 ? x0 : y0)) * 10) / 10)),
    };
    if (persist([...list, sig])) onPlace(sig);
  };

  // 열자마자 Esc 가 먹게 — 포커스가 도구 버튼(뷰어 루트)에 남으면 키가 패드의 onKeyDown 에 오지 않는다.
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => backdrop.current?.focus({ preventScroll: true }), []);

  return createPortal(
    <div
      ref={backdrop}
      tabIndex={-1}
      data-pdf-signature-pad
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 outline-none"
      onClick={onClose}
      // 뷰어 루트의 주석 키(Delete·Esc·도구 키)로 새지 않게 — 포털이라 DOM 은 밖이지만 React 이벤트는 트리를 따라 버블한다.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="w-[520px] rounded-lg border border-edge bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold">{t.padTitle}</div>
        <div className="relative mt-3 rounded border border-edge bg-white">
          <canvas
            ref={canvas}
            data-pdf-signature-canvas
            style={{ width: PAD_W, height: PAD_H, touchAction: "none" }}
            className="block cursor-crosshair"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              cur.current = at(e);
              setStrokes((s) => [...s, cur.current!]);
            }}
            onPointerMove={(e) => {
              if (!cur.current) return;
              const [x, y] = at(e);
              const c = cur.current;
              if (Math.hypot(x - c[c.length - 2], y - c[c.length - 1]) < 1.5) return;
              c.push(x, y);
              setStrokes((s) => [...s.slice(0, -1), [...c]]);
            }}
            onPointerUp={() => (cur.current = null)}
            onPointerCancel={() => (cur.current = null)}
          />
          {!strokes.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
              {t.padHint}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <label className="text-fg-dim" htmlFor="gpv-sig-name">
            {t.padName}
          </label>
          <input
            id="gpv-sig-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded border border-edge bg-raised px-2 py-1 outline-none focus:border-accent"
          />
          <button
            onClick={() => setStrokes([])}
            disabled={!strokes.length}
            className="rounded px-2 py-1 text-fg-muted enabled:hover:bg-raised disabled:opacity-50"
          >
            {t.padClear}
          </button>
          <button
            data-pdf-signature-save
            onClick={saveAndPlace}
            disabled={!strokes.length}
            className="rounded bg-accent px-3 py-1 text-on-accent enabled:hover:bg-accent-hover disabled:opacity-50"
          >
            {t.padSave}
          </button>
        </div>
        <div className="mt-4 text-xs text-fg-dim">{t.padSaved}</div>
        {list.length === 0 ? (
          <div className="mt-1 text-xs text-fg-dim">{t.padEmpty}</div>
        ) : (
          <div className="mt-1 grid max-h-48 grid-cols-3 gap-2 overflow-auto">
            {list.map((s) => (
              <div key={s.id} className="group relative rounded border border-edge bg-white">
                <button
                  data-pdf-signature-use={s.name}
                  title={t.padUse(s.name)}
                  onClick={() => onPlace(s)}
                  className="block w-full p-1"
                >
                  <Preview sig={s} className="h-12 w-full" />
                  <div className="truncate text-[11px] text-neutral-600">{s.name}</div>
                </button>
                <button
                  title={t.padDelete(s.name)}
                  aria-label={t.padDelete(s.name)}
                  onClick={() => persist(list.filter((x) => x.id !== s.id))}
                  className="absolute right-0.5 top-0.5 hidden rounded bg-white/80 p-0.5 text-neutral-600 hover:text-danger group-hover:block"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised">
            {t.padClose}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
