// 이미지 문서 모델 v2 의 **경계** 검증 — DOCS/task/37-image-doc-model-v2.md §7.
//
// 이 스위트가 지키는 계약 셋:
//   ① v1 리터럴(`{stroke, strokeWidth, fill, radius:number, head}`)이 경계를 지나면 완전한 v2
//      노드가 된다. 이게 성립해야 30·34·35 의 setDoc 리터럴 21건이 재작성 없이 산다.
//   ② 직렬화 왕복(serialize → parse)이 문서를 바꾸지 않는다. 태스크 41(사이드카 영속)이
//      이 성질 위에 서 있다 — 왕복이 값을 깎으면 "저장할 때마다 조금씩 달라지는 문서"가 된다.
//   ③ 상위 버전 문서와 모르는 노드는 **깎지 않는다**. 새 앱이 쓴 문서를 옛 앱이 열어
//      조용히 덜어낸 채 저장하는 사고를 막는다.
//
// 픽셀은 보지 않는다(그건 30 의 몫). 여기서는 문서 값만 본다.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name = "이미지 문서 모델 v2 (정규화 경계 / v1 업그레이드 / 직렬화 왕복 / 미지 노드 보존)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const RED_HEX = "#FF3B30";
const BLUE_HEX = "#0A84FF";

const HELPERS = `(() => {
  const A = {};
  window.__gpvSchema = A;

  // 42 이후 편집기 헤더에서 '이미지 편집' **문구**가 사라졌다 — 루트의 aria-label 이 1차
  // 근거다. 문구 조건은 옛 빌드를 위해 남겨 둔다(30·34·35 헬퍼와 같은 판정).
  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(
      (el) =>
        el.getAttribute('aria-label') === '이미지 편집' ||
        /이미지 편집/.test(el.textContent || ''),
    ) || null;

  A.ready = () => {
    const m = A.modal();
    if (!m) return false;
    const cs = Array.from(m.querySelectorAll('canvas'));
    return cs.length >= 2 && cs[1].width > 0;
  };

  A.ed = () => window.__gpv.imageEditor;
  A.doc = () => A.ed().getDoc();
  A.first = () => A.doc().objects[0];

  /** 스키마 함수를 부르되 throw 는 코드 문자열로 바꾼다(CDP 로는 예외가 안 넘어온다). */
  A.parse = (json) => {
    try {
      const out = A.ed().schema.parse(json);
      return { ok: true, foreign: out.env.foreign.length, warnings: out.warnings, doc: out.env.doc };
    } catch (e) {
      return { ok: false, code: e && e.code ? e.code : String(e && e.message) };
    }
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /** 깊은 동치 — 키 순서는 무시한다. */
  A.deepEq = (a, b) => {
    const norm = (v) => {
      if (Array.isArray(v)) return v.map(norm);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
        return out;
      }
      return v;
    };
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  };

  return true;
})()`;

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 문서 모델 v2", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-schema-src.png";
  const created = [SRC];

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

    const b64 = await cdp.eval(`window.__gpvSchema.solidPng(200, 200, '#ffffff')`);
    const seed = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: SRC,
      base64: b64,
      overwrite: true,
    });
    if (!r.check("픽스처 PNG(200×200 흰색) 생성", seed.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }

    await closeEditor();
    await sleep(200);
    // 사이드카에 남은 편집 문서를 먼저 지운다 — 태스크 41 자동 복원이 이 스위트의
    // "새로 연 편집기는 비어 있다" 전제를 깬다(직전 회차가 남긴 문서가 되살아난다).
    // (편집기가 닫혀 있어 __gpv.imageDocs 훅이 없다 — 커맨드를 직접 부른다.)
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    await cdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(SRC)}, ${J(fix.projectId)})`,
    );
    const ready = await poll(
      () => cdp.eval(`window.__gpvSchema.ready()`).catch(() => false),
      (v) => v === true,
    );
    if (!r.check("편집기 열림", ready === true, ready ? "" : "ready() 타임아웃")) return;

    const hasSchema = await cdp.eval(
      `!!(window.__gpv.imageEditor && window.__gpv.imageEditor.schema)`,
    );
    if (!r.check("스키마 훅 노출(__gpv.imageEditor.schema)", hasSchema === true)) return;

    // ── (a) v1 사각형 리터럴 → 완전한 v2 노드 ───────────────────────────────
    //
    // 30 스위트의 rectObj 와 **같은 리터럴**이다(strokeWidth 0 · fill 색). 경계가 이걸
    // 페인트 스택으로 옮기지 못하면 30 의 픽셀 단언이 통째로 흔들린다.
    await cdp.eval(`window.__gpvSchema.ed().setDoc({ objects: [{
      id: 'a', kind: 'rect', stroke: ${J(RED_HEX)}, strokeWidth: 0, opacity: 1, rot: 0,
      x: 40, y: 40, w: 120, h: 120, fill: ${J(RED_HEX)}, radius: 0 }] })`);
    const a = await cdp.eval(`(() => {
      const o = window.__gpvSchema.first();
      return {
        fills: o.fills.length, fillType: o.fills[0] && o.fills[0].type, fillColor: o.fills[0] && o.fills[0].color,
        fillVisible: o.fills[0] && o.fills[0].visible, fillBlend: o.fills[0] && o.fills[0].blend,
        strokes: o.strokes.length, strokeWidth: o.strokeWidth,
        parentId: o.parentId, visible: o.visible, locked: o.locked, name: o.name,
        blend: o.blend, radius: o.radius, effects: o.effects.length,
        constraints: o.constraints, mask: o.mask, exportRows: o.exportRows.length,
        keys: Object.keys(o).sort().join(','),
      };
    })()`);
    r.check(
      "(a-1) v1 rect 리터럴 → fills 1겹 단색 #FF3B30",
      a.fills === 1 && a.fillType === "solid" && a.fillColor === RED_HEX && a.fillVisible === true &&
        a.fillBlend === "normal",
      `fills=${a.fills} type=${a.fillType} color=${a.fillColor}`,
    );
    r.check(
      "(a-2) strokeWidth 0 → strokes 없음(v1 렌더와 동치 — 테두리를 그리지 않았다)",
      a.strokes === 0 && a.strokeWidth === 0,
      `strokes=${a.strokes} width=${a.strokeWidth}`,
    );
    r.check(
      "(a-3) 트리·표시 필드가 채워진다(parentId null · visible · locked · name null)",
      a.parentId === null && a.visible === true && a.locked === false && a.name === null,
      `parentId=${a.parentId} visible=${a.visible} locked=${a.locked} name=${a.name}`,
    );
    r.check(
      "(a-4) radius 숫자 → 4-tuple, blend normal, 스택 필드 초기화",
      J(a.radius) === J([0, 0, 0, 0]) && a.blend === "normal" && a.effects === 0 &&
        a.exportRows === 0 && a.mask === null && a.constraints.h === "left" && a.constraints.v === "top",
      `radius=${J(a.radius)} blend=${a.blend}`,
    );
    r.check(
      "(a-5) v1 전용 색 필드는 남지 않는다(fill/stroke 는 페인트 스택으로 이사)",
      !/(^|,)fill(,|$)/.test(a.keys) && !/(^|,)stroke(,|$)/.test(a.keys),
      `keys=${a.keys}`,
    );

    // ── (b) 형광펜 → multiply 블렌드가 **값**이 된다 ─────────────────────────
    await cdp.eval(`window.__gpvSchema.ed().setDoc({ objects: [{
      id: 'h', kind: 'highlight', stroke: '#FFCC00', strokeWidth: 16, opacity: 0.35, rot: 0,
      pts: [10, 10, 100, 100] }] })`);
    const b = await cdp.eval(`(() => {
      const o = window.__gpvSchema.first();
      return { blend: o.blend, opacity: o.opacity, strokes: o.strokes.length,
               color: o.strokes[0] && o.strokes[0].color, pts: o.pts.length };
    })()`);
    r.check(
      "(b) 형광펜: 렌더가 하드코딩하던 multiply 가 문서 값이 된다",
      b.blend === "multiply" && Math.abs(b.opacity - 0.35) < 1e-6 && b.strokes === 1 &&
        b.color === "#FFCC00" && b.pts === 4,
      `blend=${b.blend} opacity=${b.opacity} color=${b.color}`,
    );

    // ── (c) 화살표 head → heads ─────────────────────────────────────────────
    await cdp.eval(`window.__gpvSchema.ed().setDoc({ objects: [{
      id: 'r', kind: 'arrow', stroke: ${J(BLUE_HEX)}, strokeWidth: 4, opacity: 1, rot: 0,
      x1: 10, y1: 10, x2: 90, y2: 90, head: 'both' }] })`);
    const c = await cdp.eval(`(() => {
      const o = window.__gpvSchema.first();
      return { heads: o.heads, head: o.head };
    })()`);
    r.check(
      "(c) arrow head:'both' → heads {start:'arrow', end:'arrow'} (기하 필드도 남는다 — render shim)",
      c.heads.start === "arrow" && c.heads.end === "arrow" && c.head === "both",
      `heads=${J(c.heads)} head=${c.head}`,
    );

    // ── (d) 직렬화 왕복 — 풍부한 v2 문서 ────────────────────────────────────
    //
    // 그라디언트 스톱·효과·패스 핸들·프레임·그룹·텍스트 features 까지 넣는다. 왕복이 이걸
    // 하나라도 깎으면 41 의 자동저장이 "열 때마다 조금씩 잃는 문서"가 된다.
    const rich = {
      objects: [
        { id: "g1", kind: "group", name: "주석 레이어", parentId: null },
        {
          id: "n1", kind: "rect", parentId: "g1", x: 10, y: 10, w: 50, h: 50,
          radius: [8, 8, 8, 8],
          fills: [
            { type: "linear", stops: [{ pos: 0, color: RED_HEX, opacity: 1 }, { pos: 1, color: BLUE_HEX, opacity: 0.5 }],
              angle: 135, scale: 1, visible: true, blend: "multiply" },
          ],
          strokes: [{ type: "solid", color: BLUE_HEX, opacity: 1, visible: true, blend: "normal" }],
          strokeWidth: 2, strokeAlign: "inside", dash: [8, 4],
          effects: [
            { type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#000000", opacity: 0.25, visible: true },
            { type: "layer-blur", radius: 4, visible: true },
          ],
          exportRows: [{ scale: 2, suffix: "@2x", format: "webp", quality: 0.9 }],
          mask: { mode: "alpha", invert: true },
        },
        {
          id: "n2", kind: "path", parentId: "g1", fillRule: "evenodd",
          subpaths: [{ closed: true, verts: [
            { x: 0, y: 0, inX: -60, inY: -80, outX: 60, outY: 80, mode: "asymmetric" },
            { x: 100, y: 100, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" },
          ] }],
        },
        { id: "f1", kind: "frame", parentId: null, x: 0, y: 0, w: 200, h: 100, radius: [0, 0, 0, 0], clipsContent: true },
        {
          id: "t1", kind: "text", parentId: "f1", x: 5, y: 5, w: 100, h: 20, text: "측정값 오차 ±0.2mm",
          fontSize: 14, lineHeight: 150, letterSpacing: -0.2, align: "center", underline: true,
          truncateLines: 2, features: { liga: true, onum: true, tnum: false, frac: false },
        },
      ],
      guides: [{ axis: "x", pos: 120 }],
      straighten: 1.4,
    };
    await cdp.eval(`window.__gpvSchema.ed().setDoc(${J(rich)})`);
    const rt = await cdp.eval(`window.__gpvSchema.ed().roundTrip()`);
    r.check(
      "(d-1) serialize → parse 왕복이 문서를 바꾸지 않는다(그라디언트·효과·패스·프레임·텍스트)",
      rt === true,
      `roundTrip=${J(rt)}`,
    );
    const kept = await cdp.eval(`(() => {
      const d = window.__gpvSchema.doc();
      const n1 = d.objects.find((o) => o.id === 'n1');
      const n2 = d.objects.find((o) => o.id === 'n2');
      const t1 = d.objects.find((o) => o.id === 't1');
      return {
        count: d.objects.length,
        gradStops: n1.fills[0].stops.length, angle: n1.fills[0].angle, fillBlend: n1.fills[0].blend,
        dash: n1.dash, align: n1.strokeAlign, effects: n1.effects.length,
        mask: n1.mask, exportFormat: n1.exportRows[0].format,
        vertMode: n2.subpaths[0].verts[0].mode, inX: n2.subpaths[0].verts[0].inX, rule: n2.fillRule,
        lineHeight: t1.lineHeight, letterSpacing: t1.letterSpacing, onum: t1.features.onum,
        truncate: t1.truncateLines, straighten: d.straighten, guides: d.guides.length, v: d.v,
      };
    })()`);
    r.check(
      "(d-2) 값이 실제로 남아 있다 — 그라디언트 스톱 2 · 각도 135 · 대시 · 효과 2 · 마스크",
      kept.gradStops === 2 && kept.angle === 135 && kept.fillBlend === "multiply" &&
        J(kept.dash) === J([8, 4]) && kept.align === "inside" && kept.effects === 2 &&
        kept.mask.mode === "alpha" && kept.mask.invert === true && kept.exportFormat === "webp",
      `stops=${kept.gradStops} angle=${kept.angle} dash=${J(kept.dash)} effects=${kept.effects}`,
    );
    r.check(
      "(d-3) 패스 상대 핸들·짝수-홀수 규칙과 텍스트 타이포가 보존된다",
      kept.vertMode === "asymmetric" && kept.inX === -60 && kept.rule === "evenodd" &&
        kept.lineHeight === 150 && Math.abs(kept.letterSpacing + 0.2) < 1e-9 &&
        kept.onum === true && kept.truncate === 2,
      `vert=${kept.vertMode} inX=${kept.inX} lh=${kept.lineHeight} onum=${kept.onum}`,
    );
    r.check(
      "(d-4) 문서 수준 값(v · guides · straighten)도 왕복한다",
      kept.v === 2 && kept.guides === 1 && Math.abs(kept.straighten - 1.4) < 1e-9 && kept.count === 5,
      `v=${kept.v} guides=${kept.guides} straighten=${kept.straighten} count=${kept.count}`,
    );

    // ── (e) 상위 버전은 읽지 않는다 ─────────────────────────────────────────
    const e = await cdp.eval(
      `window.__gpvSchema.parse(${J(JSON.stringify({ v: 3, doc: { objects: [] } }))})`,
    );
    r.check(
      "(e) v=3 문서 → UNSUPPORTED_VERSION throw (덮어쓰기 사고 차단)",
      e.ok === false && e.code === "UNSUPPORTED_VERSION",
      `ok=${e.ok} code=${e.code}`,
    );

    // ── (f) 모르는 노드는 보존한다 ──────────────────────────────────────────
    const withForeign = JSON.stringify({
      v: 2,
      projectId: "p",
      relPath: "x.png",
      doc: {
        v: 2,
        objects: [
          { id: "k1", kind: "rect", parentId: null, x: 0, y: 0, w: 10, h: 10 },
          { id: "u1", kind: "future-widget", parentId: null, secret: 42 },
          { id: "u2", kind: "rect", parentId: "u1", x: 0, y: 0, w: 5, h: 5 },
        ],
      },
      foreign: [],
      log: [],
    });
    const f = await cdp.eval(`window.__gpvSchema.parse(${J(withForeign)})`);
    r.check(
      "(f-1) 미지 kind 는 서브트리째 foreign 으로 빠지고 알려진 노드만 남는다",
      f.ok === true && f.foreign === 2 && f.doc.objects.length === 1 && f.doc.objects[0].id === "k1",
      `foreign=${f.foreign} objects=${f.ok ? f.doc.objects.length : "-"}`,
    );
    const reser = await cdp.eval(`(() => {
      const p = window.__gpv.imageEditor.schema.parse(${J(withForeign)});
      const again = window.__gpv.imageEditor.schema.parse(
        window.__gpv.imageEditor.schema.serialize(p.env),
      );
      return { foreign: again.env.foreign.length, kinds: again.env.foreign.map((n) => n && n.kind).sort().join(',') };
    })()`);
    r.check(
      "(f-2) 재직렬화해도 원문이 그대로 되나온다(옛 앱이 새 문서를 깎지 않는다)",
      reser.foreign === 2 && reser.kinds === "future-widget,rect",
      `foreign=${reser.foreign} kinds=${reser.kinds}`,
    );

    // ── (g) 빈 문서 = EMPTY_DOC ─────────────────────────────────────────────
    const g = await cdp.eval(`(() => {
      const s = window.__gpv.imageEditor.schema;
      return window.__gpvSchema.deepEq(s.normalizeDoc({}), s.emptyDoc());
    })()`);
    r.check("(g) normalizeDoc({}) 가 EMPTY_DOC 과 깊은 동치", g === true, `deepEq=${g}`);

    // ── (h) 문서 색상 — 등장 순서·중복 제거 ─────────────────────────────────
    const h = await cdp.eval(`(() => {
      const s = window.__gpv.imageEditor.schema;
      const doc = s.normalizeDoc({ objects: [
        { id: 'x1', kind: 'rect', stroke: ${J(RED_HEX)}, strokeWidth: 2, opacity: 1, rot: 0,
          x: 0, y: 0, w: 1, h: 1, fill: ${J(BLUE_HEX)}, radius: 0 },
        { id: 'x2', kind: 'rect', stroke: ${J(RED_HEX)}, strokeWidth: 2, opacity: 1, rot: 0,
          x: 0, y: 0, w: 1, h: 1, fill: '#34C759', radius: 0 },
      ] });
      return s.documentColors(doc);
    })()`);
    r.check(
      "(h) documentColors: 등장 순서 유지 · 중복 제거",
      J(h) === J([BLUE_HEX, RED_HEX, "#34C759"]),
      `colors=${J(h)}`,
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
