import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Copy,
  ExternalLink,
  FilePlus,
  FolderPlus,
  Globe,
  ImageDown,
  Link,
  Pencil,
  PencilLine,
  Play,
  Trash2,
  Type,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useQueryClient } from "@tanstack/react-query";

import { fileIcon, folderIcon } from "../../lib/file-icon";
import {
  bytesToBase64,
  encodeCanvas,
  extOf,
  FORMATS,
  type ImgFormat,
  loadImage,
} from "../../lib/image-codec";
import { openDocWindow } from "../../lib/floating";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import type { ChangeKind, DirEntry, FileChange, RepoStatus } from "../../lib/ipc";
import { isHtml, isImage, isVideo } from "../../lib/language-map";
import { usePanelCollapsed, usePanelWidth } from "../../lib/use-panel-width";
import {
  invalidateAfterMove,
  keys,
  useCreateDir,
  useCreateFile,
  useDeletePath,
  useDir,
  useExpandedDirsPrefetch,
  useProjects,
  useRenamePath,
  useSaveImage,
  useStatus,
} from "../../queries";
import { isPreviewUrl, useBrowsers } from "../../stores/browser";
import { useOccludesWebview } from "../../stores/occlusion";
import { useTerminals } from "../../stores/terminals";
import { useTreeState } from "../../stores/treeState";
import { useUi } from "../../stores/ui";
import { CollapsedPanelStrip } from "../common/CollapsedPanelStrip";
import { ResizeHandle } from "../common/ResizeHandle";

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

const INDENT = 12;

// ── git 변경 색상 (JetBrains 컨벤션: 수정=파랑, 추가=초록, 삭제=회색, untracked=빨강) ──
function colorClassOf(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "text-add";
    case "deleted":
      return "text-del";
    case "conflicted":
      return "text-danger";
    case "untracked":
      return "text-untrk";
    default:
      return "text-mod"; // modified / renamed / typechange
  }
}

interface TreeStatus {
  /** repo-상대 경로 → 변경 종류 */
  fileKind: Map<string, ChangeKind>;
  /** 하위에 변경이 있는 디렉토리(repo-상대 경로) */
  dirChanged: Set<string>;
}

/** RepoStatus → 파일/디렉토리 변경 맵. 우선순위: untracked < staged < unstaged < conflicted. */
function buildTreeStatus(status: RepoStatus | undefined): TreeStatus {
  const fileKind = new Map<string, ChangeKind>();
  const dirChanged = new Set<string>();
  if (status) {
    const apply = (changes: FileChange[]) => {
      for (const c of changes) {
        fileKind.set(c.path, c.kind);
        // 조상 디렉토리를 모두 "변경 포함"으로 표시
        let idx = c.path.lastIndexOf("/");
        while (idx > 0) {
          dirChanged.add(c.path.slice(0, idx));
          idx = c.path.lastIndexOf("/", idx - 1);
        }
      }
    };
    apply(status.untracked);
    apply(status.staged);
    apply(status.unstaged);
    apply(status.conflicted);
  }
  return { fileKind, dirChanged };
}

const TreeStatusCtx = createContext<TreeStatus | null>(null);

interface TreeMenu {
  x: number;
  y: number;
  path: string;
  name: string;
  isDir: boolean;
  /** 트리 빈 영역 우클릭(루트 대상) — 메뉴는 "새 폴더"만 표시 */
  root?: boolean;
}
const TreeMenuCtx = createContext<(m: TreeMenu) => void>(() => {});

/** 파일 행 상호작용(멀티선택·더블클릭 실행) — 깊은 트리 노드에 prop 드릴 없이 전달. */
interface TreeRowApi {
  /** 멀티선택된 파일 경로 집합 */
  sel: Set<string>;
  /** 클릭 — Ctrl/Cmd면 멀티선택 토글, 아니면 단일선택(diff) + 멀티선택 해제 */
  onClick: (path: string, e: React.MouseEvent) => void;
  /** 더블클릭 — 실행 파일이면 즉시 실행 */
  onDouble: (path: string, name: string) => void;
}
const TreeRowCtx = createContext<TreeRowApi | null>(null);

// 더블클릭으로 실행할 수 있는 파일 확장자(Windows 실행 파일 + macOS dmg). 프론트 1차 게이트.
// 플랫폼 구분은 안 한다 — 실행은 OS 기본 핸들러(open/ShellExecute)가 판단하고, 핸들러가
// 없는 플랫폼에서는 에러 토스트로 끝난다.
const EXEC_EXT = new Set(["exe", "bat", "cmd", "com", "msi", "dmg"]);
function isRunnable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && EXEC_EXT.has(name.slice(dot + 1).toLowerCase());
}

function FileRow({
  name,
  path,
  isIgnored,
  depth,
}: {
  name: string;
  path: string;
  isIgnored: boolean;
  depth: number;
}) {
  const selectedDiff = useUi((s) => s.selectedDiff);
  const ts = useContext(TreeStatusCtx);
  const openMenu = useContext(TreeMenuCtx);
  const row = useContext(TreeRowCtx);
  const { Icon, color } = fileIcon(name);
  const multi = row?.sel.has(path) ?? false;
  const selected =
    multi || (selectedDiff?.mode === "file" && selectedDiff.path === path);
  const kind = ts?.fileKind.get(path);
  const nameColor = kind ? colorClassOf(kind) : "";

  return (
    <div
      data-tree-file={path}
      data-tree-path={path}
      onClick={(e) => row?.onClick(path, e)}
      onDoubleClick={() => row?.onDouble(path, name)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // 빈 영역(컨테이너) 핸들러로 버블링 막기
        openMenu({ x: e.clientX, y: e.clientY, path, name, isDir: false });
      }}
      title={path}
      data-tree-row
      style={{ paddingLeft: depth * INDENT + 8 }}
      className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-3 ${
        selected ? "bg-selection" : "hover:bg-raised"
      } ${isIgnored ? "italic text-fg-dim" : ""}`}
    >
      <span className="w-[13px] shrink-0" />
      <Icon size={14} color={color} className="shrink-0" />
      <span className={nameColor}>{name}</span>
    </div>
  );
}

function TreeNode({
  projectId,
  entry,
  path,
  depth,
}: {
  projectId: string;
  entry: DirEntry;
  path: string;
  depth: number;
}) {
  // 펼침 상태는 프로젝트별 영속 스토어에서(전환·재시작 후 복원). 로컬 state였다면 리마운트로 소실.
  const expanded = useTreeState((s) => (s.expanded[projectId] ?? []).includes(path));
  const toggleFolder = useTreeState((s) => s.toggle);
  const ts = useContext(TreeStatusCtx);
  const openMenu = useContext(TreeMenuCtx);

  if (!entry.isDir) {
    return (
      <FileRow
        name={entry.name}
        path={path}
        isIgnored={entry.isIgnored}
        depth={depth}
      />
    );
  }

  const { Icon, color } = folderIcon(expanded);
  const dirHasChanges = !entry.isIgnored && ts?.dirChanged.has(path);
  return (
    <>
      <div
        onClick={() => toggleFolder(projectId, path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({
            x: e.clientX,
            y: e.clientY,
            path,
            name: entry.name,
            isDir: true,
          });
        }}
        title={path}
        data-tree-row
        data-tree-path={path}
        data-tree-isdir="1"
        style={{ paddingLeft: depth * INDENT + 8 }}
        className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-3 hover:bg-raised ${
          entry.isIgnored ? "italic text-fg-dim" : ""
        }`}
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-fg-dim" />
        )}
        <Icon size={14} color={color} className="shrink-0" />
        <span className={`font-medium ${dirHasChanges ? "text-mod" : ""}`}>
          {entry.name}
        </span>
      </div>
      {expanded && (
        <DirChildren projectId={projectId} path={path} depth={depth + 1} />
      )}
    </>
  );
}

function DirChildren({
  projectId,
  path,
  depth,
}: {
  projectId: string;
  path: string;
  depth: number;
}) {
  const { data, isLoading, error } = useDir(projectId, path);
  const openMenu = useContext(TreeMenuCtx);
  const pad = { paddingLeft: depth * INDENT + 24 };
  const qc = useQueryClient();

  // 하위 1단계 선읽기 — 다음 클릭을 캐시 히트(0ms 펼침)로 만든다(설계 §3.3).
  // background lane이라 클릭(interactive)을 굶기지 않고, 이미 캐시된 폴더와
  // ignored 폴더(node_modules 등)는 건너뛴다. 상한 30개 · 4개씩 순차 청크.
  // ponytail: 프리페치 in-flight 중 정확히 그 폴더를 펼치면 클릭이 background 순번에
  // 합류한다(react-query 키 합류 + ipc 디덥이 lane을 구분 안 함). 백엔드 ms급이라
  // 최악도 슬롯 8개가 좀비로 찬 드문 경우뿐 — 아프면 lane별 디덥 분리로 승급.
  useEffect(() => {
    if (!data) return;
    const dirs = data
      .filter((e) => e.isDir && !e.isIgnored)
      .slice(0, 30)
      .map((e) => joinPath(path, e.name));
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < dirs.length && !cancelled; i += 4) {
        const chunk = dirs
          .slice(i, i + 4)
          .filter((d) => !qc.getQueryState(keys.dir(projectId, d)));
        await Promise.all(
          chunk.map((d) =>
            qc.prefetchQuery({
              queryKey: keys.dir(projectId, d),
              queryFn: () => ipc.listDir(projectId, d, "background"),
              staleTime: Infinity,
            }),
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, projectId, path, qc]);

  // 펼친 폴더의 빈/로딩/오류 자리 우클릭 → 그 폴더 기준 메뉴(루트로 새지 않게 stopPropagation).
  const onPlaceholderMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (path)
      openMenu({
        x: e.clientX,
        y: e.clientY,
        path,
        name: path.split("/").pop() ?? path,
        isDir: true,
      });
    else
      openMenu({ x: e.clientX, y: e.clientY, path: "", name: "", isDir: true, root: true });
  };

  // 자리표시자에도 폴더 경로를 단다 — "비어 있음"에 드래그로 떨어뜨리면 그 (빈) 폴더가
  // 대상이 되는 것이 맞다. 안 달면 히트테스트가 컨테이너로 새서 루트로 이동해 버린다.
  if (isLoading)
    return (
      <div
        style={pad}
        onContextMenu={onPlaceholderMenu}
        data-tree-path={path}
        data-tree-isdir="1"
        className="py-0.5 text-xs text-fg-dim"
      >
        …
      </div>
    );
  if (error)
    return (
      <div
        style={pad}
        onContextMenu={onPlaceholderMenu}
        data-tree-path={path}
        data-tree-isdir="1"
        className="py-0.5 text-xs text-fg-dim"
      >
        불러오지 못함
      </div>
    );
  if (!data || data.length === 0)
    return (
      <div
        style={pad}
        onContextMenu={onPlaceholderMenu}
        data-tree-path={path}
        data-tree-isdir="1"
        className="py-0.5 text-xs text-fg-dim"
      >
        비어 있음
      </div>
    );

  return (
    <>
      {data.map((e) => (
        <TreeNode
          key={e.name}
          projectId={projectId}
          entry={e}
          path={joinPath(path, e.name)}
          depth={depth}
        />
      ))}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        danger
          ? "text-danger hover:bg-danger/15"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  );
}

/** rel 경로의 부모 디렉토리(없으면 빈 문자열=루트). */
function parentDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

// ── 드래그 이동 고스트 ──
// 커서를 따라다니는 라벨은 pointermove마다 갱신된다 — FileTreePanel state로 두면 이동 한 번에
// 트리 전체(수백 행)가 프레임마다 리렌더된다. 고스트만 자기 state를 갖고, 부모는 핸들로
// 명령만 내린다(리렌더 범위 = 이 작은 컴포넌트 하나).
interface GhostState {
  x: number;
  y: number;
  /** 끌고 있는 것 — 파일명 또는 "N개 항목" */
  label: string;
  /** 대상 폴더(레포 상대, ""=루트). null = 지금 위치엔 놓을 수 없음 */
  dest: string | null;
}
export interface DragGhostHandle {
  update(g: GhostState | null): void;
}
const DragGhost = forwardRef<DragGhostHandle>(function DragGhost(_props, ref) {
  const [g, setG] = useState<GhostState | null>(null);
  useImperativeHandle(ref, () => ({ update: setG }), []);
  if (!g) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-64 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left: g.x + 14, top: g.y + 10 }}
    >
      <div className="truncate font-medium text-fg">{g.label}</div>
      <div className={`truncate text-[11px] ${g.dest !== null ? "text-accent" : "text-fg-dim"}`}>
        {g.dest !== null ? `→ ${g.dest || "루트"}` : "여기로는 이동할 수 없습니다"}
      </div>
    </div>
  );
});

// 드롭 대상 폴더 행 하이라이트 — React state 대신 classList 직접 조작(위 고스트와 같은 이유).
// 문자열 리터럴이라 Tailwind JIT가 클래스를 생성한다.
const DROP_HL = ["ring-1", "ring-inset", "ring-accent", "bg-accent/15"];

/** 폴더/파일 이름 검증 — 빈 이름·경로 구분자·`..` 거부. 통과면 null. */
function validateName(v: string): string | null {
  const t = v.trim();
  if (!t) return "이름을 입력하세요";
  if (/[\\/]/.test(t)) return "이름에 경로 구분자를 쓸 수 없습니다";
  if (t === "." || t === ".." || t.includes("..")) return "잘못된 이름입니다";
  return null;
}

/** 선택 프로젝트의 전체 파일 트리 (지연 로딩). 파일 클릭 → 중앙 뷰어에 내용/diff. */
export function FileTreePanel({ projectId }: { projectId: string }) {
  const { width, startResize, resizeTo } = usePanelWidth("gp:filetree-width", 260, 180, 520);
  const { collapsed, toggle: toggleCollapsed } = usePanelCollapsed("gp:filetree-collapsed");
  const { data: status } = useStatus(projectId);
  const { data: projects } = useProjects();
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const askPrompt = useUi((s) => s.askPrompt);
  const selectDiff = useUi((s) => s.selectDiff);
  // 로컬 .html을 내장 브라우저 탭으로 열기 위한 스토어 액션.
  const openBrowserTab = useBrowsers((s) => s.openBrowser);
  const setBrowserTitle = useBrowsers((s) => s.setTitle);
  const createDir = useCreateDir(projectId);
  const createFile = useCreateFile(projectId);
  const deletePath = useDeletePath(projectId);
  const renamePath = useRenamePath(projectId);
  const saveImage = useSaveImage(projectId);
  const qc = useQueryClient();
  // 저장된 확장 폴더를 invoke 1개로 워밍 — 프로젝트 전환 직후에도 트리가 즉시 뜬다.
  useExpandedDirsPrefetch(projectId);

  // 이미지 쓰기 후 관련 쿼리를 한 번만 무효화한다 — 일괄 변환에서 N회 무효화(리페치 폭주) 회피.
  const invalidateImageWrites = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["dir"] });
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    void qc.invalidateQueries({ queryKey: ["diff"] });
    void qc.invalidateQueries({ queryKey: ["file-image"] });
  }, [qc]);

  const projectPath = projects?.find((p) => p.id === projectId)?.path ?? "";
  const treeStatus = useMemo(() => buildTreeStatus(status), [status]);

  const [menu, setMenu] = useState<TreeMenu | null>(null);
  // 우클릭 메뉴가 워크스페이스 영역으로 넘어가면 네이티브 webview에 가린다 — 열린 동안 숨긴다.
  useOccludesWebview(!!menu);
  // 파일 멀티선택(Ctrl/Cmd 토글, Shift 범위) — 이미지 일괄 변환에 사용. 프로젝트 전환 시 비운다.
  const [treeSel, setTreeSel] = useState<Set<string>>(new Set());
  // Shift 범위 선택의 기준(앵커) 파일 경로 + 트리 컨테이너 ref(DOM 순서로 범위 계산).
  const anchorRef = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // 핸들 더블클릭 — 현재 펼쳐진 행들의 최장 자연 폭에 맞춰 패널 폭 자동 조절(grow/shrink 모두).
  // 행은 whitespace-nowrap(잘림 없음)이라 각 행 이름 span의 자연 우측 끝을 측정한다(스크롤 위치 보정).
  const fitToContent = () => {
    const cont = treeRef.current;
    if (!cont) return;
    const rows = cont.querySelectorAll<HTMLElement>("[data-tree-row]");
    if (!rows.length) return;
    const contLeft = cont.getBoundingClientRect().left;
    const scrollLeft = cont.scrollLeft;
    let maxRight = 0;
    for (const row of rows) {
      const last = row.lastElementChild; // 이름 span(파일·폴더 공통 마지막 자식)
      if (!last) continue;
      const right = last.getBoundingClientRect().right - contLeft + scrollLeft;
      if (right > maxRight) maxRight = right;
    }
    // pr-3(12px) + 여유(12px) + 세로 스크롤바(약 12px). resizeTo가 min/max로 클램프.
    if (maxRight > 0) resizeTo(maxRight + 36);
  };
  useEffect(() => {
    setTreeSel(new Set());
    anchorRef.current = null;
  }, [projectId]);

  // 메뉴 열림 동안 바깥 클릭 / Esc 로 닫는다 (ProjectList와 동일 패턴)
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // 윈도우는 역슬래시, 그 외 슬래시 — project.path 형식을 따른다.
  const sep = projectPath.includes("\\") ? "\\" : "/";
  const toOsPath = (rel: string) => rel.split("/").join(sep);
  const absOf = (rel: string) =>
    projectPath ? `${projectPath}${sep}${toOsPath(rel)}` : toOsPath(rel);

  function copy(text: string, ok: string) {
    void writeText(text)
      .then(() => pushToast("success", ok))
      .catch(() => pushToast("error", "복사에 실패했습니다"));
    setMenu(null);
  }

  // 행 클릭 — Shift면 앵커~클릭 사이 파일을 범위 선택, Ctrl/Cmd면 토글(누적),
  // 아니면 그 파일을 **단일 선택**으로 세우고 앵커로 삼는다(파일 탐색기처럼). 함수형 setState 로 참조 안정.
  const onRowClick = useCallback(
    (path: string, e: React.MouseEvent) => {
      // Shift 범위 — 화면에 보이는 파일 행의 DOM 순서로 앵커~클릭 사이를 모두 선택.
      if (e.shiftKey && anchorRef.current) {
        const order = Array.from(
          treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-file]") ?? [],
        )
          .map((el) => el.dataset.treeFile)
          .filter((p): p is string => !!p);
        const a = order.indexOf(anchorRef.current);
        const b = order.indexOf(path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setTreeSel(new Set(order.slice(lo, hi + 1)));
          selectDiff({ mode: "file", path });
          return; // 앵커는 유지(연속 Shift 클릭으로 범위 조절 가능)
        }
      }
      if (e.ctrlKey || e.metaKey) {
        setTreeSel((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchorRef.current = path;
      } else {
        setTreeSel(new Set([path]));
        selectDiff({ mode: "file", path });
        anchorRef.current = path;
      }
    },
    [selectDiff],
  );

  // 더블클릭 — 실행 파일이면 즉시 OS로 실행한다.
  // 확인 다이얼로그는 사용자 요청으로 제거했다(2026-08-27) — 매번 묻는 것이 더 큰 마찰이었다.
  // 더블클릭 자체가 의도 표현이고, 실행 여부·결과는 성공/실패 토스트가 알린다.
  const onDouble = useCallback(
    (path: string, name: string) => {
      if (isRunnable(name)) {
        void ipc
          .runExecutable(projectId, path)
          .then(() => pushToast("success", `${name} 실행됨`))
          .catch((err) => pushToast("error", errorMessage(err)));
        return;
      }
      // 이미지는 별도 창으로 — 우클릭 "새 창으로 열기"와 **같은 함수**다(태스크 30 §3.1).
      // 그 창은 뷰어에 더해 편집기까지 띄우므로(DocWindow) 넓게 연다: 편집기 우측 패널이
      // 고정 폭이라 기본 900×760에서는 stage가 눌린다. svg도 이미지로 본다 — 뷰어가 그리고,
      // 편집기는 래스터화 경고를 헤더에 표시한다.
      // 동영상도 같은 경로다(태스크 35 §2.1) — 그 창의 DiffViewer가 VideoPlayer+ExportPanel을
      // 그대로 그려 구간·분할·내보내기까지 된다. 오디오는 제외(별도 창으로 띄울 이유가 없다).
      if (isImage(name) || isVideo(name)) {
        openDocWindow(projectId, path, { size: [1180, 860] });
      }
    },
    // pushToast는 스토어 액션이라 안정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  const rowApi = useMemo<TreeRowApi>(
    () => ({ sel: treeSel, onClick: onRowClick, onDouble }),
    [treeSel, onRowClick, onDouble],
  );

  // ── 드래그로 이동 ──
  // HTML5 DnD가 아니라 포인터 이벤트로 직접 구현한다: Tauri는 창의 dragDropEnabled(네이티브
  // 파일 드롭)가 켜져 있으면 Windows(WebView2)에서 DOM drag 이벤트를 가로채 내부 DnD가
  // 아예 발화하지 않는다. 포인터 방식은 세 플랫폼 공통이고 창 설정도 건드리지 않는다.
  //
  // 규칙: 행(파일·폴더)을 5px 이상 끌면 드래그 시작. 폴더 행 = 그 폴더로, 파일 행 = 그 파일의
  // 폴더로, 빈 영역 = 루트로 떨어뜨린다. 멀티선택된 파일을 끌면 선택 전체가 함께 간다.
  const ghostRef = useRef<DragGhostHandle>(null);
  const dragRef = useRef<{
    path: string;
    isDir: boolean;
    startX: number;
    startY: number;
    active: boolean;
    /** Escape로 취소됨 — 버튼을 놓을 때까지 리스너는 유지하되 이동·고스트는 죽인다. */
    canceled: boolean;
    paths: string[];
    overEl: HTMLElement | null;
    destDir: string | null;
    cleanup: () => void;
  } | null>(null);
  // 언마운트(프로젝트 전환 등) 중 드래그가 걸쳐 있으면 리스너·하이라이트를 거둔다.
  useEffect(() => () => dragRef.current?.cleanup(), []);

  async function moveItems(paths: string[], destDir: string) {
    let ok = 0;
    const errors: string[] = [];
    const moved: [string, string][] = [];
    for (const p of paths) {
      if (parentDir(p) === destDir) continue; // 제자리 — 멀티선택에 섞여 있으면 건너뛴다
      try {
        const to = await ipc.movePath(projectId, p, destDir);
        // 이름 바꾸기와 같은 이유로 사이드카 편집 문서도 따라간다(41 §3.1) — 실패해도 이동
        // 자체는 성공이므로 삼킨다. 폴더 이동이면 그 안의 문서는 남지만 조용히 무시된다.
        await ipc.imageDocMove(projectId, p, to).catch(() => {});
        moved.push([p, to]);
        ok++;
      } catch (e) {
        errors.push(`${p.split("/").pop()}: ${errorMessage(e)}`);
      }
    }
    if (ok) {
      // 펼침 상태·뷰어 탭·멀티선택을 새 경로로 — 이름 바꾸기와 같은 이관 규칙(하위 포함).
      for (const [from, to] of moved) {
        useTreeState.getState().renameTo(projectId, from, to);
        useUi.getState().renameViewerPaths(projectId, from, to);
      }
      setTreeSel((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          const m = moved.find(([f]) => p === f || p.startsWith(`${f}/`));
          next.add(m ? m[1] + p.slice(m[0].length) : p);
        }
        return next;
      });
      // 대상 폴더가 접혀 있으면 펼친다 — 옮긴 결과가 보이지 않으면 이동이 실패한 줄 안다.
      const ts = useTreeState.getState();
      if (destDir && !(ts.expanded[projectId] ?? []).includes(destDir))
        ts.toggle(projectId, destDir);
      invalidateAfterMove(qc);
      pushToast("success", `${ok}개 이동됨 → ${destDir ? toOsPath(destDir) : "루트"}`);
    }
    if (errors.length)
      pushToast(
        "error",
        `이동 실패 ${errors.length}개 — ${errors[0]}${errors.length > 1 ? " 외" : ""}`,
      );
  }

  function onTreePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || dragRef.current) return;
    // 드래그 "소스"는 실제 행만 — 자리표시자("비어 있음")는 대상은 되지만 끌 수는 없다.
    const rowEl = (e.target as HTMLElement).closest?.(
      "[data-tree-path][data-tree-row]",
    ) as HTMLElement | null;
    if (!rowEl || !treeRef.current?.contains(rowEl)) return;
    const path = rowEl.dataset.treePath;
    if (!path) return;
    const isDir = rowEl.dataset.treeIsdir === "1";
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      const st = dragRef.current;
      if (!st || st.canceled) return;
      if (!st.active) {
        // 임계값 전엔 평범한 클릭 후보다 — 여기서 시작해야 클릭/더블클릭이 안 죽는다.
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < 5) return;
        st.active = true;
        st.paths =
          !st.isDir && treeSel.has(st.path) && treeSel.size > 1
            ? [...treeSel]
            : [st.path];
        document.body.style.userSelect = "none"; // 드래그 중 텍스트 선택 방지
      }
      const cont = treeRef.current;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const hit =
        el && cont?.contains(el)
          ? ((el.closest("[data-tree-path]") as HTMLElement | null) ?? null)
          : null;
      let destDir: string | null = null;
      if (hit) {
        const tPath = hit.dataset.treePath ?? "";
        destDir = hit.dataset.treeIsdir === "1" ? tPath : parentDir(tPath);
      } else if (el && cont?.contains(el)) {
        destDir = ""; // 트리 빈 영역 = 루트
      }
      if (destDir !== null) {
        // 자기 자신/자손 안으로는 불가(폴더), 전부 제자리면 이동할 것이 없다.
        const invalid = st.paths.some(
          (p) => destDir === p || destDir!.startsWith(`${p}/`),
        );
        const allNoop = st.paths.every((p) => parentDir(p) === destDir);
        if (invalid || allNoop) destDir = null;
      }
      st.destDir = destDir;
      // 폴더 행을 직접 겨냥했을 때만 하이라이트 — 파일 행/빈 영역은 고스트 문구가 대상을 알린다.
      const hl =
        destDir !== null && hit?.dataset.treeIsdir === "1" && hit.dataset.treePath === destDir
          ? hit
          : null;
      if (st.overEl !== hl) {
        st.overEl?.classList.remove(...DROP_HL);
        hl?.classList.add(...DROP_HL);
        st.overEl = hl;
      }
      // 컨테이너 가장자리 자동 스크롤 — 긴 트리에서 화면 밖 폴더로도 끌어갈 수 있게.
      if (cont) {
        const r = cont.getBoundingClientRect();
        if (ev.clientY < r.top + 28) cont.scrollTop -= 10;
        else if (ev.clientY > r.bottom - 28) cont.scrollTop += 10;
      }
      ghostRef.current?.update({
        x: ev.clientX,
        y: ev.clientY,
        label:
          st.paths.length > 1
            ? `${st.paths.length}개 항목`
            : (st.paths[0] ?? st.path).split("/").pop() ?? "",
        dest: destDir === null ? null : destDir ? toOsPath(destDir) : "",
      });
    };

    const onUp = () => {
      const st = dragRef.current;
      if (!st) return;
      const { active, paths, destDir } = st;
      st.cleanup();
      if (!active) return;
      // 드래그로 끝난 pointerup 뒤에 따라오는 click이 행 선택/폴더 토글을 바꾸지 않게 한 번 삼킨다.
      const suppress = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
        window.removeEventListener("click", suppress, true);
      };
      window.addEventListener("click", suppress, true);
      setTimeout(() => window.removeEventListener("click", suppress, true), 120);
      if (destDir !== null) void moveItems(paths, destDir);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const st = dragRef.current;
      if (!st) return;
      // 임계값 전이면 평범한 클릭 후보 — 통째로 걷어도 뒤따르는 click이 자연스럽다.
      if (!st.active) {
        st.cleanup();
        return;
      }
      // 활성 드래그 취소: 시각 요소만 즉시 걷고 리스너는 유지한다 — 버튼을 놓을 때 onUp이
      // 리스너 해제와 "드래그로 끝난 click 한 번 삼키기"까지 처리한다. 여기서 cleanup()을
      // 해 버리면 Escape 후 pointerup에 딸려 오는 click이 밑에 있던 행을 선택/토글해 버린다.
      st.canceled = true;
      st.destDir = null;
      st.overEl?.classList.remove(...DROP_HL);
      st.overEl = null;
      ghostRef.current?.update(null);
    };

    // 터치/펜 드래그를 스크롤 제스처가 가로채면 pointerup 없이 pointercancel만 온다 —
    // 안 걷으면 고스트·리스너·userSelect가 남고 dragRef가 차 있어 이후 드래그가 전부 막힌다.
    // 드래그 중 포커스 상실(Alt+Tab)도 같다: 남겨 두면 복귀 후 첫 pointerup이 옛 드래그의
    // 이동을 실행해 버린다. 둘 다 click이 따라오지 않으므로 억제 없이 즉시 접는다.
    const onCancel = () => dragRef.current?.cleanup();
    // 드래그 중 우클릭 메뉴 차단 — 곧 옮겨질 경로를 가리키는 메뉴(삭제/이름 바꾸기)가 열리면
    // 액션 대상이 이동과 어긋난다. capture라 행의 onContextMenu(React 위임)보다 먼저 먹는다.
    const onCtx = (ev: MouseEvent) => {
      if (dragRef.current?.active) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("contextmenu", onCtx, true);
      dragRef.current?.overEl?.classList.remove(...DROP_HL);
      ghostRef.current?.update(null);
      document.body.style.userSelect = "";
      dragRef.current = null;
    };

    dragRef.current = {
      path,
      isDir,
      startX,
      startY,
      active: false,
      canceled: false,
      paths: [path],
      overEl: null,
      destDir: null,
      cleanup,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("contextmenu", onCtx, true);
  }

  // 새 폴더 — 대상이 폴더면 그 안에, 파일이면 같은 폴더에 만든다.
  function newFolder(m: TreeMenu) {
    const baseDir = m.isDir ? m.path : parentDir(m.path);
    setMenu(null);
    askPrompt({
      title: "새 폴더",
      label: baseDir ? `${toOsPath(baseDir)} 안에 만듭니다` : "프로젝트 루트에 만듭니다",
      placeholder: "폴더 이름",
      confirmLabel: "만들기",
      validate: validateName,
      onConfirm: (name) => createDir.mutate(joinPath(baseDir, name.trim())),
    });
  }

  // 새 파일 — 임의 확장자(.py/.html/.js/.css …). 폴더면 그 안에, 파일이면 같은 폴더에.
  // 생성 성공 시 방금 만든 파일을 뷰어로 연다(확장자로 구문강조 구동).
  function newFile(m: TreeMenu) {
    const baseDir = m.isDir ? m.path : parentDir(m.path);
    setMenu(null);
    askPrompt({
      title: "새 파일",
      label: baseDir ? `${toOsPath(baseDir)} 안에 만듭니다` : "프로젝트 루트에 만듭니다",
      placeholder: "파일 이름 (예: main.py)",
      confirmLabel: "만들기",
      validate: validateName,
      onConfirm: (name) => {
        const rel = joinPath(baseDir, name.trim());
        createFile.mutate(rel, {
          onSuccess: () => selectDiff({ mode: "file", path: rel }),
        });
      },
    });
  }

  // 삭제 — 파괴적이라 확인 다이얼로그를 거친다.
  function removeEntry(m: TreeMenu) {
    setMenu(null);
    askConfirm({
      title: `${m.isDir ? "폴더" : "파일"} 삭제`,
      message: `'${m.name}'을(를) 삭제할까요? 되돌릴 수 없습니다.`,
      detail: absOf(m.path),
      confirmLabel: "삭제",
      danger: true,
      onConfirm: () => deletePath.mutate(m.path),
    });
  }

  // 이름 바꾸기 — 같은 폴더 안에서 이름만 바꾼다. 성공 후 펼침 상태·뷰어 탭·멀티선택을 새 경로로
  // 옮긴다: 안 옮기면 방금 이름 바꾼 폴더가 접히고, 열려 있던 탭이 사라진 경로를 가리킨다.
  function renameEntry(m: TreeMenu) {
    setMenu(null);
    askPrompt({
      title: `${m.isDir ? "폴더" : "파일"} 이름 바꾸기`,
      label: toOsPath(m.path),
      placeholder: m.isDir ? "폴더 이름" : "파일 이름",
      defaultValue: m.name,
      confirmLabel: "바꾸기",
      validate: validateName,
      onConfirm: (v) => {
        const newName = v.trim();
        if (newName === m.name) return; // 이름이 그대로면 호출할 이유가 없다
        renamePath.mutate(
          { relPath: m.path, newName },
          {
            onSuccess: (newRel) => {
              useTreeState.getState().renameTo(projectId, m.path, newRel);
              useUi.getState().renameViewerPaths(projectId, m.path, newRel);
              // 멀티선택에도 옛 경로가 남는다 — 같은 규칙으로 옮겨 일괄 변환이 죽은 경로를 잡지 않게.
              setTreeSel((prev) => {
                const next = new Set<string>();
                for (const p of prev)
                  next.add(
                    p === m.path
                      ? newRel
                      : p.startsWith(`${m.path}/`)
                        ? newRel + p.slice(m.path.length)
                        : p,
                  );
                return next;
              });
            },
          },
        );
      },
    });
  }

  // 변환 바이트를 디스크에 쓴다 — 기존 파일 충돌 시 덮어쓰기 확인 후 재시도(데이터 손실 방지).
  // note: 첫 프레임만 변환되는 애니메이션(gif) 등 사용자에게 알릴 꼬리표.
  function saveConverted(
    target: string,
    base64: string,
    note = "",
    overwrite = false,
  ) {
    saveImage.mutate(
      { relPath: target, base64, overwrite },
      {
        onSuccess: () =>
          pushToast("success", `변환됨 — ${target.split("/").pop()}${note}`),
        onError: (e) => {
          if (isIpcError(e) && e.code === "ALREADY_EXISTS") {
            askConfirm({
              title: "덮어쓰기",
              message: `'${target.split("/").pop()}' 파일이 이미 있습니다. 덮어쓸까요?`,
              detail: absOf(target),
              confirmLabel: "덮어쓰기",
              danger: true,
              onConfirm: () => saveConverted(target, base64, note, true),
            });
          } else {
            pushToast("error", errorMessage(e));
          }
        },
      },
    );
  }

  // 한 이미지를 대상 포맷으로 디코드+인코딩해 {대상경로, base64, 꼬리표}를 만든다(쓰기 직전 단계).
  async function encodeImageToTarget(relPath: string, fmt: ImgFormat) {
    const { mime, base64 } = await ipc.readFileBase64(projectId, relPath);
    const image = await loadImage(`data:${mime};base64,${base64}`);
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("이미지 크기를 확인할 수 없습니다");
    }
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("캔버스 컨텍스트를 얻지 못했습니다");
    if (fmt === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(image, 0, 0);
    const bytes = await encodeCanvas(c, fmt, 90);
    const dir = relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/") + 1)
      : "";
    const baseName = relPath.split("/").pop() ?? relPath;
    const dot = baseName.lastIndexOf(".");
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    // 애니메이션 gif 는 캔버스가 첫 프레임만 래스터화하므로 사용자에게 알린다.
    const note = /\.gif$/i.test(relPath) ? " (첫 프레임)" : "";
    return {
      target: `${dir}${stem}.${extOf(fmt)}`,
      base64: bytesToBase64(bytes),
      note,
    };
  }

  // 로컬 .html을 내장 브라우저에서 연다. 백엔드가 루프백 http URL을 만들어 주면(파일의 상위
  // 폴더가 서버 루트라 상대·루트절대 서브리소스 모두 로드된다) classifyMode가 iframe으로 렌더한다.
  async function openHtmlInBrowser(m: TreeMenu) {
    setMenu(null);
    try {
      // 같은 파일의 프리뷰 탭이 이미 있으면 재사용한다(중복 탭 방지).
      const bs = useBrowsers.getState();
      const existing = bs.tabIds.find((id) => {
        const p = bs.items[id]?.preview;
        return p?.projectId === projectId && p?.relPath === m.path;
      });
      if (existing) {
        // 시작 시 재발급이 실패해 URL이 빈(죽은) 탭이면 지금 재발급해 되살린다 —
        // 안 그러면 매번 빈 탭만 활성화돼 그 파일 프리뷰가 조용히 잠긴다.
        const cur = bs.items[existing]?.url ?? "";
        if (!cur || !isPreviewUrl(cur)) {
          const url = await ipc.previewLocalUrl(projectId, m.path);
          bs.refreshPreview(existing, url, { projectId, relPath: m.path });
        }
        useTerminals.getState().setActiveTab(projectId, existing);
        return;
      }
      const url = await ipc.previewLocalUrl(projectId, m.path); // m.path = 트리 상대(슬래시) 경로
      // preview 출처를 함께 저장 — 앱 재시작 후에도 이 탭의 URL을 재발급해 되살릴 수 있다.
      const id = openBrowserTab(projectId, url, { projectId, relPath: m.path });
      setBrowserTitle(id, m.name); // 없으면 제목이 "127.0.0.1:<port>"로 뜬다
    } catch (e) {
      pushToast("error", errorMessage(e));
    }
  }

  // 단일 변환 — 같은 폴더에 형제 파일로 저장(충돌 시 덮어쓰기 확인).
  async function convert(m: TreeMenu, fmt: ImgFormat) {
    setMenu(null);
    try {
      const { target, base64, note } = await encodeImageToTarget(m.path, fmt);
      saveConverted(target, base64, note);
    } catch (e) {
      pushToast("error", errorMessage(e));
    }
  }

  // 일괄 변환 — 선택한 이미지들을 한꺼번에. 기존 파일 충돌은 모아서 한 번에 덮어쓰기 확인하고,
  // 같은 대상 이름끼리의 배치 내 충돌(예: a.png+a.jpg→a.webp)은 뒤엣것을 건너뛴다(자기덮어쓰기 방지).
  // 쓰기는 ipc.writeFileBytes 직접 호출 후 끝에 한 번만 무효화한다(리페치 폭주 회피).
  async function convertBatch(paths: string[], fmt: ImgFormat) {
    setMenu(null);
    const conflicts: { target: string; base64: string }[] = [];
    const seenTargets = new Set<string>();
    let ok = 0;
    let fail = 0;
    let dup = 0;
    for (const p of paths) {
      try {
        const { target, base64 } = await encodeImageToTarget(p, fmt);
        if (seenTargets.has(target)) {
          dup++; // 이 배치가 이미 같은 이름으로 변환함 — 자기 자신을 덮어쓰지 않게 건너뜀
          continue;
        }
        seenTargets.add(target);
        try {
          await ipc.writeFileBytes(projectId, target, base64, false);
          ok++;
        } catch (e) {
          if (isIpcError(e) && e.code === "ALREADY_EXISTS")
            conflicts.push({ target, base64 });
          else fail++;
        }
      } catch {
        fail++; // 디코드/인코드 실패(손상·미지원) — 건너뛴다
      }
    }
    if (ok) invalidateImageWrites();
    const dupNote = dup ? `, 이름 충돌 ${dup}개 건너뜀` : "";
    const tail = fail ? `, 실패 ${fail}` : "";
    if (conflicts.length) {
      pushToast(
        "info",
        `변환 ${ok}개 완료 · 기존 파일 ${conflicts.length}개 보류${dupNote}${tail}`,
      );
      askConfirm({
        title: "덮어쓰기",
        message: `이미 있는 파일 ${conflicts.length}개를 모두 덮어쓸까요?`,
        confirmLabel: "모두 덮어쓰기",
        danger: true,
        onConfirm: () => {
          void (async () => {
            let ok2 = 0;
            for (const c of conflicts) {
              try {
                await ipc.writeFileBytes(projectId, c.target, c.base64, true);
                ok2++;
              } catch {
                /* 개별 실패는 무시 */
              }
            }
            if (ok2) invalidateImageWrites();
            pushToast("success", `덮어쓰기 ${ok2}개 완료`);
          })();
        },
      });
    } else {
      pushToast(fail ? "error" : "success", `변환 ${ok}개 완료${dupNote}${tail}`);
    }
  }

  // 이미지 변환/편집 대상은 캔버스가 안정적으로 래스터화하는 파일만 — SVG(벡터·무내재크기)는 제외.
  const menuIsImage = menu
    ? !menu.isDir && isImage(menu.name) && !/\.svg$/i.test(menu.name)
    : false;
  // 브라우저로 열 수 있는 HTML 문서인지 — 파일(디렉토리·루트 아님)이면서 .html류.
  const menuIsHtml = menu ? !menu.isDir && !menu.root && isHtml(menu.name) : false;
  // 실행 파일(더블클릭 실행과 같은 게이트) — 우클릭 메뉴에도 실행 항목을 노출한다.
  const menuIsRunnable = menu
    ? !menu.isDir && !menu.root && isRunnable(menu.name)
    : false;
  // 멀티선택된 변환 가능 이미지들 — 우클릭 대상이 선택에 포함되면 일괄 변환 메뉴를 띄운다.
  const selImages = useMemo(
    () => [...treeSel].filter((p) => isImage(p) && !/\.svg$/i.test(p)),
    [treeSel],
  );
  const showBatch =
    !!menu &&
    !menu.isDir &&
    !menu.root &&
    selImages.length >= 2 &&
    treeSel.has(menu.path);

  if (collapsed)
    return <CollapsedPanelStrip title="Files" onExpand={toggleCollapsed} />;

  return (
    <div
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="font-semibold">Files</span>
        <div className="flex-1" />
        <button
          title="새 파일 (루트)"
          onClick={() =>
            newFile({ x: 0, y: 0, name: "", path: "", isDir: true })
          }
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <FilePlus size={14} />
        </button>
        <button
          title="새 폴더 (루트)"
          onClick={() =>
            newFolder({ x: 0, y: 0, name: "", path: "", isDir: true })
          }
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <FolderPlus size={14} />
        </button>
        <button
          title="패널 접기"
          onClick={toggleCollapsed}
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>
      <div
        ref={treeRef}
        onPointerDown={onTreePointerDown}
        className="min-h-0 flex-1 overflow-auto py-1 text-[13px]"
        onContextMenu={(e) => {
          // 빈 영역 우클릭 → 루트 새 폴더 메뉴 (행은 stopPropagation으로 여기 안 온다).
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            path: "",
            name: "",
            isDir: true,
            root: true,
          });
        }}
      >
        <TreeStatusCtx.Provider value={treeStatus}>
          <TreeRowCtx.Provider value={rowApi}>
            <TreeMenuCtx.Provider value={setMenu}>
              <div key={projectId} className="w-max min-w-full">
                <DirChildren projectId={projectId} path="" depth={0} />
              </div>
            </TreeMenuCtx.Provider>
          </TreeRowCtx.Provider>
        </TreeStatusCtx.Provider>
      </div>
      <ResizeHandle onMouseDown={startResize} onDoubleClick={fitToContent} />
      {/* 드래그 이동 고스트 — 커서 옆 라벨 + 대상 폴더 안내 */}
      <DragGhost ref={ghostRef} />

      {menu && (
        <div
          className="fixed z-50 max-h-[80vh] min-w-52 overflow-y-auto rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          style={
            // 아래쪽 절반에서 열면 메뉴를 위로 펼쳐(커서에 하단 고정) 화면 밖으로 잘리지 않게 한다.
            menu.y > window.innerHeight / 2
              ? {
                  left: Math.min(menu.x, window.innerWidth - 220),
                  bottom: window.innerHeight - menu.y,
                }
              : {
                  left: Math.min(menu.x, window.innerWidth - 220),
                  top: menu.y,
                }
          }
          onClick={(e) => e.stopPropagation()}
        >
          {menu.root ? (
            <>
              <MenuItem
                icon={FilePlus}
                label="새 파일"
                onClick={() => newFile(menu)}
              />
              <MenuItem
                icon={FolderPlus}
                label="새 폴더"
                onClick={() => newFolder(menu)}
              />
            </>
          ) : (
            <>
              {/* 파일 종류를 가리지 않는다 — 뷰어(DiffViewer)가 마크다운·텍스트·이미지·동영상·
                  Office를 이미 다 분기하므로, 여기서 확장자 화이트리스트를 두면 "왜 이 파일은
                  안 되지?"만 만든다. 메인 창에서 열리는 것은 여기서도 열린다. */}
              {menuIsRunnable && (
                <MenuItem
                  icon={Play}
                  label="실행하기"
                  onClick={() => {
                    // 더블클릭 실행과 동일 경로 — 토스트 처리까지 onDouble이 담당한다.
                    onDouble(menu.path, menu.name);
                    setMenu(null);
                  }}
                />
              )}
              <MenuItem
                icon={ExternalLink}
                label="새 창으로 열기"
                onClick={() => {
                  // 이 트리가 보고 있는 저장소 id를 넘긴다 — 임베디드 저장소 파일이 바깥 레포
                  // 기준으로 해석되지 않게(이미지 편집과 같은 이유).
                  openDocWindow(projectId, menu.path);
                  setMenu(null);
                }}
              />
              <div className="my-1 border-t border-edge/60" />
              {showBatch && (
                <>
                  <div className="px-3 py-1 text-[11px] text-fg-dim">
                    선택한 이미지 {selImages.length}개
                  </div>
                  {FORMATS.map((f) => (
                    <MenuItem
                      key={`batch-${f.id}`}
                      icon={ImageDown}
                      label={`${f.label}(으)로 일괄 변환`}
                      onClick={() => void convertBatch(selImages, f.id)}
                    />
                  ))}
                  <div className="my-1 border-t border-edge/60" />
                </>
              )}
              {menuIsHtml && (
                <>
                  <MenuItem
                    icon={Globe}
                    label="브라우저로 열기"
                    onClick={() => openHtmlInBrowser(menu)}
                  />
                  <div className="my-1 border-t border-edge/60" />
                </>
              )}
              {menuIsImage && (
                <>
                  <MenuItem
                    icon={Pencil}
                    label="이미지 편집"
                    onClick={() => {
                      // 더블클릭과 **같은 함수·같은 크기**로 별도 창을 연다 — 여기만 모달로
                      // 두면 같은 파일이 진입 경로에 따라 다른 UI로 갈린다. 저장소 id를 함께
                      // 넘기는 이유는 그대로다: 임베디드 저장소 파일이 바깥 레포 기준으로
                      // 저장되는 것을 막는다(설계 D1).
                      openDocWindow(projectId, menu.path, {
                        size: [1180, 860],
                        edit: true,
                      });
                      setMenu(null);
                    }}
                  />
                  {FORMATS.map((f) => (
                    <MenuItem
                      key={f.id}
                      icon={ImageDown}
                      label={`${f.label}(으)로 변환`}
                      onClick={() => void convert(menu, f.id)}
                    />
                  ))}
                  <div className="my-1 border-t border-edge/60" />
                </>
              )}
              <MenuItem
                icon={FilePlus}
                label="새 파일"
                onClick={() => newFile(menu)}
              />
              <MenuItem
                icon={FolderPlus}
                label="새 폴더"
                onClick={() => newFolder(menu)}
              />
              <MenuItem
                icon={PencilLine}
                label="이름 바꾸기"
                onClick={() => renameEntry(menu)}
              />
              <MenuItem
                icon={Trash2}
                label="삭제"
                danger
                onClick={() => removeEntry(menu)}
              />
              <div className="my-1 border-t border-edge/60" />
              <MenuItem
                icon={Copy}
                label="경로 복사"
                onClick={() => copy(absOf(menu.path), "경로를 복사했습니다")}
              />
              <MenuItem
                icon={Link}
                label="상대 경로 복사"
                onClick={() => copy(toOsPath(menu.path), "상대 경로를 복사했습니다")}
              />
              <MenuItem
                icon={Type}
                label="이름 복사"
                onClick={() => copy(menu.name, "파일 이름을 복사했습니다")}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
