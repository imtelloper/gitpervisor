import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Loader2,
  Regex,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isMac, modLabel } from "../../lib/platform";
import { useSearch } from "../../stores/search";
import { useUi } from "../../stores/ui";
import type { SearchFileHit } from "../../lib/ipc";

const hotkey = isMac ? `${modLabel}⇧F` : `${modLabel}+Shift+F`;

/** 하단 접이식 Find in Files 패널 — 열려 있을 때만 App이 렌더한다(open 게이트는 App). */
export function SearchPanel({ projectId }: { projectId: string }) {
  const height = useSearch((s) => s.height);
  const setHeight = useSearch((s) => s.setHeight);
  const query = useSearch((s) => s.query);
  const setQuery = useSearch((s) => s.setQuery);
  const opts = useSearch((s) => s.opts);
  const setOpts = useSearch((s) => s.setOpts);
  const result = useSearch((s) => s.result);
  const searching = useSearch((s) => s.searching);
  const error = useSearch((s) => s.error);
  const run = useSearch((s) => s.run);
  const setOpen = useSearch((s) => s.setOpen);
  const selectDiff = useUi((s) => s.selectDiff);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [includeStr, setIncludeStr] = useState(opts.include.join(", "));

  // 패널이 열릴 때 입력 포커스 + 전체선택(재검색 타이핑 즉시 시작)
  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const submit = () => {
    setOpts({
      include: includeStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    // setOpts는 비동기 반영이라 run은 다음 tick — 하지만 store getState가 최신을 읽으므로 즉시 OK.
    run(projectId);
  };

  return (
    <div className="flex shrink-0 flex-col border-t border-edge bg-panel">
      <ResizeHandle height={height} onResize={setHeight} />
      {/* 검색 헤더 */}
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <Search size={13} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder={`검색 (${hotkey}) — Enter로 실행`}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-dim"
        />
        <input
          value={includeStr}
          onChange={(e) => setIncludeStr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            }
          }}
          placeholder="포함 (예: *.ts, src/**)"
          className="w-40 shrink-0 rounded border border-edge bg-raised px-2 py-0.5 text-[11px] outline-none focus:border-accent"
        />
        <ToggleBtn active={opts.caseSensitive} onClick={() => setOpts({ caseSensitive: !opts.caseSensitive })} title="대소문자 구분">
          <CaseSensitive size={14} />
        </ToggleBtn>
        <ToggleBtn active={opts.wholeWord} onClick={() => setOpts({ wholeWord: !opts.wholeWord })} title="단어 단위">
          <WholeWord size={14} />
        </ToggleBtn>
        <ToggleBtn active={opts.regex} onClick={() => setOpts({ regex: !opts.regex })} title="정규식">
          <Regex size={14} />
        </ToggleBtn>
        {searching && <Loader2 size={14} className="shrink-0 animate-spin text-fg-dim" />}
        <button onClick={() => setOpen(false)} title="닫기 (Esc)" className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {/* 결과 */}
      <div style={{ height }} className="min-h-0 overflow-y-auto border-t border-edge">
        {error ? (
          <div className="px-3 py-3 text-[12px] text-danger">{error}</div>
        ) : !result ? (
          <div className="px-3 py-3 text-[12px] text-fg-dim">
            검색어를 입력하고 Enter를 누르세요.
          </div>
        ) : result.files.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-fg-dim">일치하는 결과가 없습니다.</div>
        ) : (
          <>
            <div className="px-3 py-1 text-[11px] text-fg-dim">
              {result.totalMatches}개 매치 · {result.files.length}개 파일
              {result.truncated && " · 500+개 — 조건을 좁히세요"}
            </div>
            {result.files.map((f) => (
              <FileGroup
                key={f.path}
                file={f}
                query={query}
                opts={opts}
                onOpen={(line, column) => selectDiff({ mode: "file", path: f.path, line, column }, projectId)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ToggleBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`shrink-0 rounded p-1 ${active ? "bg-accent/20 text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

function FileGroup({
  file,
  query,
  opts,
  onOpen,
}: {
  file: SearchFileHit;
  query: string;
  opts: { regex: boolean; caseSensitive: boolean };
  onOpen: (line: number, column: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] text-fg-muted hover:bg-raised/60"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="truncate font-medium text-fg">{file.path.split("/").pop()}</span>
        <span className="truncate text-[11px] text-fg-dim">{file.path}</span>
        <span className="ml-auto shrink-0 rounded bg-raised px-1 text-[10px] text-fg-dim">{file.matches.length}</span>
      </button>
      {!collapsed &&
        file.matches.map((m, i) => (
          <button
            key={i}
            onClick={() => onOpen(m.line, m.column)}
            className="flex w-full items-baseline gap-2 px-2 py-0.5 pl-6 text-left font-mono text-[12px] hover:bg-accent/10"
          >
            <span className="w-10 shrink-0 text-right text-[11px] text-fg-dim">{m.line}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">
              <Highlighted text={m.text} query={query} opts={opts} />
            </span>
          </button>
        ))}
    </div>
  );
}

/** 매치 라인에서 검색어를 하이라이트. 리터럴은 대소문자 옵션 반영, 정규식은 best-effort. */
function Highlighted({ text, query, opts }: { text: string; query: string; opts: { regex: boolean; caseSensitive: boolean } }) {
  const parts = useMemo(() => splitHighlights(text, query, opts), [text, query, opts]);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded bg-accent/40 text-fg">
            {p.s}
          </mark>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}

function splitHighlights(
  text: string,
  query: string,
  opts: { regex: boolean; caseSensitive: boolean },
): { s: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ s: text, hit: false }];
  try {
    let re: RegExp;
    if (opts.regex) {
      re = new RegExp(q, opts.caseSensitive ? "g" : "gi");
    } else {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(esc, opts.caseSensitive ? "g" : "gi");
    }
    const out: { s: string; hit: boolean }[] = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      if (m[0].length === 0) break; // 무한 루프 방지
      if (idx > last) out.push({ s: text.slice(last, idx), hit: false });
      out.push({ s: m[0], hit: true });
      last = idx + m[0].length;
    }
    if (last < text.length) out.push({ s: text.slice(last), hit: false });
    return out.length ? out : [{ s: text, hit: false }];
  } catch {
    return [{ s: text, hit: false }]; // 정규식 컴파일 실패 — 하이라이트 생략
  }
}

/** 결과 패널 높이 드래그 핸들 — LogPanel의 ResizeHandle 미러. */
function ResizeHandle({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let raf = 0;
    let pending = startH;
    const flush = () => {
      raf = 0;
      onResize(pending);
    };
    const move = (ev: PointerEvent) => {
      pending = startH + (startY - ev.clientY);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      teardownRef.current = null;
    };
    const up = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        onResize(pending);
      }
      teardown();
    };
    teardownRef.current = teardown;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div onPointerDown={onPointerDown} className="h-[3px] shrink-0 cursor-row-resize bg-edge transition-colors hover:bg-accent" />
  );
}
