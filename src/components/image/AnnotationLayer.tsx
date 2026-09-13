// 주석 오버레이 캔버스 — 포인터 상호작용·선택 핸들·텍스트 입력·커밋 레이어 캐시(설계 §4.3~4.4, §5.4~5.6).
//
// **상태 소유권**: 객체 배열과 히스토리는 ImageEditor 가 소유한다. 이 컴포넌트는 제어 컴포넌트로,
// 아직 커밋되지 않은 것(드래그 중인 드래프트, 이동/리사이즈 미리보기, 편집 중인 텍스트)만
// 내부에 들고 있다가 커밋 시점(§5.3)에 onCommit 으로 새 배열을 통째로 올려보낸다.
//
// 좌표계는 셋뿐이다:
//   oriented px  객체가 사는 정본 공간(§3)
//   backing px   = oriented × scale       캔버스 백킹 스토어(그리는 곳)
//   css px       = oriented × displayScale 화면에 보이는 크기(포인터·핸들 크기·textarea)
//
// 제스처·텍스트 편집은 `annotation/` 모듈로 나뉜다(37 §3.5). **화면 크롬은 캔버스에 없다** —
// 43 이 stage 위 SVG 한 겹(`ChromeOverlay`)으로 옮겼다. 여기서 하는 일은 프레임마다
// `ChromeState` 를 조립해 `chrome.update()` 를 부르는 것뿐이고, 그래서 선택 상자·HUD 가
// 저장본에 샐 경로가 **구조적으로** 없다(e2e 30 (o-4)(p-5)).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { CHROME_COLORS, type ChromeScreen, type ChromeState } from "../../lib/annotate/chrome";
import type { ImageStore } from "../../lib/annotate/imageStore";
import { defaultLayerName } from "../../lib/annotate/layer-rows";
import { releaseScratch, renderScene } from "../../lib/annotate/render";
import { useImageEditorUi, type Mode, type Tool } from "../../stores/imageEditor";
import { sceneOfNodes, type Scene } from "../../lib/annotate/scene";
import { objectAABB, objectAnchor, objectBBox, selectBox } from "../../lib/annotate/geometry";
import type { Guide, Measure } from "../../lib/annotate/snap";
import { remove as removeNodes } from "../../lib/annotate/tree";
import {
  newObjId,
  type GeomNode,
  type Node,
  type ObjId,
  type PathNode,
  type Rect,
  type SceneTransform,
  type TextNode,
  type DefaultPaint,
} from "../../lib/annotate/types";
import {
  moveHandle,
  moveVerts,
  type NodeModeUi,
  type VertRef,
} from "../../lib/annotate/vector/edit";
import type { ChromeOverlayHandle } from "./ChromeOverlay";
import {
  applyNodeMode,
  applyNodeOp,
  clampSel,
  nodeChrome,
  nodeEditState,
  type NodeEditState,
  type NodeOp,
} from "./annotation/nodeEdit";
import {
  penDraftNode,
  penFinish,
  penPop,
  penPreview,
  penUsable,
  type PenDraft,
} from "./annotation/pen";
import {
  createPointerHandlers,
  HANDLE_GRAB_CSS,
  marqueeRect,
  MIN_DRAG,
  type DragState,
  type Point,
  type SnapFeedback,
} from "./annotation/pointer";
import {
  TextEditOverlay,
  finishEditing as finishEditingImpl,
  type EditState,
} from "./annotation/textEdit";
import type { StatusBarHandle } from "./EditorStatusBar";

export interface AnnotationLayerHandle {
  /**
   * Esc 계층 2~5를 처리한다(§5.4): 텍스트 확정 → 드래프트 취소 → select 복귀 → 선택 해제.
   * @returns 소비했으면 true(상위는 멈춘다), 처리할 게 없으면 false.
   */
  handleEscape(): boolean;
  /** 다음 프레임에 다시 그린다(외부 상태 변화·E2E 훅용). */
  renderOnce(): void;
  /** 크롭 드래그 중 라이브 사각형(React 상태를 태우지 않고 오버레이만 갱신). null 이면 지운다. */
  setCropPreview(r: Rect | null): void;
  /**
   * 선택된 가이드를 지운다. 42 `delete` 액션이 **노드 삭제보다 먼저** 부른다 —
   * true 를 돌려주면 거기서 끝이다(가이드를 고른 채 Delete 를 눌렀는데 객체가 지워지면 안 된다).
   */
  deleteSelectedGuide(): boolean;
  /** Alt 홀드 측정(42 `measure.hold`). 포인터가 멈춰 있어도 누름/뗌에 반응해야 한다. */
  setAltMeasure(on: boolean): void;
  /**
   * 화면 좌표(clientX/Y) → oriented px. 클램프하지 **않는다** — 이미지 밖에 떨군 것을
   * 가장자리로 끌어다 붙이면 사용자는 자기가 놓은 자리와 다른 곳을 보게 된다.
   *
   * HTML5 drop 은 `PointerEvent` 가 아니라 좌표 두 개만 준다(51 §3.8 에셋 카드 드롭).
   * 포인터 경로(`annotation/pointer.ts` 의 `rawOriented`)와 **같은 산술**이어야 카드를 놓은
   * 자리와 인스턴스가 생기는 자리가 어긋나지 않는다.
   */
  clientToOriented(clientX: number, clientY: number): Point;

  // ── 노드 편집(47) ─────────────────────────────────────────────────────────
  //
  // 세션(선택 정점·펜 드래프트)은 이 컴포넌트 안 **ref** 에 산다(47 §3.2). 밖으로 나가는 것은
  // 요약(`NodeEditState`)뿐이고, 키·컨텍스트 바·인스펙터·e2e 훅이 전부 아래 함수를 부른다 —
  // 같은 조작이 두 경로로 갈리면 히스토리 라벨부터 어긋난다.
  //
  // 키 처리를 여기 두는 이유: 편집기의 키 리스너는 `useEditorKeys` 의 window **capture** 하나
  // 뿐이고 그것이 `stopImmediatePropagation` 까지 한다. 이 컴포넌트가 리스너를 새로 달면
  // 조용히 죽는다(머리말 :497-502 와 같은 규칙).

  /** `path` 노드면 노드 편집으로 들어간다. 아니면 false — 46 `패스로` 뒤에 다시 부른다. */
  enterNodeEdit(id: ObjId): boolean;
  /** 편집 완료. **커밋이 아니다**(§3.2) — 세션만 버리고 모드를 design 으로 되돌린다. */
  exitNodeEdit(): void;
  getNodeEditState(): NodeEditState | null;
  nodeOp(op: NodeOp): void;
  setNodeMode(mode: NodeModeUi): void;
  selectVerts(refs: readonly VertRef[]): void;
  /** 인스펙터 X/Y — 단일 선택 정점을 **절대 좌표**로 옮긴다(커밋 1칸). */
  setVertPos(x: number, y: number): void;
  /** 인스펙터 핸들 in/out — 값은 앵커 **상대** 좌표다(문서 저장 형식과 같다). */
  setVertHandle(side: "in" | "out", x: number, y: number): void;
  /**
   * Enter: 펜 드래프트 완료 → 노드 편집 종료 → 단일 `path` 선택이면 진입(§3.1·§3.2).
   * @returns 소비했으면 true. false 면 상위는 아무 일도 하지 않는다 — design 모드의 Enter 를
   *   무조건 잡으면 포커스된 버튼이 Enter 로 안 눌린다.
   */
  handleEnter(): boolean;
  /** Ctrl+Z: 펜 드래프트가 있으면 **마지막 정점만** 무르고 true(문서 히스토리 불변). */
  handleUndo(): boolean;
}

export interface AnnotationLayerProps {
  /** 회전·반전이 적용된 원본 캔버스 — 모자이크가 샘플링할 픽셀 소스(§5.2). */
  oriented: HTMLCanvasElement;
  /** 백킹 스토어 크기(base 캔버스와 반드시 동일). */
  backW: number;
  backH: number;
  /** oriented → backing px 배율. */
  scale: number;
  /**
   * oriented → **화면** css px 배율(맞춤 배율 × 줌). 히트 허용오차·핸들 집기 반경·핸들
   * 그리기 크기가 전부 이 값을 화면 실배율로 믿는다 — 그래서 줌이 여기 곱해져 들어온다.
   */
  displayScale: number;
  /**
   * 부모가 CSS transform 으로 건 줌 배율(기본 1). `displayScale` 에 이미 곱해져 있으므로,
   * **변환 안쪽 DOM**(텍스트 편집 textarea)만 이 값으로 되나눠 레이아웃 px 를 되찾는다 —
   * 그 요소는 조상 transform 에 함께 스케일되므로 줌을 두 번 먹으면 안 된다.
   */
  zoom?: number;
  /** 이미지에만 걸리는 색보정 필터 — 모자이크 샘플이 출력과 같은 픽셀을 보도록 여기서도 쓴다. */
  filterStr: string;
  objects: readonly Node[];
  /** 이미지 페인트 소스의 디코드 캐시(39 §3.6). 없으면 이미지 채우기가 안 그려진다. */
  store: ImageStore;
  /**
   * 에셋 디코드가 끝날 때마다 오르는 값. 디코드는 비동기라 **문서는 그대로인데** 그릴 수 있는
   * 비트맵만 늘어난다 — 커밋 캐시 키에 넣지 않으면 첫 프레임의 빈 자리가 그대로 굳는다.
   */
  assetsVer: number;
  /**
   * 숨김·잠금·마스크가 풀린 씬(태스크 38). 렌더·히트·선택 상자가 **이것만** 본다 —
   * `objects` 는 커밋과 트리 연산이 쓰는 원본이다.
   */
  scene: Scene;
  /**
   * 화면 크롬을 그리는 SVG 오버레이. **rAF 안에서만** `update` 를 부른다(React 렌더 경로로
   * 밀면 초당 60회 리렌더가 편집기 전체로 번진다 — 상태바·호버와 같은 규칙).
   */
  chrome: React.RefObject<ChromeOverlayHandle | null>;
  /** oriented → stage css px 변환. `getBoundingClientRect` 없이 산술로만 온다(43 §3.2). */
  screen: ChromeScreen;
  /** 문서 가이드(37) — 그리기·스냅·히트가 같은 배열을 본다. */
  guides: readonly Guide[];
  /** 가이드 이동·삭제 커밋. 라벨이 히스토리 항목 이름이 된다(41). */
  onGuidesChange: (next: Guide[], label: string) => void;
  selectedIds: readonly ObjId[];
  tool: Tool;
  style: DefaultPaint;
  opacity: number;
  cropMode: boolean;
  cropRect: Rect | null;
  onCropDown: (p: Point) => void;
  onCropMove: (p: Point) => void;
  onCropUp: () => void;
  /** 진행 중인 크롭 드래그를 버린다(Esc 계층 3) — 에디터 쪽 시작점·라이브 사각형도 함께 지운다. */
  onCropCancel: () => void;
  /** 커밋 시점에만 부른다(§5.3) — 히스토리 스냅샷이 여기서 쌓인다. */
  onCommit: (next: Node[], label?: string) => void;
  /** 텍스트 편집 진입·이탈 — 키 스코프가 도구 단축키를 잡을지 정하는 근거다(42 §3.3). */
  onEditingChange?: (editing: boolean) => void;
  /**
   * 상태바의 커서 좌표·색 칸. **React state 가 아니다** — 마우스를 움직이는 동안 초당 60회
   * 리렌더가 이 컴포넌트를 넘어 편집기 전체로 번지기 때문이다(42 §3.7, K4 와 같은 이유).
   */
  statusRef?: React.RefObject<StatusBarHandle | null>;
  onToolChange: (t: Tool) => void;
  onSelectionChange: (ids: ObjId[]) => void;
  /**
   * 노드 편집 요약(47) — 컨텍스트 바·인스펙터·상태바가 읽는 값.
   *
   * 선택 정점 배열과 펜 드래프트는 **여기로 올라오지 않는다**. 올리면 포인터를 움직이는 동안
   * 편집기 트리 전체가 초당 60회 다시 그려진다(`useCropSession` 의 `ref`/`useState` 갈림과
   * 같은 판정). 모드 자체는 스토어에 있으므로 이 prop 으로 나르지 않는다.
   */
  onNodeEditChange?: (s: NodeEditState | null) => void;
}

function AnnotationLayerImpl(
  props: AnnotationLayerProps,
  ref: React.Ref<AnnotationLayerHandle>,
) {
  // 윈도우 리스너·포인터 핸들러가 항상 최신 props 를 보게 하는 거울(리스너 재등록 회피).
  const p = useRef(props);
  p.current = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 커밋 레이어 캐시(§4.4) — 문서가 바뀔 때만 renderScene 전체를 돌린다.
  // 커밋 캐시는 **DOM 에 올린다**(visibility:hidden). e2e 30·34·35 가 canvases()[0] 을 백킹
    // 크기로 단언하는데, v1 에서 그 자리에 있던 베이스 이미지 캔버스가 씬으로 합쳐졌기 때문이다.
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const cacheKeyRef = useRef("");
  /**
   * 캐시가 담은 이미지. 병합(39 §3.1) 이후 캐시에는 **이미지도** 들어 있어서, 좌우 반전처럼
   * 크기가 그대로인 방향 변경은 키 문자열만으로는 안 잡힌다 — 참조로 직접 비교한다.
   */
  const cacheImgRef = useRef<CanvasImageSource | null>(null);
  const cacheSrcRef = useRef<readonly Node[] | null>(null);

  const rafRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  /** 아직 커밋되지 않은 새 객체(드래그 중). */
  const draftRef = useRef<GeomNode | null>(null);
  /** 이동·리사이즈 미리보기(원본 대신 이것을 그린다). */
  const liveRef = useRef<GeomNode[] | null>(null);
  /** 크롭 라이브 사각형. undefined = 오버라이드 없음(props.cropRect 사용). */
  const cropPreviewRef = useRef<Rect | null | undefined>(undefined);
  /** 번호 뱃지 카운터 — 삭제해도 재정렬하지 않고 계속 증가한다(§12). */
  const badgeSeqRef = useRef(1);
  /** 스마트 가이드·간격 뱃지(드래그 수명) — 크롬에만 가고 문서에는 좌표만 남는다. */
  const snapRef = useRef<SnapFeedback | null>(null);
  /** Alt 홀드 측정. */
  const measureRef = useRef<Measure[] | null>(null);
  /** 선택된 가이드 인덱스(-1 = 없음). 문서가 아니라 화면 상태다. */
  const guideSelRef = useRef(-1);
  /** 마지막 포인터 위치(oriented). */
  const ptRef = useRef<Point | null>(null);
  /**
   * 노드 편집 선택 정점(47). **state 가 아니다** — 정점을 끄는 동안 매 프레임 리렌더가
   * 편집기 전체로 번진다. 밖으로는 요약(`onNodeEditChange`)만 나간다.
   */
  const nodeSelRef = useRef<readonly VertRef[]>([]);
  /** 진행 중인 펜 드래프트(문서 밖 — `annotation/pen.ts` 머리말). 쓰기는 `setPenDraft` 한 곳. */
  const penRef = useRef<PenDraft | null>(null);
  /**
   * 드래프트의 **확정된 부분**을 그리는 문서 밖 노드. 이게 없으면 방금 찍은 정점들이 화면에
   * 하나도 안 보이고 커서까지의 점선만 남는다(`penPreview` 는 다음 구간만 그린다).
   *
   * id 를 드래프트 하나 동안 고정하는 이유는 `penDraftNode` 머리말에 있다 — 프레임마다 바뀌면
   * 커밋 캐시 키가 갈려 포인터를 움직이는 내내 씬 전체가 다시 그려진다.
   */
  const penLiveRef = useRef<PathNode | null>(null);
  const penIdRef = useRef<ObjId | null>(null);

  const [editing, setEditing] = useState<EditState | null>(null);
  const editingRef = useRef<EditState | null>(null);
  editingRef.current = editing;
  /** blur 와 Esc 가 동시에 확정을 부르는 이중 커밋 방지. */
  const editDoneRef = useRef(false);

  // ── 그리기 ────────────────────────────────────────────────────────────────

  /** 커밋된 객체 캐시. 문서·배율·크기·필터·제외 대상이 그대로면 재사용한다. */
  const ensureCache = useCallback((): HTMLCanvasElement | null => {
    const s = p.current;
    const excluded = new Set<ObjId>();
    if (liveRef.current) for (const o of liveRef.current) excluded.add(o.id);
    if (editingRef.current) excluded.add(editingRef.current.obj.id);
    const key = `${s.backW}x${s.backH}|${s.scale}|${s.filterStr}|${s.assetsVer}|${[...excluded].join(",")}`;
    if (
      cacheRef.current &&
      cacheSrcRef.current === s.objects &&
      cacheImgRef.current === s.oriented &&
      cacheKeyRef.current === key
    ) {
      return cacheRef.current;
    }
    const cv = cacheRef.current;
    if (!cv) return null;
    if (cv.width !== s.backW || cv.height !== s.backH) {
      cv.width = s.backW;
      cv.height = s.backH;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cv.width, cv.height);
    // 이미지도 **같은 캔버스**에 그린다 — 그래야 형광펜 multiply·가림 샘플링이 재구성 없이
    // 성립한다. 조정 필터는 이미지에만 걸린다(renderScene 안 한 곳, D2).
    renderScene(ctx, s.scene, sceneTransform(s.scale), {
      image: s.oriented,
      background: "image",
      filter: s.filterStr,
      skipIds: excluded,
      store: s.store,
    });
    cacheSrcRef.current = s.objects;
    cacheImgRef.current = s.oriented;
    cacheKeyRef.current = key;
    return cv;
  }, []);

  const paintNow = useCallback(() => {
    const c = canvasRef.current;
    const s = p.current;
    if (!c) return;
    if (c.width !== s.backW || c.height !== s.backH) {
      c.width = s.backW;
      c.height = s.backH;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, c.width, c.height);

    const cache = ensureCache();
    if (cache) ctx.drawImage(cache, 0, 0);

    // 아직 커밋되지 않은 것들은 매 프레임 새로 그린다(캐시에는 없다).
    const live: GeomNode[] = [];
    if (liveRef.current) live.push(...liveRef.current);
    if (draftRef.current) live.push(draftRef.current);
    // 펜 드래프트의 확정 부분 — 아직 문서에 없으므로 캐시에도 없다. 커밋 뒤와 같은 픽셀이다.
    if (penLiveRef.current) live.push(penLiveRef.current);
    if (live.length) {
      // 드래그 중인 것은 아직 문서에 없다 — 임시 씬으로 감싸 **같은 렌더 진입**을 쓴다.
      // 배경(이미지 + 커밋 노드)은 이미 캐시로 깔려 있어 가림·multiply 가 그대로 성립한다.
      renderScene(ctx, sceneOfNodes(live), sceneTransform(s.scale), {
        background: "transparent",
        store: s.store,
      });
    }

    // 크롬은 **이 캔버스에 한 획도 그리지 않는다**. 같은 프레임 안에서 SVG 오버레이 속성만
    // 갱신한다 — 그래서 저장·내보내기 어디에도 샐 자리가 없다(43 §3.1).
    s.chrome.current?.update(
      buildChromeState(s, {
        drag: dragRef.current,
        draft: draftRef.current,
        live: liveRef.current,
        crop: cropPreviewRef.current,
        snap: snapRef.current,
        measures: measureRef.current,
        guideSel: guideSelRef.current,
        pt: ptRef.current,
        nodeSel: nodeSelRef.current,
        pen: penRef.current,
      }),
    );
  }, [ensureCache]);

  /** rAF 코얼레싱 — 한 프레임에 한 번만 그린다(§4.4). */
  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      paintNow();
    });
  }, [paintNow]);

  /**
   * 크롬 값의 **구독**. `paintNow` 는 이 둘을 `getState()` 로 읽으므로(리렌더 폭주 방지)
   * 구독이 없으면 눈금자를 켜도, 레이어 패널 위에서 행을 훑어도 다음 마우스 이동까지
   * 화면이 그대로다. 호버는 **대상이 바뀔 때만** 흐르므로 초당 60회가 아니다.
   */
  const toggles = useImageEditorUi((s) => s.toggles);
  const hoverId = useImageEditorUi((s) => s.hoverId);
  /**
   * 모드도 같은 이유로 **구독**한다 — 노드 편집으로 들어간 순간 스크림·앵커가 떠야 하는데,
   * `getState()` 로만 읽으면 다음 포인터 이동까지 화면이 그대로다(커서 클래스도 같다).
   */
  const mode = useImageEditorUi((s) => s.mode);

  // 캐시를 버려야 하는 변화(문서·배율·크기·필터)와 매 프레임 크롬(선택·화면 변환)을 다시 그린다.
  useLayoutEffect(() => {
    schedule();
  }, [
    schedule,
    props.objects,
    props.selectedIds,
    props.backW,
    props.backH,
    props.scale,
    props.displayScale,
    props.filterStr,
    props.cropRect,
    props.cropMode,
    props.oriented,
    // 팬은 배율을 바꾸지 않는다 — `screen` 이 없으면 화면을 밀어도 크롬만 제자리에 남는다.
    props.screen,
    props.guides,
    toggles,
    hoverId,
    mode,
    editing,
  ]);

  // 가이드 선택은 **캔버스 포인터가 만든 화면 상태**라 밖에서 선택이 바뀌면 낡는다
  // (레이어 패널 행 클릭·Ctrl+A·Esc 는 `pointer.ts` 를 거치지 않는다). 낡은 채로 두면
  // Delete 가 노드가 아니라 가이드를 지우고, 사용자에게는 '삭제가 안 먹는다'로 보인다.
  // `guidesVisible` 이 꺼졌을 때도 같다 — 그리지도 잡히지도 않는 가이드를 지우게 된다.
  // 같은 프레임의 `schedule()`(위 layout effect)이 이 값을 읽으므로 다시 그릴 필요는 없다.
  useEffect(() => {
    guideSelRef.current = -1;
  }, [props.selectedIds, toggles.guidesVisible]);

  useEffect(
    () => () => {
      // 취소한 rAF 는 콜백이 돌지 않으니 플래그도 직접 되돌린다 — 남겨 두면 이후 schedule() 이
      // 전부 무시돼 캔버스가 미도색으로 굳는다(StrictMode 이중 마운트에서 실제로 잠겼다).
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    },
    [],
  );

  // ── 커밋 헬퍼 ─────────────────────────────────────────────────────────────

  // `label` 을 그대로 넘긴다 — 여기서 떨어뜨리면 히스토리가 `describeChange` 자동 라벨
  // ('사각형 삭제')로 덮여, 지우개 드래그 한 번이 무엇이었는지 패널에서 알 수 없게 된다.
  // 인자를 하나만 받아도 TS 는 통과하므로 조용히 사라진다.
  const commitObjects = useCallback((next: Node[], label?: string) => {
    p.current.onCommit(next, label);
  }, []);

  /** 편집 중이던 텍스트를 확정한다. 내용이 비면 객체를 만들지 않거나 삭제한다(§5.5). */
  const finishEditing = useCallback(() => {
    finishEditingImpl({
      p,
      editingRef,
      editDoneRef,
      setEditing,
      commitObjects,
      schedule,
    });
  }, [commitObjects, schedule]);

  const beginEditing = useCallback(
    (obj: TextNode, isNew: boolean) => {
      // 이전 편집이 남아 있으면 먼저 확정한다(두 개가 동시에 열리지 않게).
      if (editingRef.current) finishEditing();
      editDoneRef.current = false;
      const st: EditState = { obj, isNew, text: obj.text };
      editingRef.current = st;
      setEditing(st);
      schedule();
    },
    [finishEditing, schedule],
  );

  // ── 노드 편집 세션(47 §3.2) ───────────────────────────────────────────────

  /** 컨텍스트 바·인스펙터·상태바가 읽는 요약을 위로 올린다. 문서·선택이 바뀔 때만 부른다. */
  const emitNodeEdit = useCallback(() => {
    const s = p.current;
    const o = editedPath(s.objects, useImageEditorUi.getState().mode);
    s.onNodeEditChange?.(o ? nodeEditState(o, nodeSelRef.current, penRef.current) : null);
  }, []);

  /**
   * 펜 드래프트를 갈아 끼우는 **유일한 자리**. 드래프트와 그것을 그리는 라이브 노드가 여기서만
   * 함께 바뀌므로 둘이 갈릴 수 없다(갈리면 "그린 선이 한 박자 늦게 따라온다"가 된다).
   *
   * 요약(`onNodeEditChange`)은 **정점 수가 바뀔 때만** 올린다. 요약에 실리는 드래프트 정보가
   * 정점 수 하나뿐인데 매 pointermove 마다 올리면, 커서를 움직이는 내내 편집기 트리 전체가
   * 초당 60회 다시 그려진다(이 파일이 세션을 state 로 안 들고 있는 것과 같은 이유).
   */
  const setPenDraft = useCallback(
    (d: PenDraft | null) => {
      const s = p.current;
      const before = penRef.current?.verts.length ?? -1;
      penRef.current = d;
      if (!d) {
        penIdRef.current = null;
        penLiveRef.current = null;
      } else {
        if (!penIdRef.current) penIdRef.current = newObjId();
        penLiveRef.current = penDraftNode(d, s.style, s.opacity, penIdRef.current);
      }
      if ((d?.verts.length ?? -1) !== before) emitNodeEdit();
      schedule();
    },
    [emitNodeEdit, schedule],
  );

  /** 선택 정점 갱신 — 범위 밖 ref 를 걷고(41 "존재 id 필터") 요약을 올린다. */
  const setNodeSel = useCallback(
    (refs: readonly VertRef[]) => {
      const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
      nodeSelRef.current = o ? clampSel(o, refs) : [];
      emitNodeEdit();
      schedule();
    },
    [emitNodeEdit, schedule],
  );

  /**
   * 편집 대상 노드를 갈아 끼우고 **커밋 1회**(= 히스토리 한 칸).
   *
   * `next` 가 입력과 **같은 참조**면 커밋하지 않는다 — `edit.ts` 의 연산들은 바뀐 것이 없으면
   * 원본을 돌려주고, 그걸 그대로 커밋하면 버튼 한 번이 히스토리 200칸 중 하나를 빈 칸으로
   * 태운다(Ctrl+Z 를 눌러도 화면이 그대로인 그 증상).
   *
   * `next === null` 은 정점이 하나도 안 남았다는 뜻이라 **객체를 지운다**(§3.3 `deleteVerts`).
   * 모드는 여기서 끄지 않는다 — 아래 세션 effect 가 문서에서 대상이 사라진 것을 보고 나간다.
   */
  const commitNode = useCallback(
    (cur: PathNode, next: PathNode | null, label: string, sel: readonly VertRef[]) => {
      const s = p.current;
      if (next !== cur) {
        commitObjects(
          next
            ? s.objects.map((o) => (o.id === cur.id ? next : o))
            : removeNodes(s.objects, [cur.id]),
          label,
        );
      }
      nodeSelRef.current = next ? sel : [];
      emitNodeEdit();
      schedule();
    },
    [commitObjects, emitNodeEdit, schedule],
  );

  const enterNodeEdit = useCallback(
    (id: ObjId): boolean => {
      const o = p.current.objects.find((n) => n.id === id);
      // `path` 가 아니면 들어가지 않는다(§3.2) — 46 `패스로`(toPathObject) 로 바꾼 뒤가 그 경로다.
      if (!o || o.kind !== "path") return false;
      nodeSelRef.current = [];
      setPenDraft(null);
      useImageEditorUi.getState().setMode({ kind: "nodeEdit", id });
      schedule();
      return true;
    },
    [schedule, setPenDraft],
  );

  const exitNodeEdit = useCallback(() => {
    nodeSelRef.current = [];
    setPenDraft(null);
    useImageEditorUi.getState().setMode({ kind: "design" });
    schedule();
  }, [schedule, setPenDraft]);

  /**
   * 펜 드래프트를 문서로 굳힌다(§3.1 완료) — **커밋 1회**. 새 객체면 그대로 노드 편집으로
   * 들어간다(시안 ③ 이 펜 직후 상태다).
   *
   * 정점이 2개 미만이면 남길 것이 없어 드래프트만 버린다(커밋 0). @returns 드래프트가 있었나.
   */
  const finishPen = useCallback(
    (closed: boolean): boolean => {
      const s = p.current;
      const d = penRef.current;
      if (!d) return false;
      setPenDraft(null);
      if (penUsable(d)) {
        const made = penFinish(d, closed, s.style, s.opacity);
        if ("sub" in made) {
          // 노드 편집 중 빈 곳에서 시작한 드래프트 = 같은 객체에 서브패스 추가(46 짝수-홀수 구멍).
          const t = d.target;
          const host =
            t.kind === "append" ? s.objects.find((o) => o.id === t.id) : undefined;
          if (host && host.kind === "path") {
            commitObjects(
              s.objects.map((o) =>
                o.id === host.id ? { ...host, subpaths: [...host.subpaths, made.sub] } : o,
              ),
              "펜 경로 생성",
            );
          }
        } else {
          commitObjects([...s.objects, made], "펜 경로 생성");
          s.onSelectionChange([made.id]);
          nodeSelRef.current = [];
          useImageEditorUi.getState().setMode({ kind: "nodeEdit", id: made.id });
        }
      }
      emitNodeEdit();
      schedule();
      return true;
    },
    [commitObjects, emitNodeEdit, schedule, setPenDraft],
  );

  /**
   * 세션의 바깥 조건을 보는 **한 곳**(48 `useCropSession` 의 모드 effect 와 같은 자리).
   *
   * 되돌리기·삭제로 편집 대상이 문서에서 사라지면 스스로 나간다 — 안 나가면 세션이 죽은 id 를
   * 든 채 크롬만 남고, 그 뒤의 Delete 는 아무 일도 하지 않는다. 정점 수가 줄었으면 범위 밖
   * 선택을 걷는다(41 의 "존재 id 필터"와 같은 규칙).
   */
  useEffect(() => {
    if (mode.kind !== "nodeEdit") {
      if (nodeSelRef.current.length || penRef.current) {
        nodeSelRef.current = [];
        setPenDraft(null);
      }
      emitNodeEdit();
      return;
    }
    const o = editedPath(props.objects, mode);
    if (!o) {
      exitNodeEdit();
      return;
    }
    const next = clampSel(o, nodeSelRef.current);
    if (next !== nodeSelRef.current) nodeSelRef.current = next;
    emitNodeEdit();
  }, [props.objects, mode, emitNodeEdit, exitNodeEdit, setPenDraft]);

  /**
   * 도구가 펜을 떠나면 드래프트를 버린다.
   *
   * 안 버리면 확정된 부분이 라이브 노드로 화면에 계속 그려진다 — 문서에는 없는 선이라 지울
   * 수단도 없고(러버밴드·힌트는 `vpen` 일 때만 그린다) 저장하면 사라져 "그린 게 없어졌다"가 된다.
   * 도구를 바꾸는 것은 Esc 와 같은 취소다(커밋 0).
   */
  useEffect(() => {
    if (props.tool !== "vpen" && penRef.current) setPenDraft(null);
  }, [props.tool, setPenDraft]);

  // ── 포인터 ────────────────────────────────────────────────────────────────

  const { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, applyAltMeasure } =
    createPointerHandlers({
      p,
      canvasRef,
      dragRef,
      draftRef,
      liveRef,
      editingRef,
      badgeSeqRef,
      snapRef,
      measureRef,
      guideSelRef,
      ptRef,
      schedule,
      commitObjects,
      finishEditing,
      beginEditing,
      // 노드 편집·펜 세션으로 가는 통로(47 §3.4). 여기 있는 것은 전부 **이 컴포넌트가 소유한
      // ref 와 커밋 헬퍼**다 — 포인터 층은 좌표와 스냅만 얹는다.
      node: {
        edited: () => editedPath(p.current.objects, useImageEditorUi.getState().mode),
        sel: () => nodeSelRef.current,
        setSel: setNodeSel,
        pen: () => penRef.current,
        setPen: setPenDraft,
        setLive: (o) => {
          liveRef.current = o ? [o] : null;
        },
        commit: commitNode,
        finishPen,
        enter: enterNodeEdit,
        schedule,
      },
    });

  // ── 상태바 커서(좌표·색) ──────────────────────────────────────────────────
  //
  // rAF 당 **한 번만** 읽는다. `getImageData` 는 GPU→CPU 동기화라 포인터 이벤트마다 부르면
  // 고해상도 마우스에서 프레임당 대여섯 번 파이프라인이 멈춘다.

  const cursorRafRef = useRef(0);
  const cursorPosRef = useRef<{ cx: number; cy: number } | null>(null);

  /** 화면 → oriented px. 커서 표시와 에셋 드롭(51)이 같은 산술을 쓴다 — 핸들이 이걸 내보낸다. */
  const clientToOriented = useCallback((cx: number, cy: number): Point => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((cx - r.left) / Math.max(1, r.width)) * p.current.oriented.width,
      y: ((cy - r.top) / Math.max(1, r.height)) * p.current.oriented.height,
    };
  }, []);

  const flushCursor = useCallback(() => {
    cursorRafRef.current = 0;
    const h = p.current.statusRef?.current;
    const c = canvasRef.current;
    const pos = cursorPosRef.current;
    if (!h || !c || !pos) return;
    const ow = p.current.oriented.width;
    const oh = p.current.oriented.height;
    const { x, y } = clientToOriented(pos.cx, pos.cy);
    if (x < 0 || y < 0 || x >= ow || y >= oh) {
      h.setCursor(null, null, null);
      return;
    }
    // 색은 **이 캔버스**에서 읽는다 — 39 이후 여기에 이미지와 노드가 불투명 합성돼 있어
    // 화면에 보이는 색 그대로다. 좌표는 oriented 지만 픽셀은 백킹 스토어 기준이라 scale 을 건다.
    let rgb: string | null = null;
    try {
      const bx = Math.min(c.width - 1, Math.max(0, Math.floor(x * p.current.scale)));
      const by = Math.min(c.height - 1, Math.max(0, Math.floor(y * p.current.scale)));
      const d = c.getContext("2d")!.getImageData(bx, by, 1, 1).data;
      rgb =
        "#" +
        [d[0], d[1], d[2]]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
    } catch {
      // 캔버스가 오염됐거나(교차 출처 에셋) 크기가 0 인 순간 — 좌표만 보여 준다.
    }
    h.setCursor(x, y, rgb);
  }, [clientToOriented]);

  const trackCursor = useCallback(
    (e: React.PointerEvent) => {
      if (!p.current.statusRef) return;
      cursorPosRef.current = { cx: e.clientX, cy: e.clientY };
      if (cursorRafRef.current) return;
      cursorRafRef.current = requestAnimationFrame(flushCursor);
    },
    [flushCursor],
  );

  const clearCursor = useCallback(() => {
    if (cursorRafRef.current) {
      cancelAnimationFrame(cursorRafRef.current);
      cursorRafRef.current = 0;
    }
    cursorPosRef.current = null;
    p.current.statusRef?.current?.setCursor(null, null, null);
    // 포인터를 따라다니는 크롬(Alt 측정·픽셀 스냅 셀)은 포인터가 나가면 함께 사라져야 한다 —
    // 안 그러면 마지막 위치에 굳어 "왜 저기 뱃지가 남아 있지"가 된다.
    ptRef.current = null;
    measureRef.current = null;
    schedule();
  }, [schedule]);

  // 편집기가 사라지면 모듈 스크래치를 놓아 준다 — 모듈 전역이라 창 수명 동안 마지막 크기
  // 그대로 남아 있었다(창당 최대 ~15MB). doc-* 창은 별도 WebView2라 창마다 따로 쌓인다.
  useEffect(() => releaseScratch, []);

  // 예약해 둔 커서 rAF 는 언마운트에서 거둔다 — 남으면 사라진 캔버스를 읽는다.
  useEffect(
    () => () => {
      if (cursorRafRef.current) cancelAnimationFrame(cursorRafRef.current);
    },
    [],
  );

  // 키보드 리스너는 여기 없다 — 편집기 전체가 `useEditorKeys` 의 window **capture**
  // 리스너 하나를 쓴다(42 §3.3). 이 컴포넌트가 따로 달면 리스너가 둘이 되고, 어느 쪽이
  // 먼저 먹는지가 lazy 로딩 순서에 달려 실행마다 달라진다.
  //
  // 대신 **텍스트 편집 중인지**만 위로 올린다. 그 상태에서는 글자가 그대로 입력돼야 하므로
  // 키 스코프가 도구 단축키를 잡으면 안 된다.
  useEffect(() => {
    p.current.onEditingChange?.(editing !== null);
  }, [editing]);

  // ── 외부 노출 핸들 ────────────────────────────────────────────────────────

  useImperativeHandle(
    ref,
    (): AnnotationLayerHandle => ({
      handleEscape() {
        const s = p.current;
        if (editingRef.current) {
          finishEditing();
          return true;
        }
        // 펜 드래프트는 **취소**다(커밋 0) — 그리던 것을 그냥 버린다. 취소 키가 커밋을 하면
        // 사용자는 되돌린 줄 알고 손을 떼는데 문서에는 객체가 남는다. 완료는 Enter·첫 정점
        // 클릭(닫기)뿐이다(47 §3.1 · `pen.ts` 머리말).
        if (penRef.current) {
          setPenDraft(null);
          return true;
        }
        // 진행 중인 드래그는 종류를 가리지 않고 버린다(§5.4 계층 3). 크롭 드래그도 포함해야
        // Esc 뒤에 버튼을 떼는 것만으로 크롭이 확정되는 일이 없다.
        const d = dragRef.current;
        if (draftRef.current || d) {
          draftRef.current = null;
          liveRef.current = null;
          dragRef.current = null;
          snapRef.current = null;
          if (d?.mode === "crop") {
            cropPreviewRef.current = undefined;
            s.onCropCancel();
          }
          schedule();
          return true;
        }
        // 노드 선택 해제 → 노드 편집 종료. **도구 복귀보다 앞**이어야 한다: 스토어는 도구가
        // `select`|`vpen` 이면 nodeEdit 을 유지하므로(imageEditor.ts:232-238) 뒤에 두면 Esc 한
        // 번이 도구만 바꾸고 편집 모드는 남아, 나가려면 두세 번을 눌러야 한다(47 §3.6 계층).
        if (useImageEditorUi.getState().mode.kind === "nodeEdit") {
          if (nodeSelRef.current.length) {
            nodeSelRef.current = [];
            emitNodeEdit();
            schedule();
            return true;
          }
          exitNodeEdit();
          return true;
        }
        if (s.tool !== "select") {
          s.onToolChange("select");
          return true;
        }
        if (s.selectedIds.length) {
          s.onSelectionChange([]);
          return true;
        }
        return false;
      },
      renderOnce() {
        schedule();
      },
      setCropPreview(r) {
        cropPreviewRef.current = r === null ? undefined : r;
        schedule();
      },
      deleteSelectedGuide() {
        const i = guideSelRef.current;
        const s = p.current;
        if (i < 0 || i >= s.guides.length) return false;
        guideSelRef.current = -1;
        s.onGuidesChange(
          s.guides.filter((_, k) => k !== i).map((g) => ({ ...g })),
          "가이드 삭제",
        );
        schedule();
        return true;
      },
      setAltMeasure(on) {
        applyAltMeasure(on);
        schedule();
      },
      clientToOriented,

      enterNodeEdit,
      exitNodeEdit,
      getNodeEditState() {
        const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
        return o ? nodeEditState(o, nodeSelRef.current, penRef.current) : null;
      },
      nodeOp(op) {
        const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
        if (!o) return;
        // 할 수 있는 일이 없으면 `null` 이다(비활성 버튼) — 그때는 커밋도 선택 변경도 없다.
        const r = applyNodeOp(o, nodeSelRef.current, op);
        if (r) commitNode(o, r.obj, r.label, r.sel);
      },
      setNodeMode(m) {
        const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
        if (!o) return;
        const r = applyNodeMode(o, nodeSelRef.current, m);
        if (r) commitNode(o, r.obj, r.label, nodeSelRef.current);
      },
      // 선택은 **문서가 아니다** — 커밋하지 않는다(모드 진입·노드 선택은 히스토리에 안 쌓인다).
      // 포인터가 부르는 것과 **같은 함수**라 범위 클램프가 한 벌이다.
      selectVerts: setNodeSel,
      setVertPos(x, y) {
        const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
        const sel = nodeSelRef.current;
        const v = o && sel.length === 1 ? vertOf(o, sel[0]) : null;
        // 여럿을 고른 채 절대 좌표를 쓰면 정점들이 한 점으로 뭉친다 — 인스펙터가 단일 선택에서만
        // X/Y 를 그리는 이유이고, 여기서도 같은 조건으로 막는다.
        if (!o || !v) return;
        commitNode(o, moveVerts(o, sel, x - v.x, y - v.y), "노드 이동", sel);
      },
      setVertHandle(side, x, y) {
        const o = editedPath(p.current.objects, useImageEditorUi.getState().mode);
        const sel = nodeSelRef.current;
        const v = o && sel.length === 1 ? vertOf(o, sel[0]) : null;
        if (!o || !v) return;
        // 인스펙터 값은 앵커 **상대**(문서 저장 형식)이고 `moveHandle` 은 절대 좌표를 받는다.
        commitNode(
          o,
          moveHandle(o, sel[0], side, { x: v.x + x, y: v.y + y }, { alt: false }),
          "핸들 조정",
          sel,
        );
      },
      handleEnter() {
        const s = p.current;
        // 1) 펜 드래프트 완료(열린 채) — 커밋 1회 뒤 곧바로 노드 편집으로 들어간다.
        if (finishPen(false)) return true;
        const ui = useImageEditorUi.getState();
        // 2) `편집 완료 ⏎` — 종료는 커밋이 아니다.
        if (ui.mode.kind === "nodeEdit") {
          exitNodeEdit();
          return true;
        }
        // 3) 단일 `path` 선택 + Enter = 진입(§3.2). 아니면 **소비하지 않는다** — design 의
        //    Enter 를 무조건 잡으면 포커스된 버튼이 Enter 로 안 눌린다.
        if (ui.mode.kind === "design" && s.selectedIds.length === 1) {
          return enterNodeEdit(s.selectedIds[0]);
        }
        return false;
      },
      handleUndo() {
        const d = penRef.current;
        if (!d) return false;
        // 드래프트 안에서만 무른다 — 문서 undo 로 새면 "그리기 전"의 편집이 대신 사라진다.
        setPenDraft(penPop(d));
        return true;
      },
    }),
    [
      applyAltMeasure,
      clientToOriented,
      commitNode,
      emitNodeEdit,
      enterNodeEdit,
      exitNodeEdit,
      finishEditing,
      finishPen,
      schedule,
      setNodeSel,
      setPenDraft,
    ],
  );

  return (
    <>
      {/* [0] 커밋 캐시 — 화면에는 안 보이지만 DOM 에 있어야 한다. e2e 가 canvases()[0] 의
          백킹 크기를 단언하고, 무엇보다 이 캔버스가 v1 의 베이스 이미지 자리를 잇는다.
          `visibility:hidden` 은 getImageData 를 막지 않는다(규격). */}
      <canvas
        ref={cacheRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ visibility: "hidden" }}
      />
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        // 캔버스는 포커스 대상이 아니라, 누르면 브라우저가 **가장 가까운 포커스 가능 조상**인
        // 편집기 루트(`role="application"` · `tabIndex={-1}`)로 포커스를 옮긴다. 평소엔 그게
        // 맞다(Space = 손 도구). 그러나 텍스트 편집이 열려 있으면 그 이동이 textarea 를 blur
        // 시키고 `onBlur → finishEditing` 이 빈 글자를 "취소"로 읽어 노드를 버린다 —
        // **글자를 한 자도 못 친다.** 편집 중에는 포커스가 textarea 의 것이다(Space 도
        // 손 도구가 아니라 공백이어야 한다).
        //
        // pointerdown 이 아니라 mousedown 을 막는 이유: 포커스 이동은 mousedown 의 기본
        // 동작이고, pointerdown 의 preventDefault 는 엔진마다 이를 막아 주지 않는다.
        // 한 프레임 미뤄 포커스하는 우회는 실패했다 — rAF(~16ms)가 pointerup/click 보다
        // 먼저라, 잡은 포커스를 제스처 후반이 다시 뺏어갔다(실측).
        onMouseDown={(e) => {
          if (editingRef.current) e.preventDefault();
        }}
        onPointerMove={(e) => {
          trackCursor(e);
          onPointerMove(e);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={clearCursor}
        onDoubleClick={onDoubleClick}
        className={`absolute inset-0 h-full w-full ${
          // 노드 편집은 도구가 `select` 여도 십자선이다(47 §3.5) — 정점을 집는 화면에서
          // 화살표 커서는 "여기서는 객체를 고른다"는 다른 약속을 한다.
          props.cropMode || props.tool !== "select" || mode.kind === "nodeEdit"
            ? "cursor-crosshair"
            : "cursor-default"
        }`}
        style={{
          touchAction: "none",
          // 100%를 넘겨 확대하면 보간을 끄고 픽셀을 그대로 보여준다(뷰어와 같은 규칙).
          // v1 에서 베이스 캔버스가 하던 일 — 씬 캔버스로 옮겨 왔다.
          imageRendering: props.displayScale >= 2 ? "pixelated" : "auto",
        }}
      />
      <TextEditOverlay
        editing={editing}
        setEditing={setEditing}
        onFinish={finishEditing}
        displayScale={props.displayScale}
        zoom={props.zoom}
      />
    </>
  );
}

const AnnotationLayer = forwardRef<AnnotationLayerHandle, AnnotationLayerProps>(
  AnnotationLayerImpl,
);
export default AnnotationLayer;

// ── 순수 헬퍼 ───────────────────────────────────────────────────────────────

function sceneTransform(scale: number): SceneTransform {
  return { tx: 0, ty: 0, sx: scale, sy: scale };
}

/**
 * 지금 노드 편집 중인 노드. **모드와 문서가 둘 다 맞을 때만** 값이다(47 §3.2).
 *
 * `objects` 를 보는 것이 중요하다 — 되돌리기·삭제로 대상이 사라져도 모드는 스토어에 남아 있어서,
 * id 만 믿으면 죽은 노드에 크롬을 그리려다 매 프레임 undefined 를 만진다.
 */
function editedPath(objects: readonly Node[], mode: Mode): PathNode | null {
  if (mode.kind !== "nodeEdit") return null;
  const o = objects.find((n) => n.id === mode.id);
  return o && o.kind === "path" ? o : null;
}

/** 문서 그대로의 정점(auto 핸들 물질화 전) — 좌표 델타를 잴 때는 이 값이 기준이다. */
function vertOf(o: PathNode, r: VertRef) {
  return o.subpaths[r.sub]?.verts[r.vert] ?? null;
}

/** 여러 사각형의 합집합. 비어 있으면 null — "폭 0 상자"와 "없음"은 다른 뜻이다. */
function unionRect(rects: readonly Rect[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * 드래그 중 수치(시안 `Dim Badge`). 종전 캔버스 HUD 의 규칙 그대로다 — 스냅·가이드가 생긴
 * 지금도 "지금 무엇을 만들고 있는가"를 아는 값은 이것뿐이다.
 *
 * 텍스트가 없으면 null 을 돌려 **선택 크기 뱃지로 되돌아간다**. 예전에는 여기서 아무것도 안
 * 그렸는데, 그러면 3px 미만 이동에서 뱃지가 깜빡였다.
 */
function dragHudText(
  d: DragState | null,
  draft: GeomNode | null,
  live: readonly GeomNode[] | null,
): { text: string; box: Rect } | null {
  if (!d) return null;
  if (d.mode === "marquee") {
    const r = marqueeRect(d);
    if (r.w < MIN_DRAG && r.h < MIN_DRAG) return null;
    return { text: `${Math.round(r.w)} × ${Math.round(r.h)}`, box: r };
  }
  if (d.mode === "measure") {
    const len = Math.hypot(d.cur.x - d.a.x, d.cur.y - d.a.y);
    if (len < MIN_DRAG) return null;
    return {
      text: `${Math.round(len)} px`,
      box: {
        x: Math.min(d.a.x, d.cur.x),
        y: Math.min(d.a.y, d.cur.y),
        w: Math.abs(d.cur.x - d.a.x),
        h: Math.abs(d.cur.y - d.a.y),
      },
    };
  }
  if (d.mode === "draw" && draft) {
    // 자유곡선은 폭·높이가 의미를 못 준다 — 아무것도 안 띄운다.
    if (draft.kind === "pen" || draft.kind === "highlight") return null;
    const box = objectAABB(draft);
    if (draft.kind === "line" || draft.kind === "arrow") {
      const dx = draft.x2 - draft.x1;
      const dy = draft.y2 - draft.y1;
      const deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      return { text: `${Math.round(Math.hypot(dx, dy))} px  ∠${deg}°`, box };
    }
    return { text: `${Math.round(box.w)} × ${Math.round(box.h)}`, box };
  }
  if (d.mode === "resize" && live && live[0]) {
    const box = objectAABB(live[0]);
    return { text: `${Math.round(box.w)} × ${Math.round(box.h)}`, box };
  }
  if (d.mode === "move" && live && live[0]) {
    const from = objectBBox(d.base[0]);
    const to = objectBBox(live[0]);
    const dx = Math.round(to.x - from.x);
    const dy = Math.round(to.y - from.y);
    // 단순 클릭 선택(pointerdown 이 move 드래그를 세운 직후)에서 "+0 +0" 이 깜빡이는 것을 막는다.
    if (Math.abs(dx) < MIN_DRAG && Math.abs(dy) < MIN_DRAG) return null;
    return {
      text: `${dx >= 0 ? "+" : ""}${dx}  ${dy >= 0 ? "+" : ""}${dy}`,
      box: objectAABB(live[0]),
    };
  }
  return null;
}

/**
 * 이 프레임에 그려질 크롬 전부(43 §3.3).
 *
 * 좌표는 전부 **oriented px** 다 — 화면 변환은 오버레이가 `screen` 으로 한 번만 곱한다.
 * 여기서 css px 를 섞으면 확대할 때 선이 같이 굵어지는, 캔버스 크롬을 버린 바로 그 증상이
 * 되돌아온다.
 */
function buildChromeState(
  s: AnnotationLayerProps,
  f: {
    drag: DragState | null;
    draft: GeomNode | null;
    live: readonly GeomNode[] | null;
    crop: Rect | null | undefined;
    snap: SnapFeedback | null;
    measures: Measure[] | null;
    guideSel: number;
    pt: Point | null;
    /** 노드 편집 선택 정점(47). 세션은 ref 에 살고 이 함수는 값만 받는다. */
    nodeSel: readonly VertRef[];
    pen: PenDraft | null;
  },
): ChromeState {
  const ui = useImageEditorUi.getState();
  const t = ui.toggles;
  const byId = new Map<ObjId, GeomNode>((f.live ?? []).map((o) => [o.id, o]));
  const selSet = new Set<ObjId>(s.selectedIds);

  // 선택 상자는 **씬**을 본다 — 숨긴 노드에 상자가 남으면 "보이는 것 ≠ 선택된 것"이 된다.
  // 컨테이너를 골랐으면 자손이 대신 잡힌다(그래서 그룹도 점선 + 합집합 실선이 된다).
  const picked: GeomNode[] = [];
  // 선택이 없으면 조상 사슬을 한 번도 타지 않는다 — 이 루프는 **매 프레임** 돈다.
  for (const o of selSet.size ? s.scene.nodes : []) {
    let cur: ObjId | null = o.id;
    for (let guard = 0; cur && guard <= s.scene.nodes.length; guard++) {
      if (selSet.has(cur)) {
        picked.push(byId.get(o.id) ?? o);
        break;
      }
      cur = s.scene.owner.get(cur) ?? null;
    }
  }
  const single = picked.length === 1 && selSet.has(picked[0].id);
  const selection: ChromeState["selection"] = single
    ? [
        {
          // 리프 하나는 **회전 상자**다 — 축정렬 외접 사각형을 그리면 잡는 곳과 보이는 곳이 갈린다.
          box: {
            rect: objectBBox(picked[0]),
            rot: picked[0].rot,
            anchor: objectAnchor(picked[0]),
          },
          handles: true,
        },
      ]
    : picked.map((o) => ({
        // 다중·컨테이너에는 핸들이 없다 — 일괄 리사이즈는 만들지 않았는데 핸들이 보이면
        // 그게 된다고 약속하는 셈이다.
        box: { rect: objectAABB(o), rot: 0, anchor: { x: 0, y: 0 } },
        handles: false,
      }));
  const unionBox = picked.length
    ? unionRect(picked.map((o) => objectAABB(o)))
    : s.selectedIds.length
      ? selectBox(s.scene, s.selectedIds).rect
      : null;

  // 이미 선택된 것에는 호버 상자를 겹치지 않는다 — 같은 자리에 파란 선이 두 겹 그어진다.
  const hover = (() => {
    const id = ui.hoverId;
    if (!id || selSet.has(id)) return null;
    const leaf = s.scene.nodes.find((o) => o.id === id);
    if (leaf) return objectAABB(leaf);
    // 컨테이너는 기하가 없다 — `hitTest` 가 최상위 조상을 돌려주므로 그룹 호버가 여기로 온다.
    const b = selectBox(s.scene, [id]).rect;
    return b.w > 0 || b.h > 0 ? b : null;
  })();

  const drag = f.drag;
  // 노드 마퀴(47)도 같은 슬롯을 쓴다 — 정점을 고르는 러버밴드가 객체 마퀴와 다른 그림이면
  // 사용자는 "지금 무엇이 잡히는가"를 두 벌로 배워야 한다.
  const marquee =
    drag?.mode === "marquee" || drag?.mode === "vmarquee"
      ? (() => {
          const r = marqueeRect(drag);
          return r.w >= MIN_DRAG || r.h >= MIN_DRAG ? r : null;
        })()
      : null;

  const hudDrag = dragHudText(drag, f.draft, f.live);
  // 크기 0 인 합집합(빈 그룹)에는 뱃지를 달지 않는다 — `0 × 0` 은 정보가 아니다.
  const hudSel = unionBox && (unionBox.w > 0 || unionBox.h > 0) ? unionBox : null;
  const hudBox = hudDrag?.box ?? hudSel;
  const hud =
    hudDrag || hudSel
      ? {
          text:
            hudDrag?.text ?? `${Math.round(hudSel!.w)} × ${Math.round(hudSel!.h)}`,
          // 뱃지는 상자 **아래 중앙**에 붙는다(오버레이가 6css 내리고 stage 안으로 접는다).
          at: { x: hudBox!.x + hudBox!.w / 2, y: hudBox!.y + hudBox!.h },
        }
      : null;

  const cropRect = f.crop !== undefined ? f.crop : s.cropRect;

  // 간격 뱃지도 측정선과 같은 요소다 — 값만 다르고 그리는 규칙이 같다.
  const measures: Measure[] = [...(f.measures ?? [])];
  for (const g of f.snap?.gaps ?? []) {
    measures.push({
      from: g.axis === "x" ? { x: g.a, y: g.at } : { x: g.at, y: g.a },
      to: g.axis === "x" ? { x: g.b, y: g.at } : { x: g.at, y: g.b },
      label: String(Math.round(g.value)),
      kind: "gap",
    });
  }

  // 픽셀 스냅이 켜져 있으면 포인터 아래 셀 하나를 표시한다(시안 ⑦ `Snap Cell`) —
  // 그 배율에서는 "어느 픽셀에 붙는가"가 눈으로 보여야 1px 단위 작업이 가능하다.
  const extra: ChromeState["extra"] = [];
  if (t.snapPixel && s.screen.scale >= 4 && f.pt) {
    extra.push({
      k: "rect",
      x: Math.floor(f.pt.x),
      y: Math.floor(f.pt.y),
      w: 1,
      h: 1,
      color: CHROME_COLORS.smart,
    });
  }
  if (drag?.mode === "measure") {
    // 측정 도구의 러버밴드 — 아직 객체가 아니라 크롬이다(둘째 클릭 전에는 문서에 없다).
    extra.push({
      k: "line",
      x1: drag.a.x,
      y1: drag.a.y,
      x2: drag.cur.x,
      y2: drag.cur.y,
      color: CHROME_COLORS.smart,
    });
  }

  // 노드 편집·펜 크롬(47 §3.5) — 스크림·골격선·앵커·핸들·HUD·러버밴드가 전부 여기서 나온다.
  // **캔버스에는 한 획도 그리지 않는다**: 확대하면 디테일 캔버스(40)가 위를 덮어, 노드를
  // 편집하려고 확대한 바로 그 순간 크롬이 사라진다. 위에 이미 담긴 것들(픽셀 스냅 셀·측정선)과
  // ImageEditor 가 합류시키는 45 그라디언트 핸들을 지우지 않도록 **덧붙이기만** 한다.
  // 드래그 중에는 **라이브 객체**를 본다 — 커밋 전 문서를 보면 앵커·핸들·스크림 구멍이
  // 손가락을 안 따라오고, 놓는 순간 한 번에 튄다.
  const editedDoc = editedPath(s.objects, ui.mode);
  const editedLive = editedDoc ? byId.get(editedDoc.id) : undefined;
  const edited =
    editedLive && editedLive.kind === "path" ? editedLive : editedDoc;
  if (edited) {
    extra.push(
      ...nodeChrome(
        edited,
        nodeEditState(edited, f.nodeSel, f.pen),
        { scale: s.screen.scale },
        // 시안 ③ 아트보드 라벨. 파일명은 이 컴포넌트가 모른다 — 레이어 이름이 컨텍스트 바·
        // 레이어 패널과 같은 이름이라 그쪽을 쓴다.
        { label: `${edited.name ?? defaultLayerName(edited, s.objects)} · 벡터 레이어 편집 중` },
      ),
    );
  }
  // 펜 프리뷰는 드래프트가 없어도 낸다(도구를 막 집었을 때의 커서 힌트) — 대신 도구가 펜일
  // 때만이다. 다른 도구에서 뜨면 커서를 따라다니는 뱃지가 정작 그리는 선을 가린다.
  if (s.tool === "vpen") {
    extra.push(
      ...penPreview(f.pen, f.pt, {
        scale: s.screen.scale,
        tol: HANDLE_GRAB_CSS / Math.max(s.displayScale, 1e-6),
      }),
    );
  }

  return {
    screen: s.screen,
    selection,
    unionBox,
    hover,
    marquee,
    hud,
    crop:
      cropRect && cropRect.w > 0 && cropRect.h > 0
        ? {
            rect: cropRect,
            // 구도 격자는 **자르는 동안**만 뜬다. 확정된 크롭에 계속 남으면 그 선이 주석인지
            // 안내선인지 구분되지 않는다(48 이 세션 오버레이를 가져가면 그쪽 값이 이긴다).
            overlay: s.cropMode ? t.cropOverlay : "none",
            label: null,
            handles: false,
          }
        : null,
    // 끌고 있는 가이드는 **아직 문서에 없다**(커밋은 up 에서 한 번) — 라이브 값으로 덮지
    // 않으면 선이 원래 자리에 붙박인 채 포인터만 움직인다.
    guides: t.guidesVisible
      ? s.guides.map((g, i) => ({
          axis: g.axis,
          pos: drag?.mode === "guide" && drag.index === i ? drag.pos : g.pos,
          selected: i === f.guideSel,
        }))
      : [],
    smartGuides: f.snap?.lines ?? [],
    measures,
    rulers: t.rulers,
    pixelGrid: t.pixelGrid,
    extra,
  };
}



