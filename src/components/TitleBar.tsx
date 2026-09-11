import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CalendarDays,
  FolderOpen,
  LayoutGrid,
  Plus,
  ShieldAlert,
  StickyNote,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { openAggregateWindow } from "../lib/aggregate-window";
import { openFolderWindow } from "../lib/floating";
import { ipc, type FavoriteFolder } from "../lib/ipc";
import { isMac, modLabel } from "../lib/platform";
import { useProjects, useQuarantinedTools, useSettings, useSetSettings } from "../queries";
import { useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { GlobalMemoPopover } from "./memo/GlobalMemoPopover";
import { SysMonitor } from "./SysMonitor";
import { PromptHistoryButton } from "./workspace/TermSessionControls";

const appWindow = getCurrentWindow();
const isMacOS = /Mac/i.test(navigator.userAgent);

/** 커스텀 타이틀바 — 좌: 브랜드 / 중앙: 프로젝트명 / 우: 시스템 모니터 + 창 컨트롤. */
export function TitleBar() {
  const { data: projects } = useProjects();
  const selectedId = useUi((s) => s.selectedProjectId);
  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  // F11: 최대화 토글 (전역)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void appWindow.toggleMaximize();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-8 shrink-0 cursor-default items-center border-b border-edge bg-panel pl-3 select-none"
    >
      {/* 중앙: 선택 프로젝트명 (정중앙, 표시 전용) */}
      {selected && (
        <span className="pointer-events-none absolute left-1/2 max-w-[28%] -translate-x-1/2 truncate text-xs font-medium text-fg-muted">
          {selected.name}
        </span>
      )}

      {/* 좌: 브랜드 */}
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <img
          src="/logo.png"
          alt=""
          draggable={false}
          className="h-[18px] w-[18px] rounded-[5px]"
        />
        <span className="text-xs font-semibold tracking-wide text-fg">
          Gitpervisor
        </span>
      </div>

      {/* 가운데: 드래그 영역 */}
      <div data-tauri-drag-region className="h-full flex-1" />

      {/* 우: 모아보기 토글 + 작업 리포트 + 전체 프롬프트 히스토리 + 메모장 + 시스템 모니터 */}
      <AggregateButton />
      <FavoritesButton />
      <ReportButton />
      <PromptHistoryButton />
      <GlobalMemoButton />
      <SysMonitor />

      {/* 우: macOS 격리 도구 배지 (차단 항목 있을 때만) */}
      {isMacOS && <QuarantineBadge />}

      {/* 우끝: 창 컨트롤 */}
      <div className="ml-3 flex h-full">
        <CtlButton onClick={() => void appWindow.minimize()} title="최소화">
          <Glyph>
            <line x1="1" y1="5.5" x2="10" y2="5.5" />
          </Glyph>
        </CtlButton>
        <MaxRestoreButton />
        <CtlButton onClick={() => void appWindow.close()} title="닫기" danger>
          <Glyph>
            <path d="M1.5 1.5 L9.5 9.5 M9.5 1.5 L1.5 9.5" />
          </Glyph>
        </CtlButton>
      </div>
    </header>
  );
}

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

/**
 * 즐겨찾기 폴더 버튼 (태스크 66) — 스크린샷·다운로드 폴더를 한 번에 열어 본다.
 *
 * 이 드롭다운이 **관리 UI 자체다** — 설정 다이얼로그에 섹션을 따로 두지 않는다. 등록·삭제·이름
 * 바꾸기가 전부 여기 있고, 항목을 누르면 별도 창이 뜬다(`openFolderWindow`).
 *
 * 목록은 `Settings.favoriteFolders` 에 저장되고, **그 목록이 곧 백엔드의 허용 루트다** —
 * 여기서 지우면 그 폴더를 읽을 방법도 함께 사라진다(commands/favorites.rs `allowed`).
 */
function FavoritesButton() {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<FavoriteFolder[]>([]);
  const { data: settings } = useSettings();
  const setSettings = useSetSettings();
  const favs = settings?.favoriteFolders ?? [];

  useEffect(() => {
    if (!open) return;
    // 프리셋은 열 때마다 다시 묻는다 — 사용자가 그 사이 스크린샷 폴더를 만들었을 수 있다(값싸다).
    void ipc.favPresets().then(setPresets).catch(() => setPresets([]));
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** **직전 설정을 다시 읽어** 쓴다 — 설정 다이얼로그가 열린 채로 저장하면 그쪽 폼이 들고 있던
   *  낡은 스냅샷이 여기 추가분을 덮는다. `lspEnabledProjects` 와 같은 성질이라 완전히는 못 막지만,
   *  적어도 이 버튼이 원인이 되지는 않게 한다. */
  const write = async (next: (cur: FavoriteFolder[]) => FavoriteFolder[]) => {
    try {
      const cur = await ipc.getSettings();
      await setSettings.mutateAsync({
        ...cur,
        favoriteFolders: next(cur.favoriteFolders ?? []),
      });
    } catch (e) {
      useUi
        .getState()
        .pushToast("error", `즐겨찾기를 저장하지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const add = (f: FavoriteFolder) =>
    void write((cur) => (cur.some((x) => x.path === f.path) ? cur : [...cur, f]));
  const remove = (path: string) => void write((cur) => cur.filter((x) => x.path !== path));
  const rename = (f: FavoriteFolder) =>
    useUi.getState().askPrompt({
      title: "즐겨찾기 이름 바꾸기",
      label: f.path,
      defaultValue: f.name,
      confirmLabel: "저장",
      validate: (v) => (v.trim() ? null : "이름을 입력하세요"),
      onConfirm: (v) =>
        void write((cur) =>
          cur.map((x) => (x.path === f.path ? { ...x, name: v.trim() } : x)),
        ),
    });

  const browse = async () => {
    const { open: pick } = await import("@tauri-apps/plugin-dialog");
    const picked = await pick({ directory: true, title: "즐겨찾기에 추가할 폴더" });
    if (typeof picked !== "string") return;
    add({ path: picked, name: picked.split(/[\\/]/).filter(Boolean).pop() ?? picked });
  };

  const unadded = presets.filter((p) => !favs.some((f) => f.path === p.path));

  return (
    <div className="relative mr-2.5" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="즐겨찾기 폴더 — 스크린샷·다운로드 폴더를 새 창으로 열어 봅니다"
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
          open ? "bg-raised text-accent" : "text-fg-muted hover:bg-raised hover:text-fg"
        }`}
      >
        <FolderOpen size={11} /> 폴더
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-50 min-w-56 rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl">
          {favs.length === 0 && unadded.length === 0 && (
            <div className="px-3 py-1.5 text-[11px] text-fg-dim">
              등록된 폴더가 없습니다
            </div>
          )}

          {favs.map((f) => (
            <div key={f.path} className="group/fav flex items-center">
              <button
                onClick={() => {
                  openFolderWindow(f.path);
                  setOpen(false);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  rename(f);
                  setOpen(false);
                }}
                title={`${f.path}\n우클릭: 이름 바꾸기`}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
              >
                <FolderOpen size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
              <button
                onClick={() => remove(f.path)}
                title="즐겨찾기에서 제거"
                className="mr-1 shrink-0 rounded p-1 text-fg-dim opacity-0 hover:bg-raised hover:text-danger group-hover/fav:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}

          {unadded.length > 0 && <div className="my-1 border-t border-edge" />}
          {unadded.map((p) => (
            <button
              key={p.path}
              onClick={() => add(p)}
              title={`${p.path}\n클릭하면 즐겨찾기에 추가합니다`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-dim hover:bg-raised hover:text-fg"
            >
              <Plus size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </button>
          ))}

          <div className="my-1 border-t border-edge" />
          <button
            onClick={() => void browse()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
          >
            <Plus size={13} className="shrink-0" />
            <span>폴더 추가…</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 터미널 모아보기 토글 버튼 — 열린 터미널이 하나라도 있을 때만 표시. 클릭할 때마다 열림/닫힘. */
function AggregateButton() {
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const toggleAggregate = useUi((s) => s.toggleAggregate);
  // 별도 창으로 나가 있으면 메인 안에서는 열지 않는다(두 곳이 같은 터미널을 두고 다툰다)
  // — 대신 그 창으로 보낸다(백엔드가 싱글턴이라 이미 있으면 포커스만 준다).
  const windowOpen = useUi((s) => s.aggregateWindowOpen);
  const hasTerminals = useTerminals((s) => s.terminals.length > 0);
  if (!hasTerminals) return null;
  return (
    <button
      onClick={() => (windowOpen ? openAggregateWindow() : toggleAggregate())}
      // 우클릭 = 별도 창으로. 터미널을 그 창이 가져가고 메인은 "다른 창에서 표시 중"이 된다
      // (PTY 출력 소비자가 하나뿐이라 — lib/aggregate-window.ts § 소유권 이전).
      onContextMenu={(e) => {
        e.preventDefault();
        openAggregateWindow();
      }}
      title={
        windowOpen
          ? "모아보기가 별도 창에 있습니다 — 클릭하면 그 창으로 이동"
          : `터미널 모아보기 — 여러 터미널을 한 화면에 분할로 (${hotkeyLabel})\n우클릭: 별도 창으로 띄우기`
      }
      className={`mr-2.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
        aggregateOpen || windowOpen
          ? "bg-raised text-accent"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <LayoutGrid size={11} /> 모아보기
    </button>
  );
}

/** 작업 리포트 토글 — 잔디 + 기간 요약(태스크 60). 프로젝트가 하나도 없으면 보일 게 없어 숨긴다. */
function ReportButton() {
  const reportOpen = useUi((s) => s.reportOpen);
  const toggleReport = useUi((s) => s.toggleReport);
  const { data: projects } = useProjects();
  if (!projects?.length) return null;
  return (
    <button
      onClick={toggleReport}
      title="작업 리포트 — 잔디(활동 히트맵)와 일간·주간·월간 요약"
      className={`mr-2.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
        reportOpen
          ? "bg-raised text-accent"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <CalendarDays size={11} /> 리포트
    </button>
  );
}

/**
 * 전역 메모장 — 버튼 바로 아래에 팝오버로 연다.
 * 프로젝트 메모(사이드바 우클릭 → 메모)와 목록이 완전히 분리돼 있어 프로젝트 선택·터미널
 * 유무와 무관하다 — 그래서 모아보기 버튼과 달리 **항상 표시**한다.
 */
function GlobalMemoButton() {
  const btnRef = useRef<HTMLButtonElement>(null);
  // 타이틀바 우측 버튼이라 좌측 기준(left)이면 팝오버가 창 밖으로 잘린다 — 우측 모서리 정렬
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(
    null,
  );
  // 닫기는 팝오버가 심어 주는 close로만 한다 — setAnchor(null)로 직접 끄면 미저장 메모가
  // flush 없이 사라진다(디바운스 500ms 안의 입력 + 빈 초안 정리).
  const closeRef = useRef<(() => void) | null>(null);

  const onClick = () => {
    if (anchor) {
      closeRef.current?.();
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ right: window.innerWidth - r.right, top: r.bottom + 6 });
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        title="메모장 — 프로젝트와 무관한 전역 메모"
        className={`mr-2.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
          anchor
            ? "bg-raised text-accent"
            : "text-fg-muted hover:bg-raised hover:text-fg"
        }`}
      >
        <StickyNote size={11} /> 메모장
      </button>
      {anchor && (
        <GlobalMemoPopover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          closeRef={closeRef}
        />
      )}
    </>
  );
}

/**
 * macOS 격리 도구 배지 — brew cask CLI에 박힌 quarantine을 자동 스캔해 카운트로 노출.
 * 클릭하면 Settings를 열어 해제 섹션으로 이동시킨다(섹션은 항상 보이므로 별도 스크롤 불필요).
 */
function QuarantineBadge() {
  const { data } = useQuarantinedTools();
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const count = data?.length ?? 0;
  if (count === 0) return null;
  return (
    <button
      onClick={() => setSettingsOpen(true)}
      title={`brew cask CLI ${count}개가 macOS 격리로 차단됨 — 클릭하여 해제`}
      className="mx-2 flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/20"
    >
      <ShieldAlert size={12} />
      <span>{count}개 차단</span>
    </button>
  );
}

function MaxRestoreButton() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => void appWindow.isMaximized().then(setMaximized))
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return (
    <CtlButton
      onClick={() => void appWindow.toggleMaximize()}
      title={maximized ? "이전 크기로" : "최대화"}
    >
      {maximized ? (
        <Glyph>
          <rect x="1" y="3" width="7" height="7" rx="0.5" />
          <path d="M3.2 3 V1.5 A0.5 0.5 0 0 1 3.7 1 H9.5 A0.5 0.5 0 0 1 10 1.5 V7.3 A0.5 0.5 0 0 1 9.5 7.8 H8" />
        </Glyph>
      ) : (
        <Glyph>
          <rect x="1" y="1" width="9" height="9" rx="0.5" />
        </Glyph>
      )}
    </CtlButton>
  );
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function CtlButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-full w-[44px] items-center justify-center text-fg-muted transition-colors ${
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-raised hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
