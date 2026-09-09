// 크롭 세션 — 모드 진입부터 ⏎ 적용 · Esc 취소까지의 라이브 상태 한 곳(48 §3.1).
//
// 이 훅이 지키는 규칙은 하나다: **세션 중에는 히스토리에 아무것도 쌓지 않는다.** 핸들·비율·
// 직선화·회전을 몇 번 만지든 문서 갱신은 전부 `applyDoc(..., "replace")`(스택 무변경)이고,
// 적용할 때만 진입 시점 스냅샷(`base`)으로 되돌린 뒤 최종 문서를 **커밋 1회** 한다. 그래야
// undo 한 번이 세션 전체를 되돌린다 — 틱마다 커밋하면 직선화 슬라이더를 한 번 끄는 것으로
// 되돌리기 200칸(41 상한)이 통째로 소진되고, 그 앞의 편집이 되돌릴 수 없게 밀려난다.
//
// 주석 좌표는 **항상 `origin` 에서 다시 계산**한다(누적 델타 금지, 00-INDEX §10.4). 슬라이더를
// 0 → 10 → 0 으로 왕복하면 회전 행렬이 두 번 곱해져 float 찌꺼기가 남는데, origin 기준이면
// 각이 제자리로 온 순간 `straightenObjects` 가 입력 배열을 **그대로** 돌려줘 값이 정확히 같다.
// 세션 안 회전/반전만 그 origin 을 다시 굳힌다(§3.5) — base 는 끝까지 그대로라 취소가 회전까지
// 되돌린다.
//
// 배경: DOCS/task/48-image-crop-straighten.md §3.1·§3.2·§3.4·§3.5

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  aspectRatioOf,
  autoTrimRect,
  cropBounds,
  cropLabel,
  fitAspect,
  maxStraightenFor,
  straightenObjects,
  straightenedSize,
  type CropSession,
} from "../../lib/annotate/crop";
import {
  normalizeRect,
  objectAABB,
  transformObjects,
  transformPoint,
  type OrientDelta,
} from "../../lib/annotate/geometry";
import { resolveScene } from "../../lib/annotate/scene";
import { childrenOf, isContainer, remove as removeNodes } from "../../lib/annotate/tree";
import type { EditorDoc, Node, ObjId, Rect } from "../../lib/annotate/types";
import { useImageEditorUi, type EditorUiState } from "../../stores/imageEditor";
import { useUi } from "../../stores/ui";

/** 이 각을 넘으면 `constrainToImage` 를 강제로 켠다 — 투명 모서리가 저장 파일에 남는다(§3.6). */
const FORCE_CONSTRAIN_DEG = 15;

export interface CropApi {
  /** 크롭 모드 진입. 이미 세션이 있으면 아무 일도 안 한다(모드 effect 가 여러 번 부른다). */
  enter(): void;
  cropSet(patch: Partial<CropSession>): void;
  /** 세션 안 회전/반전. `delta` 는 **화면 기준** 방향이다(`rotateBy` 와 같은 규약). */
  cropTransform(delta: OrientDelta): void;
  cropAutoTrim(): void;
  cropApply(): void;
  cropCancel(): void;
  getCropSession(): CropSession | null;
}

export interface CropSessionDeps {
  /** 최신 문서 미러(ImageEditor `docRef`). 콜백이 렌더 값을 굳히지 않으려고 ref 로 받는다. */
  docRef: { current: EditorDoc };
  applyDoc(next: EditorDoc, mode?: "commit" | "replace", label?: string): void;
  /** 현재 방향 캔버스 — 여백 자동 제거만 픽셀을 읽는다(크기 계산은 전부 산술이다). */
  oriented: HTMLCanvasElement | null;
  img: HTMLImageElement | null;
  ui: EditorUiState;
}

interface SessionRef {
  /** 진입 시점 문서 — 취소·적용이 되돌아갈 자리. 세션 내내 바뀌지 않는다. */
  base: EditorDoc;
  /** 직선화 재계산의 기준. 세션 안 회전/반전이 여기를 다시 굳힌다(§3.5). */
  origin: EditorDoc;
  /**
   * 이 세션이 마지막으로 문서에 써 넣은 값. **되돌리기 전에 이것이 아직 그 자리인지 본다** —
   * 세션 중에 다른 이미지가 열리면(`path` 변경 → 문서·모드 초기화) `base` 는 이미 남의 문서를
   * 가리키고, 그대로 복원하면 방금 연 이미지 위에 옛 주석이 얹힌 채 자동저장까지 나간다.
   */
  applied: EditorDoc;
  session: CropSession;
}

type Size = { w: number; h: number };

/**
 * 그 문서·각도에서의 oriented 캔버스 크기.
 *
 * 캔버스(`buildOriented`)는 문서가 바뀐 **다음 렌더**에 만들어진다 — 그 값을 기다리면 같은 틱에
 * 사각형을 클램프할 수 없어 한 프레임 동안 상자가 경계 밖에 뜬다. 그래서 숫자로 먼저 안다.
 */
function orientedSizeFor(doc: EditorDoc, nat: Size, deg: number): Size {
  const swap = doc.rotation % 180 !== 0;
  return straightenedSize(swap ? nat.h : nat.w, swap ? nat.w : nat.h, deg);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function sameCrop(a: Rect | null, b: Rect | null): boolean {
  return a === null || b === null ? a === b : sameRect(a, b);
}

/**
 * 크롭 사각형과 겹치지 않는 **씬 리프**를 지운다(`deleteOutside`).
 *
 * 씬(`resolveScene`)을 도는 것은 "보이는 것만 지운다"는 뜻이다 — 숨긴 노드는 씬에 없어 남는다.
 * 정확한 교차 판정보다 이쪽이 예측 가능하다(사용자는 화면에 없는 것이 지워진 줄 모른다).
 */
function pruneOutside(doc: EditorDoc, rect: Rect): Node[] {
  const dead: ObjId[] = [];
  for (const n of resolveScene(doc).nodes) {
    const a = objectAABB(n);
    const hit =
      a.x < rect.x + rect.w &&
      rect.x < a.x + a.w &&
      a.y < rect.y + rect.h &&
      rect.y < a.y + a.h;
    if (!hit) dead.push(n.id);
  }
  if (!dead.length) return doc.objects;
  let out = removeNodes(doc.objects, dead);
  // 자손이 통째로 지워진 그룹은 빈 껍데기로 남는다. 중첩 그룹은 안쪽이 먼저 비어야 바깥이
  // 비므로 한 번으로는 안 걷힌다 — 걷을 것이 없을 때까지 돈다(깊이만큼, 보통 1회).
  for (;;) {
    const empty = out
      .filter((o) => isContainer(o) && childrenOf(out, o.id).length === 0)
      .map((o) => o.id);
    if (!empty.length) return out;
    out = removeNodes(out, empty);
  }
}

/**
 * 패치 하나를 세션에 반영한 결과 — 새 세션과, 필요하면 새 라이브 문서.
 *
 * `live` 가 null 이면 문서를 건드릴 이유가 없다는 뜻이다(비율·오버레이·사각형만 바뀐 경우).
 * 그때도 `applyDoc` 을 부르면 4K oriented 캔버스가 통째로 다시 만들어진다.
 */
function derive(
  st: SessionRef,
  patch: Partial<CropSession>,
  nat: Size,
): { session: CropSession; live: EditorDoc | null } {
  const prev = st.session;
  const org = st.origin;
  const lim = maxStraightenFor(nat.w, nat.h);
  // 0.1° 격자 + 화소 상한. 캔버스 크기와 좌표 계산이 **같은 각**을 봐야 한다 —
  // 여기서 안 자르면 `buildOriented` 안의 클램프만 걸려 이미지와 주석이 다른 각으로 돈다.
  const raw = patch.straighten ?? prev.straighten;
  const straighten = Math.max(-lim, Math.min(lim, Math.round(raw * 10) / 10));
  const next: CropSession = {
    ...prev,
    ...patch,
    straighten,
    constrainToImage:
      Math.abs(straighten) > FORCE_CONSTRAIN_DEG
        ? true
        : (patch.constrainToImage ?? prev.constrainToImage),
    rect: prev.rect,
  };

  const turned = straighten !== prev.straighten;
  const sizePrev = orientedSizeFor(org, nat, prev.straighten);
  const sizeNext = orientedSizeFor(org, nat, straighten);
  let rect = patch.rect ?? prev.rect;
  if (turned) {
    // 캔버스가 회전 bbox 만큼 커지므로 사각형도 중심 차만큼 따라간다. 안 옮기면 각도를 만질
    // 때마다 상자가 이미지 왼쪽 위로 밀려 사용자가 잡아 둔 구도가 조금씩 어긋난다.
    rect = {
      ...rect,
      x: rect.x + (sizeNext.w - sizePrev.w) / 2,
      y: rect.y + (sizeNext.h - sizePrev.h) / 2,
    };
  }
  const bounds = cropBounds(next, nat.w, nat.h, org.rotation, sizeNext);
  next.rect = fitAspect(
    rect,
    aspectRatioOf(next.aspect, nat.w, nat.h, org.rotation),
    bounds,
  );

  const live = turned
    ? {
        ...org,
        straighten,
        objects: straightenObjects(
          org.objects,
          org.straighten,
          straighten,
          orientedSizeFor(org, nat, org.straighten),
          sizeNext,
          org.flipH !== org.flipV,
        ),
      }
    : null;
  return { session: next, live };
}

export function useCropSession(deps: CropSessionDeps): {
  session: CropSession | null;
  api: CropApi;
} {
  const [session, setSession] = useState<CropSession | null>(null);
  const ref = useRef<SessionRef | null>(null);
  // `deps` 는 매 렌더 새 객체다 — 콜백 의존성에 넣으면 api 가 프레임마다 갈려 컨텍스트 바·
  // 인스펙터가 통째로 다시 그려진다. 최신 값은 ref 하나로 본다(useEditorKeys 와 같은 관례).
  const d = useRef(deps);
  d.current = deps;
  const pushToast = useUi((s) => s.pushToast);

  // 모드는 **스토어에서 직접** 구독한다. `deps.ui` 는 호출자가 다시 그릴 때만 갱신되는
  // 스냅샷이라, 호출자가 mode 를 구독하지 않게 바뀌는 순간 크롭이 아예 열리지 않는다.
  const mode = useImageEditorUi((s) => s.mode);
  const img = deps.img;

  const enter = useCallback(() => {
    if (ref.current) return;
    const im = d.current.img;
    if (!im) return;
    const base = d.current.docRef.current;
    const nat = { w: im.naturalWidth, h: im.naturalHeight };
    const s0: CropSession = {
      // 진입 직후 8핸들이 바로 잡히도록 **전체**에서 시작한다(Figma·Lightroom 관례).
      rect: { x: 0, y: 0, w: 1, h: 1 },
      aspect: "free",
      overlay: d.current.ui.toggles.cropOverlay,
      straighten: base.straighten,
      constrainToImage: true,
      deleteOutside: false,
    };
    const size = orientedSizeFor(base, nat, s0.straighten);
    const bounds = cropBounds(s0, nat.w, nat.h, base.rotation, size);
    s0.rect = base.crop ? fitAspect(base.crop, null, bounds) : bounds;
    ref.current = { base, origin: base, applied: base, session: s0 };
    setSession(s0);
  }, []);

  /** 세션을 버리고 문서를 진입 시점으로 되돌린다. 모드는 건드리지 않는다(부른 쪽이 정한다). */
  const discard = useCallback(() => {
    const st = ref.current;
    if (!st) return;
    ref.current = null;
    setSession(null);
    // 41 자동저장 flush 는 `docRef` 를 읽는다 — 되돌리기 전에 창이 닫히면 세션 중간 문서가
    // 사이드카에 남아, 다음에 열었을 때 적용한 적 없는 직선화가 걸린 채로 뜬다.
    // 우리가 쓴 값이 아직 그 자리일 때만 되돌린다(`applied` 주석).
    if (st.applied !== st.base && d.current.docRef.current === st.applied) {
      d.current.applyDoc(st.base, "replace");
    }
  }, []);

  const cropSet = useCallback((patch: Partial<CropSession>) => {
    const st = ref.current;
    const im = d.current.img;
    if (!st || !im) return;
    const { session: next, live } = derive(st, patch, {
      w: im.naturalWidth,
      h: im.naturalHeight,
    });
    // 오버레이만 세션 밖으로 기억한다(§3.7) — 비율은 매번 '자유'로 시작하는 편이 안전하다.
    if (patch.overlay && patch.overlay !== st.session.overlay) {
      d.current.ui.setToggle("cropOverlay", patch.overlay);
    }
    st.session = next;
    if (live) {
      d.current.applyDoc(live, "replace");
      st.applied = live;
    }
    setSession(next);
  }, []);

  const cropTransform = useCallback((delta: OrientDelta) => {
    const st = ref.current;
    const im = d.current.img;
    if (!st || !im) return;
    const nat = { w: im.naturalWidth, h: im.naturalHeight };
    const doc = d.current.docRef.current;
    const size = orientedSizeFor(doc, nat, st.session.straighten);
    // 반전이 홀수 개면 화면에서 보이는 회전 방향이 좌표 회전과 반대다(`rotateBy` 실측 규칙).
    // 여기서 뒤집지 않으면 반전된 이미지에서 버튼과 반대로 돈다.
    const mirrored = doc.flipH !== doc.flipV;
    const spin = delta === "rotCW" || delta === "rotCCW";
    const objDelta: OrientDelta = !spin
      ? delta
      : (delta === "rotCW") !== mirrored
        ? "rotCW"
        : "rotCCW";
    const next: EditorDoc = {
      ...doc,
      objects: transformObjects(doc.objects, objDelta, size.w, size.h),
      rotation: spin ? (doc.rotation + (delta === "rotCW" ? 90 : 270)) % 360 : doc.rotation,
      flipH: delta === "flipH" ? !doc.flipH : doc.flipH,
      flipV: delta === "flipV" ? !doc.flipV : doc.flipV,
    };
    const a = transformPoint(st.session.rect.x, st.session.rect.y, objDelta, size.w, size.h);
    const b = transformPoint(
      st.session.rect.x + st.session.rect.w,
      st.session.rect.y + st.session.rect.h,
      objDelta,
      size.w,
      size.h,
    );
    // 회전은 origin 을 다시 굳힌다 — 이후 직선화가 base 에서 다시 계산되면 방금 건 회전이
    // 조용히 풀린다. base 는 그대로라 취소는 여전히 회전까지 되돌린다.
    st.origin = next;
    st.session = { ...st.session, rect: normalizeRect(a.x, a.y, b.x, b.y) };
    const { session: fitted } = derive(st, {}, nat);
    st.session = fitted;
    d.current.applyDoc(next, "replace");
    st.applied = next;
    setSession(fitted);
  }, []);

  const cropAutoTrim = useCallback(() => {
    const st = ref.current;
    const im = d.current.img;
    const canvas = d.current.oriented;
    if (!st || !im || !canvas) return;
    const bounds = cropBounds(
      st.session,
      im.naturalWidth,
      im.naturalHeight,
      d.current.docRef.current.rotation,
      { w: canvas.width, h: canvas.height },
    );
    const r = autoTrimRect(canvas, bounds);
    if (!r) {
      pushToast("info", "단색 여백을 찾지 못했습니다");
      return;
    }
    if (sameRect(r, bounds)) {
      pushToast("info", "제거할 여백이 없습니다");
      return;
    }
    cropSet({ rect: r });
  }, [cropSet, pushToast]);

  const cropApply = useCallback(() => {
    const st = ref.current;
    const im = d.current.img;
    if (!st) return;
    const setDesign = () => d.current.ui.setMode({ kind: "design" });
    if (!im) {
      discard();
      setDesign();
      return;
    }
    const nat = { w: im.naturalWidth, h: im.naturalHeight };
    const live = d.current.docRef.current;
    const s = st.session;
    const size = orientedSizeFor(live, nat, s.straighten);
    const objects = s.deleteOutside ? pruneOutside(live, s.rect) : live.objects;
    // 사각형이 캔버스 전체면 `crop` 을 **비운다** — 같은 영역을 crop 으로 적어 두면 이후 방향
    // 변경마다 낡은 사각형을 들고 다니게 된다(`rotateBy` 가 crop 을 지우는 이유와 같다).
    const whole = sameRect(s.rect, { x: 0, y: 0, w: size.w, h: size.h });
    const final: EditorDoc = whole
      ? { ...live, objects, crop: null, outW: size.w, outH: size.h }
      : { ...live, objects, crop: s.rect, outW: s.rect.w, outH: s.rect.h };

    const b = st.base;
    const unchanged =
      final.objects === b.objects &&
      final.straighten === b.straighten &&
      final.rotation === b.rotation &&
      final.flipH === b.flipH &&
      final.flipV === b.flipV &&
      final.outW === b.outW &&
      final.outH === b.outH &&
      sameCrop(final.crop, b.crop);

    // 세션 밖에서 문서가 바뀌었으면(다른 이미지 열기 등) base 로 되돌리는 순간 그 변경이
    // 사라진다 — 그때는 되돌리지 않고 지금 문서 위에 크롭만 얹는다.
    const stale = d.current.docRef.current !== st.applied;
    ref.current = null;
    setSession(null);
    if (unchanged) {
      // 아무것도 바뀌지 않았는데 커밋하면 되돌리기 목록에 빈 칸이 생긴다 — 사용자는 Ctrl+Z 를
      // 눌러 놓고 화면이 그대로인 것을 본다.
      if (!stale && d.current.docRef.current !== b) d.current.applyDoc(b, "replace");
    } else {
      // 커밋 **직전에** base 로 되돌려야 `past` 에 쌓이는 것이 세션 중간 문서가 아니라
      // 진입 시점 하나가 된다(undo 한 번 = 세션 전체).
      if (!stale) d.current.applyDoc(b, "replace");
      d.current.applyDoc(
        final,
        "commit",
        `크롭 ${Math.round(final.outW)}×${Math.round(final.outH)}`,
      );
    }
    setDesign();
  }, [discard]);

  const cropCancel = useCallback(() => {
    discard();
    d.current.ui.setMode({ kind: "design" });
  }, [discard]);

  const getCropSession = useCallback(() => ref.current?.session ?? null, []);

  // 모드 전이는 이 한 곳이다. 도구 키 등으로 모드가 밖에서 바뀌어도 같은 effect 가 세션을
  // 버려, "크롭 중 도구 키 = 조용히 해제"라는 현행 동작이 그대로 산다.
  useEffect(() => {
    if (mode.kind === "crop") enter();
    else discard();
  }, [mode.kind, img, enter, discard]);

  useEffect(() => {
    d.current.ui.setHint(session ? `크롭 ${cropLabel(session)}` : null);
  }, [session]);

  // 언마운트(창 닫기 포함)에도 라이브 문서를 남기지 않는다. 41 flush 가 그 뒤에 돈다.
  useEffect(
    () => () => {
      discard();
      d.current.ui.setHint(null);
    },
    [discard],
  );

  const api = useMemo<CropApi>(
    () => ({
      enter,
      cropSet,
      cropTransform,
      cropAutoTrim,
      cropApply,
      cropCancel,
      getCropSession,
    }),
    [enter, cropSet, cropTransform, cropAutoTrim, cropApply, cropCancel, getCropSession],
  );

  return { session, api };
}
