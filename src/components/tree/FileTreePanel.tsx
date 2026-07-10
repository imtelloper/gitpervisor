import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus,
  FolderPlus,
  ImageDown,
  Link,
  Pencil,
  Trash2,
  Type,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import type { ChangeKind, DirEntry, FileChange, RepoStatus } from "../../lib/ipc";
import { isImage } from "../../lib/language-map";
import { usePanelWidth } from "../../lib/use-panel-width";
import {
  useCreateDir,
  useCreateFile,
  useDeletePath,
  useDir,
  useProjects,
  useSaveImage,
  useStatus,
} from "../../queries";
import { useTreeState } from "../../stores/treeState";
import { useUi } from "../../stores/ui";
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
  /** 더블클릭 — 실행 파일이면 확인 후 실행 */
  onDouble: (path: string, name: string) => void;
}
const TreeRowCtx = createContext<TreeRowApi | null>(null);

// 더블클릭으로 실행할 수 있는 파일 확장자(주로 Windows 실행 파일). 프론트 1차 게이트.
const EXEC_EXT = new Set(["exe", "bat", "cmd", "com", "msi"]);
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

  if (isLoading)
    return (
      <div
        style={pad}
        onContextMenu={onPlaceholderMenu}
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
  const { data: status } = useStatus(projectId);
  const { data: projects } = useProjects();
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const askPrompt = useUi((s) => s.askPrompt);
  const openImageEditor = useUi((s) => s.openImageEditor);
  const selectDiff = useUi((s) => s.selectDiff);
  const createDir = useCreateDir(projectId);
  const createFile = useCreateFile(projectId);
  const deletePath = useDeletePath(projectId);
  const saveImage = useSaveImage(projectId);
  const qc = useQueryClient();

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

  // 더블클릭 — 실행 파일이면 확인 후 OS로 실행한다.
  const onDouble = useCallback(
    (path: string, name: string) => {
      if (!isRunnable(name)) return;
      askConfirm({
        title: "실행 파일 실행",
        message: `'${name}'을(를) 실행할까요? 신뢰할 수 있는 파일만 실행하세요.`,
        detail: absOf(path),
        confirmLabel: "실행",
        onConfirm: () => {
          void ipc
            .runExecutable(projectId, path)
            .then(() => pushToast("success", `${name} 실행됨`))
            .catch((err) => pushToast("error", errorMessage(err)));
        },
      });
    },
    // absOf는 projectPath에 의존 — 프로젝트별로 안정. projectId/askConfirm/pushToast도 안정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, projectPath],
  );

  const rowApi = useMemo<TreeRowApi>(
    () => ({ sel: treeSel, onClick: onRowClick, onDouble }),
    [treeSel, onRowClick, onDouble],
  );

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
      </div>
      <div
        ref={treeRef}
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
              {menuIsImage && (
                <>
                  <MenuItem
                    icon={Pencil}
                    label="이미지 편집"
                    onClick={() => {
                      openImageEditor(menu.path);
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
