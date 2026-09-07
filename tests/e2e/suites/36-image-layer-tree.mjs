// 이미지 문서의 **트리**와 **씬 해석** 검증 — DOCS/task/38-image-tree-scene-geometry.md §7.
//
// 이 스위트가 지키는 계약 셋:
//   ① 그룹/해제/순서/부모 바꾸기가 **서브트리 슬라이스**로 움직인다. 자손이 부모를 두고
//      흩어지면 나중에 "가끔 그룹이 풀린다"로만 드러나므로 여기서 불변식으로 잡는다.
//   ② 숨김은 프리뷰·저장·히트 **세 곳에서 동시에** 사라진다. 셋이 각자 판정하면 언젠가
//      "화면엔 없는데 파일엔 있는" 노드가 생긴다(pro 설계 §8.2 가 레이어 패널을 기각한 이유).
//   ③ 잠금은 히트만 막고 렌더는 그대로다. 마스크는 같은 부모의 뒤 형제 전부를 가린다.
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 다(30 스위트와 같은 전제).
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name = "이미지 레이어 트리 (그룹·순서·부모 / 숨김·잠금 3곳 일치 / 마스크 범위)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const RED = [255, 59, 48];
const RED_HEX = "#FF3B30";

const HELPERS = `(() => {
  const A = {};
  window.__gpvTree = A;

  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find((el) =>
      /이미지 편집/.test(el.textContent || ''),
    ) || null;

  A.canvases = () => {
    const m = A.modal();
    return m ? Array.from(m.querySelectorAll('canvas')) : [];
  };

  A.ready = () => {
    const cs = A.canvases();
    return cs.length >= 2 && cs[1].width > 0;
  };

  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  A.ed = () => window.__gpv.imageEditor;
  A.doc = () => A.ed().getDoc();
  A.ids = () => A.doc().objects.map((o) => o.id);
  A.parents = () => A.doc().objects.map((o) => [o.id, o.parentId]);

  /** 주석 캔버스(백킹 px) 한 점. */
  A.px = async (x, y) => {
    await A.frame();
    const c = A.canvases()[1];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  /** 캔버스 좌표를 client 좌표로(합성 포인터용). */
  A.toClient = (bx, by) => {
    const c = A.canvases()[1];
    const r = c.getBoundingClientRect();
    return { x: r.left + (bx / c.width) * r.width, y: r.top + (by / c.height) * r.height };
  };

  /** 클릭 한 번 — 선택 결과를 보려고 쓴다. */
  A.click = async (bx, by) => {
    const c = A.canvases()[1];
    if (!c) return false;
    const p = A.toClient(bx, by);
    const P = Element.prototype;
    const o = { s: P.setPointerCapture, r: P.releasePointerCapture, h: P.hasPointerCapture };
    P.setPointerCapture = function () {};
    P.releasePointerCapture = function () {};
    P.hasPointerCapture = function () { return true; };
    try {
      const mk = (t, btns) =>
        new PointerEvent(t, {
          bubbles: true, cancelable: true, composed: true,
          clientX: p.x, clientY: p.y, button: 0, buttons: btns,
          pointerId: 3100, pointerType: 'mouse', isPrimary: true,
        });
      c.dispatchEvent(mk('pointerdown', 1));
      c.dispatchEvent(mk('pointerup', 0));
    } finally {
      P.setPointerCapture = o.s;
      P.releasePointerCapture = o.r;
      P.hasPointerCapture = o.h;
    }
    await A.frame();
    return true;
  };

  A.selCount = () => {
    const m = A.modal();
    if (!m) return -1;
    const t = m.textContent || '';
    const hit = /(\\d+)개 선택/.exec(t);
    return hit ? Number(hit[1]) : 0;
  };

  A.try = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return { ok: false, message: String(e && e.message) };
    }
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /** 저장 파일을 디코드해 한 점을 읽는다(숨김이 파일에도 없는지 확인). */
  A.readSaved = async (projectId, relPath, points) => {
    const res = await window.__TAURI__.core.invoke('read_file_base64', { projectId, relPath });
    const img = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error('decode fail'));
      im.src = 'data:' + res.mime + ';base64,' + res.base64;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return points.map((p) => {
      const d = ctx.getImageData(p[0], p[1], 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
  };

  return true;
})()`;

/** v1 리터럴(경계가 v2 로 채운다) — 30 스위트의 rectObj 와 같은 모양. */
const rect = (id, x, y, w, h, color) => ({
  id, kind: "rect", stroke: color, strokeWidth: 0, opacity: 1, rot: 0,
  x, y, w, h, fill: color, radius: 0,
});

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 레이어 트리", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-tree-src.png";
  const OUT = "e2e-tree-out.png";
  const created = [SRC, OUT];

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const b64 = await cdp.eval(`window.__gpvTree.solidPng(200, 200, '#ffffff')`);
    const seed = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: b64, overwrite: true,
    });
    if (!r.check("픽스처 PNG(200×200 흰색) 생성", seed.ok && existsSync(join(fix.repo, SRC)))) return;

    await closeEditor();
    await sleep(200);
    await cdp.eval(`window.__gpv.ui.getState().openImageEditor(${J(SRC)}, ${J(fix.projectId)})`);
    const ready = await poll(
      () => cdp.eval(`window.__gpvTree.ready()`).catch(() => false),
      (v) => v === true,
    );
    if (!r.check("편집기 열림", ready === true)) return;

    const hasTree = await cdp.eval(`!!(window.__gpv.imageEditor && window.__gpv.imageEditor.tree)`);
    if (!r.check("트리 훅 노출(__gpv.imageEditor.tree)", hasTree === true)) return;

    // ── (a) 그룹 · 해제 ─────────────────────────────────────────────────────
    await cdp.eval(`window.__gpvTree.ed().setDoc({ objects: ${J([
      rect("a", 10, 10, 30, 30, RED_HEX),
      rect("b", 60, 10, 30, 30, RED_HEX),
      rect("c", 110, 10, 30, 30, RED_HEX),
    ])} })`);
    const gid = await cdp.eval(`window.__gpvTree.ed().tree.group(['a','b'])`);
    const afterGroup = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      return {
        n: d.objects.length,
        ids: d.objects.map((o) => o.id),
        parents: d.objects.map((o) => o.parentId),
        kinds: d.objects.map((o) => o.kind),
      };
    })()`);
    r.check(
      "(a-1) group: 컨테이너가 생기고 자식이 **바로 뒤에 연속**으로 온다",
      afterGroup.n === 4 &&
        afterGroup.ids[afterGroup.ids.indexOf(gid) + 1] === "a" &&
        afterGroup.ids[afterGroup.ids.indexOf(gid) + 2] === "b" &&
        afterGroup.kinds[afterGroup.ids.indexOf(gid)] === "group",
      `ids=${J(afterGroup.ids)} kinds=${J(afterGroup.kinds)}`,
    );
    const parentsOf = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      const p = {};
      for (const o of d.objects) p[o.id] = o.parentId;
      return p;
    })()`);
    r.check(
      "(a-2) 자식 parentId 가 컨테이너를 가리키고, 밖의 노드는 그대로다",
      parentsOf.a === gid && parentsOf.b === gid && parentsOf.c === null,
      `a=${parentsOf.a} b=${parentsOf.b} c=${parentsOf.c}`,
    );
    const range = await cdp.eval(`window.__gpvTree.ed().tree.subtreeRange(${J(gid)})`);
    r.check(
      "(a-3) subtreeRange 가 슬라이스 하나다(자기 + 자손 2)",
      Array.isArray(range) && range[1] - range[0] === 3,
      `range=${J(range)}`,
    );
    await cdp.eval(`window.__gpvTree.ed().tree.ungroup(${J(gid)})`);
    const afterUngroup = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      return { n: d.objects.length, ids: d.objects.map((o) => o.id), parents: d.objects.map((o) => o.parentId) };
    })()`);
    r.check(
      "(a-4) ungroup 이 원복한다(컨테이너 삭제 · 자식 최상위 복귀)",
      afterUngroup.n === 3 && afterUngroup.parents.every((p) => p === null) &&
        J(afterUngroup.ids) === J(["a", "b", "c"]),
      `ids=${J(afterUngroup.ids)} parents=${J(afterUngroup.parents)}`,
    );

    // ── (b) 순서 · 부모 바꾸기 ──────────────────────────────────────────────
    const gid2 = await cdp.eval(`window.__gpvTree.ed().tree.group(['a','b'])`);
    await cdp.eval(`window.__gpvTree.ed().tree.reorder([${J(gid2)}], 'front')`);
    const afterFront = await cdp.eval(`window.__gpvTree.ids()`);
    r.check(
      "(b-1) reorder('front'): 컨테이너가 맨 뒤(=맨 위)로 가고 **자손이 함께** 따라간다",
      afterFront[afterFront.length - 3] === gid2 &&
        afterFront[afterFront.length - 2] === "a" &&
        afterFront[afterFront.length - 1] === "b",
      `ids=${J(afterFront)}`,
    );
    // 순환 차단은 **컨테이너**를 대상으로 해야 의미가 있다 — 리프는 애초에 자식을 못 담는다.
    // gid2 안에 다시 그룹을 만들어 "조상을 자기 자손 안으로" 넣어 본다.
    const inner = await cdp.eval(`window.__gpvTree.ed().tree.group(['a'])`);
    const cyc = await cdp.eval(
      `window.__gpvTree.try(() => window.__gpvTree.ed().tree.reparent([${J(gid2)}], ${J(inner)}, 0))`,
    );
    r.check(
      "(b-2) 조상을 자기 자손 컨테이너 안으로 reparent → throw(순환 차단)",
      cyc.ok === false && /순환|자손/.test(cyc.message || ""),
      `ok=${cyc.ok} msg=${cyc.message}`,
    );
    const leafTarget = await cdp.eval(
      `window.__gpvTree.try(() => window.__gpvTree.ed().tree.reparent(['c'], 'b', 0))`,
    );
    r.check(
      "(b-2b) 리프를 부모로 지정하면 거부한다(컨테이너만 자식을 담는다)",
      leafTarget.ok === false && /담을 수 없/.test(leafTarget.message || ""),
      `ok=${leafTarget.ok} msg=${leafTarget.message}`,
    );
    await cdp.eval(`window.__gpvTree.ed().tree.ungroup(${J(inner)})`);
    await cdp.eval(`window.__gpvTree.ed().tree.reparent(['c'], ${J(gid2)}, 0)`);
    const afterReparent = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      const p = {};
      for (const o of d.objects) p[o.id] = o.parentId;
      return { p, ids: d.objects.map((o) => o.id) };
    })()`);
    r.check(
      "(b-3) reparent 가 부모를 바꾸고 슬라이스 안으로 옮긴다",
      afterReparent.p.c === gid2 && afterReparent.ids.indexOf("c") > afterReparent.ids.indexOf(gid2),
      `ids=${J(afterReparent.ids)} c=${afterReparent.p.c}`,
    );

    // ── (c) 숨김 = 프리뷰 · 저장 · 히트 세 곳 동시 ──────────────────────────
    await cdp.eval(`window.__gpvTree.ed().setDoc({ objects: ${J([
      rect("v", 40, 40, 120, 120, RED_HEX),
    ])} })`);
    const shown = await cdp.eval(`window.__gpvTree.px(100, 100)`);
    r.check(
      "(c-1) 사전: 보이는 사각형이 프리뷰에 빨강",
      Math.abs(shown[0] - RED[0]) <= 4 && shown[3] > 200,
      `px=${J(shown)}`,
    );
    await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      window.__gpvTree.ed().setDoc({ objects: d.objects.map((o) => ({ ...o, visible: false })) });
    })()`);
    const hiddenPx = await cdp.eval(`window.__gpvTree.px(100, 100)`);
    const sceneAfterHide = await cdp.eval(`window.__gpvTree.ed().scene()`);
    r.check(
      "(c-2) 숨기면 프리뷰에서 사라지고 씬 노드 목록에서도 빠진다",
      hiddenPx[3] === 0 && sceneAfterHide.nodeIds.length === 0,
      `px=${J(hiddenPx)} nodeIds=${J(sceneAfterHide.nodeIds)}`,
    );
    await cdp.eval(`window.__gpvTree.click(100, 100)`);
    r.check(
      "(c-3) 숨긴 노드는 클릭으로도 안 잡힌다(히트 = 씬)",
      (await cdp.eval(`window.__gpvTree.doc().objects.length`)) === 1 &&
        (await cdp.eval(`window.__gpvTree.selCount()`)) === 0,
      `selCount=${await cdp.eval(`window.__gpvTree.selCount()`)}`,
    );

    // ── (d) 잠금은 히트만 막는다 ────────────────────────────────────────────
    await cdp.eval(`window.__gpvTree.ed().setDoc({ objects: ${J([
      { ...rect("lk", 40, 40, 120, 120, RED_HEX), locked: true },
    ])} })`);
    const lockedPx = await cdp.eval(`window.__gpvTree.px(100, 100)`);
    const sc = await cdp.eval(`window.__gpvTree.ed().scene()`);
    await cdp.eval(`window.__gpvTree.click(100, 100)`);
    const selAfterLock = await cdp.eval(`window.__gpvTree.selCount()`);
    r.check(
      "(d) 잠근 노드: 그림은 그대로, 클릭은 안 잡힘",
      Math.abs(lockedPx[0] - RED[0]) <= 4 && lockedPx[3] > 200 &&
        sc.lockedIds.includes("lk") && selAfterLock === 0,
      `px=${J(lockedPx)} locked=${J(sc.lockedIds)} sel=${selAfterLock}`,
    );

    // ── (e) 마스크 범위 = 같은 부모의 뒤 형제 전부 ──────────────────────────
    await cdp.eval(`window.__gpvTree.ed().setDoc({ objects: ${J([
      rect("m", 40, 40, 60, 60, RED_HEX),
      rect("t1", 40, 40, 120, 120, RED_HEX),
      rect("t2", 40, 120, 120, 40, RED_HEX),
    ])} })`);
    const maskId = await cdp.eval(`window.__gpvTree.ed().tree.makeMask(['m','t1','t2'])`);
    const scope = await cdp.eval(`window.__gpvTree.ed().tree.maskScope(${J(maskId)})`);
    const idsNow = await cdp.eval(`window.__gpvTree.ids()`);
    r.check(
      "(e-1) makeMask: 가장 아래 노드가 마스크가 되고 범위는 **뒤 형제 전부**",
      maskId === "m" && scope[1] - scope[0] === 2 &&
        idsNow.slice(scope[0], scope[1]).join(",") === "t1,t2",
      `maskId=${maskId} scope=${J(scope)} ids=${J(idsNow)}`,
    );
    const maskFlag = await cdp.eval(
      `(() => { const o = window.__gpvTree.doc().objects.find((x) => x.id === ${J(maskId)}); return o && o.mask; })()`,
    );
    const sceneMask = await cdp.eval(`window.__gpvTree.ed().scene()`);
    r.check(
      "(e-2) 마스크 컨테이너가 씬에 격리 대상으로 잡힌다",
      maskFlag && maskFlag.mode === "shape" && sceneMask.containers.length === 1,
      `mask=${J(maskFlag)} containers=${J(sceneMask.containers)}`,
    );

    // ── (f) 그룹 이동 = 자손 델타 동일 ──────────────────────────────────────
    await cdp.eval(`window.__gpvTree.ed().setDoc({ objects: ${J([
      rect("p1", 10, 10, 20, 20, RED_HEX),
      rect("p2", 50, 50, 20, 20, RED_HEX),
    ])} })`);
    const g3 = await cdp.eval(`window.__gpvTree.ed().tree.group(['p1','p2'])`);
    await cdp.eval(`window.__gpvTree.ed().tree.translate([${J(g3)}], 7, 11)`);
    const moved = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      const f = (id) => d.objects.find((o) => o.id === id);
      return { p1: [f('p1').x, f('p1').y], p2: [f('p2').x, f('p2').y] };
    })()`);
    r.check(
      "(f) 그룹 이동: 자손이 같은 델타로 움직인다",
      J(moved.p1) === J([17, 21]) && J(moved.p2) === J([57, 61]),
      `p1=${J(moved.p1)} p2=${J(moved.p2)}`,
    );

    // ── (g) 컨테이너 AABB = 자손 합집합(부풀지 않는다) ──────────────────────
    const box = await cdp.eval(`window.__gpvTree.ed().tree.nodeAABB(${J(g3)})`);
    r.check(
      "(g-1) 그룹 AABB 가 자손 합집합이다",
      Math.abs(box.x - 17) < 0.51 && Math.abs(box.y - 21) < 0.51 &&
        Math.abs(box.w - 60) < 1.01 && Math.abs(box.h - 60) < 1.01,
      `box=${J(box)}`,
    );
    await cdp.eval(`window.__gpvTree.ed().tree.rotate([${J(g3)}], 90, 47, 51)`);
    const rotated = await cdp.eval(`(() => {
      const d = window.__gpvTree.doc();
      const f = (id) => d.objects.find((o) => o.id === id);
      const g = d.objects.find((o) => o.kind === 'group');
      return { rot1: f('p1').rot, gRot: g.rot, box: window.__gpvTree.ed().tree.nodeAABB(g.id) };
    })()`);
    r.check(
      "(g-2) 회전은 **리프에 굽고** 그룹은 각도를 갖지 않는다",
      rotated.gRot === 0 && rotated.rot1 === 90,
      `groupRot=${rotated.gRot} leafRot=${rotated.rot1}`,
    );

    await closeEditor();
  } finally {
    await closeEditor().catch(() => {});
    for (const f of created) {
      const p = join(fix.repo, f);
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 픽스처 정리는 best-effort */
      }
    }
  }
}
