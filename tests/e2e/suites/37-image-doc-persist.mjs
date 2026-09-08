// 편집 문서 **사이드카 영속**과 히스토리 v2 — DOCS/task/41-image-doc-persist-history.md §7.
//
// 이 스위트가 지키는 계약 넷:
//   ① 닫아도 잃는 것이 없다. 자동저장이 앱 데이터에 남고 다시 열면 그대로 돌아온다.
//      그래서 v1 의 "주석이 남아 있습니다" 확인창이 통째로 사라졌다 — 물어볼 이유가 없어졌다.
//   ② **레포는 1바이트도 오염되지 않는다.** 사이드카를 레포에 두면 `git status` 가 매번
//      그걸 변경 목록에 올린다. 편집기를 켰다 껐다는 이유로 커밋 목록이 더러워지면 안 된다.
//   ③ 되살릴 수 없게 된 문서는 **버린다**: 제자리 평탄화(레이어가 픽셀에 구워짐)면 삭제,
//      원본이 바뀌었으면 낡은 crop 을 버린다. 낡은 crop 으로 저장하면 엉뚱한 영역이
//      잘려 나가고, 그건 조용한 데이터 손실이다.
//   ④ 히스토리는 라벨이 붙고 임의 시점으로 점프한다. 이전 세션 기록은 **읽기 전용**으로 남는다
//      (문서가 없으니 되돌릴 수 없다 — 목록만 보여 준다).
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 다(30·36 스위트와 같은 전제).
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 편집 문서 영속 (사이드카 자동저장·복원 / 레포 오염 0 / 평탄화 삭제 · 히스토리 라벨·점프·스냅샷 · 에셋 상한)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const HELPERS = `(() => {
  const A = {};
  window.__gpvPersist = A;

  // 42 이후 편집기 헤더에서 '이미지 편집' **문구**가 사라졌다 — 루트의 aria-label 이 1차
  // 근거다. 이 판정이 빗나가면 A.gone() 이 편집기가 열려 있어도 true 가 되어 '닫힘' 단언이
  // 거짓 통과한다(30·34·35 헬퍼와 같은 판정).
  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(
      (el) =>
        el.getAttribute('aria-label') === '이미지 편집' ||
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

  A.gone = () => A.modal() === null;

  A.ed = () => window.__gpv.imageEditor;
  A.doc = () => A.ed().getDoc();
  A.text = () => (A.modal() || {}).textContent || '';

  /** 편집기 안 버튼을 라벨로 누른다. */
  A.click = (re) => {
    const m = A.modal();
    if (!m) return false;
    const b = Array.from(m.querySelectorAll('button')).find((x) => re.test(x.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  };

  /** 확인창(ConfirmHost)을 스토어로 확정한다 — DOM 타이밍에 안 걸리게. */
  A.confirm = () => {
    const st = window.__gpv.ui.getState();
    const req = st.confirm;
    if (!req) return false;
    st.closeConfirm();
    req.onConfirm();
    return true;
  };

  /** '다른 이름으로 저장' — 34 스위트와 같은 방식(프롬프트 값은 스토어로 확정). */
  A.saveAs = async (fileName) => {
    if (!A.click(/다른 이름으로/)) return { ok: false, why: 'button' };
    await new Promise((r) => setTimeout(r, 150));
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt' };
    st.closePrompt();
    req.onConfirm(fileName);
    return { ok: true };
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  A.toasts = () => window.__gpv.ui.getState().toasts.map((t) => t.kind + ':' + t.message);
  A.clearToasts = () => {
    const st = window.__gpv.ui.getState();
    st.toasts.slice().forEach((t) => st.dismissToast(t.id));
    return true;
  };

  /**
   * 클립보드 붙여넣기를 합성한다 — 실제 클립보드는 CDP 로 못 채운다.
   * ClipboardEvent 는 파일이 담긴 DataTransfer 를 받는다(Chromium).
   */
  A.paste = async (bytes, mime, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    return true;
  };

  /** base64 → 바이트(합성 붙여넣기용). */
  A.bytesOf = (b64) => {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };

  return true;
})()`;

/** v1 리터럴 — 경계(normalizeDoc)가 v2 로 채운다. 36 스위트의 rect 와 같은 모양. */
const rect = (id, x, y, w, h) => ({
  id, kind: "rect", stroke: "#FF3B30", strokeWidth: 0, opacity: 1, rot: 0,
  x, y, w, h, fill: "#FF3B30", radius: 0,
});

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 편집 문서 영속", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-persist.png";
  const RENAMED = "e2e-persist-2.png";
  const OUT = "e2e-persist-out.png";
  const created = [SRC, RENAMED, OUT];

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
  const openEditor = async (rel = SRC) => {
    await cdp.eval(`window.__gpv.ui.getState().openImageEditor(${J(rel)}, ${J(fix.projectId)})`);
    return poll(() => cdp.eval(`window.__gpvPersist.ready()`).catch(() => false), (v) => v === true);
  };
  const readDoc = (rel = SRC) =>
    cdp.try("image_doc_read", { projectId: fix.projectId, relPath: rel, kind: "doc" });
  const dropDoc = (rel) => cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: rel });

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    await closeEditor();
    await sleep(200);
    for (const f of created) await dropDoc(f);

    const b64 = await cdp.eval(`window.__gpvPersist.solidPng(200, 200, '#ffffff')`);
    const seed = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: b64, overwrite: true,
    });
    if (!r.check("픽스처 PNG(200×200 흰색) 생성", seed.ok && existsSync(join(fix.repo, SRC)))) return;

    // ── (a) 자동저장 → 재오픈 복원 ───────────────────────────────────────────
    const repoBefore = readdirSync(fix.repo).sort().join("|");
    if (!r.check("편집기 열림", (await openEditor()) === true)) return;
    const hasHist = await cdp.eval(
      `!!(window.__gpv.imageEditor && window.__gpv.imageEditor.history)`,
    );
    if (!r.check("히스토리 훅 노출(__gpv.imageEditor.history)", hasHist === true)) return;

    r.check(
      "(a-0) 사이드카가 없으면 새 편집기는 비어 있다",
      (await cdp.eval(`window.__gpvPersist.doc().objects.length`)) === 0,
    );

    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([
      rect("p1", 10, 10, 40, 40),
      rect("p2", 80, 10, 40, 40),
    ])} })`);
    await cdp.eval(`window.__gpvPersist.ed().history.flush()`);

    // ── (b) 저장된 json 이 현재 문서와 같고, 레포는 그대로다 ──────────────────
    const saved = await readDoc();
    r.check(
      "(b-1) 사이드카에 문서가 쓰였다(json·stamp 존재)",
      saved.ok && typeof saved.r?.json === "string" && !!saved.r?.stamp,
      saved.ok ? `json=${typeof saved.r?.json} stamp=${saved.r?.stamp}` : saved.message,
    );
    const same = await cdp.eval(`(() => {
      const env = window.__gpvPersist.ed().schema.parse(${J(saved.r?.json ?? "")}).env;
      const key = (v) => JSON.stringify(v, (_k, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort()) : x);
      return {
        equal: key(env.doc) === key(window.__gpvPersist.doc()),
        rel: env.relPath,
        n: env.doc.objects.length,
        logs: env.log.length,
      };
    })()`);
    r.check(
      "(b-2) 저장된 문서 == 편집 중인 문서(직렬화 왕복 동치)",
      same.equal === true && same.n === 2 && same.rel === SRC,
      `equal=${same.equal} n=${same.n} rel=${same.rel}`,
    );
    r.check("(b-3) 히스토리 라벨 로그가 함께 저장된다", same.logs >= 2, `log=${same.logs}`);
    r.check(
      "(b-4) **레포 오염 0** — 편집·자동저장이 레포에 파일을 만들지 않는다",
      readdirSync(fix.repo).sort().join("|") === repoBefore,
    );

    await closeEditor();
    await sleep(300);
    if (!r.check("(a-1) 재오픈", (await openEditor()) === true)) return;
    const restored = await cdp.eval(`(() => {
      const h = window.__gpvPersist.ed().history.entries();
      return {
        n: window.__gpvPersist.doc().objects.length,
        ids: window.__gpvPersist.doc().objects.map((o) => o.id),
        top: h[0] && h[0].label,
        topReadonly: h[0] && h[0].readonly,
        priors: h.filter((e) => e.readonly).length,
      };
    })()`);
    r.check(
      "(a-2) 닫았다 열면 객체가 그대로 돌아온다(확인창 없이)",
      restored.n === 2 && J(restored.ids) === J(["p1", "p2"]),
      `n=${restored.n} ids=${J(restored.ids)}`,
    );
    r.check(
      "(a-3) 첫 항목은 '이미지 열기'이고 되돌릴 수 있다",
      restored.top === "이미지 열기" && restored.topReadonly === false,
      `top=${restored.top} readonly=${restored.topReadonly}`,
    );
    r.check(
      "(a-4) 이전 세션 기록은 **읽기 전용**으로 남는다",
      restored.priors >= 2,
      `readonly=${restored.priors}`,
    );

    // ── (g) 히스토리 라벨·점프·저장 상태 ──────────────────────────────────────
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([rect("h1", 10, 60, 20, 20)])} })`);
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([
      rect("h1", 10, 60, 20, 20), rect("h2", 40, 60, 20, 20),
    ])} })`);
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([
      rect("h1", 10, 60, 20, 20), rect("h2", 40, 60, 20, 20), rect("h3", 70, 60, 20, 20),
    ])} })`);
    const hist = await cdp.eval(`(() => {
      const e = window.__gpvPersist.ed().history.entries();
      const live = e.filter((x) => !x.readonly);
      return { live: live.length, labels: live.map((x) => x.label), cursor: window.__gpvPersist.ed().history.cursor() };
    })()`);
    r.check(
      "(g-1) 커밋 3회 → 되돌릴 수 있는 항목 4개(열기 + 3), 커서는 맨 위",
      hist.live === 4 && hist.cursor === 0,
      `live=${hist.live} cursor=${hist.cursor}`,
    );
    r.check(
      "(g-2) 모든 항목에 라벨이 붙는다(빈 문자열 없음)",
      Array.isArray(hist.labels) && hist.labels.every((l) => typeof l === "string" && l.length > 0),
      J(hist.labels),
    );
    const jumped = await cdp.eval(`(() => {
      const ok = window.__gpvPersist.ed().history.jumpTo(1);
      return { ok, n: window.__gpvPersist.doc().objects.length, cursor: window.__gpvPersist.ed().history.cursor() };
    })()`);
    r.check(
      "(g-3) jumpTo(1) → 한 칸 전 문서(객체 2개)로 돌아간다",
      jumped.ok === true && jumped.n === 2 && jumped.cursor === 1,
      `ok=${jumped.ok} n=${jumped.n} cursor=${jumped.cursor}`,
    );
    const dirty = await poll(
      () => cdp.eval(`window.__gpvPersist.ed().history.state()`).catch(() => null),
      (v) => v === "dirty" || v === "saving",
      8,
      120,
    );
    r.check(
      "(g-4) 점프도 편집이다 — 자동저장이 예약된다",
      dirty === "dirty" || dirty === "saving",
      "state=" + dirty,
    );
    const settled = await poll(
      () => cdp.eval(`window.__gpvPersist.ed().history.state()`).catch(() => null),
      (v) => v === "clean",
      12,
      300,
    );
    r.check("(g-5) 1초 디바운스 뒤 자동저장되어 clean", settled === "clean", `state=${settled}`);

    // ── (h) 명명 스냅샷 ──────────────────────────────────────────────────────
    await cdp.eval(`window.__gpvPersist.ed().history.snapshot('1차')`);
    const snaps = await cdp.eval(`window.__gpvPersist.ed().history.listSnapshots()`);
    r.check(
      "(h-1) saveSnapshot → listSnapshots 1건(이름·시각)",
      Array.isArray(snaps) && snaps.length === 1 && snaps[0].name === "1차" && snaps[0].at > 0,
      J(snaps),
    );
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: [] })`);
    const back = await cdp.eval(`(async () => {
      const ok = await window.__gpvPersist.ed().history.loadSnapshot(0);
      return { ok, n: window.__gpvPersist.doc().objects.length };
    })()`);
    r.check(
      "(h-2) 객체를 다 지운 뒤 loadSnapshot(0) → 스냅샷 시점으로 복원",
      back.ok === true && back.n === 2,
      `ok=${back.ok} n=${back.n}`,
    );
    const snapFile = await cdp.try("image_doc_read", {
      projectId: fix.projectId, relPath: SRC, kind: "snapshots",
    });
    r.check(
      "(h-4) 스냅샷 파일이 doc 과 분리돼 있다(kind='snapshots')",
      snapFile.ok && typeof snapFile.r?.json === "string" && /1차/.test(snapFile.r.json),
      snapFile.ok ? `len=${snapFile.r?.json?.length}` : snapFile.message,
    );

    // ── (i) 다중 창 충돌 — 낡은 stamp 로 쓰면 CONFLICT ────────────────────────
    const conflict = await cdp.try("image_doc_write", {
      projectId: fix.projectId,
      relPath: SRC,
      kind: "doc",
      json: J({ v: 2, projectId: fix.projectId, relPath: SRC, doc: {}, log: [] }),
      expectedStamp: "0:0",
    });
    r.check(
      "(i) 다른 창이 먼저 저장한 상태(낡은 stamp) → CONFLICT 로 거절",
      !conflict.ok && conflict.code === "CONFLICT",
      `ok=${conflict.ok} code=${conflict.code}`,
    );

    // ── (j) 에셋 획득 — 붙여넣기와 상한 ──────────────────────────────────────
    await cdp.eval(`window.__gpvPersist.clearToasts()`);
    const pasted = await cdp.eval(`(async () => {
      const b64 = window.__gpvPersist.solidPng(40, 24, '#00A0FF');
      await window.__gpvPersist.paste(window.__gpvPersist.bytesOf(b64), 'image/png', 'p.png');
      const d = window.__gpvPersist.doc();
      const ids = Object.keys(d.assets);
      const a = ids.length ? d.assets[ids[0]] : null;
      const fill = d.objects.length ? d.objects[d.objects.length - 1].fills[0] : null;
      return {
        assets: ids.length,
        w: a && a.w, h: a && a.h, mime: a && a.mime,
        paint: fill && fill.type,
        assetId: fill && fill.assetId,
        matches: !!(a && fill && fill.assetId === ids[0]),
      };
    })()`);
    r.check(
      "(j-1) 붙여넣기 → doc.assets 1건, 디코드해 w/h 가 채워진다",
      pasted.assets === 1 && pasted.w === 40 && pasted.h === 24 && pasted.mime === "image/png",
      J(pasted),
    );
    r.check(
      "(j-2) 붙여넣은 에셋을 가리키는 이미지 채우기 노드가 생긴다",
      pasted.paint === "image" && pasted.matches === true,
      `paint=${pasted.paint} matches=${pasted.matches}`,
    );

    await cdp.eval(`window.__gpvPersist.clearToasts()`);
    // 17MB — 상한(16MB)은 **디코드 전에** 본다. 쓰레기 바이트여도 여기서 걸려야 한다.
    // base64 인코딩만 1초 넘게 걸리므로 결과는 폴링한다.
    await cdp.eval(`(async () => {
      window.__gpvBigBefore = Object.keys(window.__gpvPersist.doc().assets).length;
      await window.__gpvPersist.paste(new Uint8Array(17 * 1024 * 1024), 'image/png', 'big.png');
      return true;
    })()`);
    const tooBig = await poll(
      () =>
        cdp.eval(`({
          before: window.__gpvBigBefore,
          after: Object.keys(window.__gpvPersist.doc().assets).length,
          toasts: window.__gpvPersist.toasts(),
        })`),
      (v) => v && v.toasts.some((t) => t.startsWith("error:")),
      30,
      300,
    );
    r.check(
      "(j-3) 17MB 붙여넣기 → 거부 토스트, 문서는 그대로",
      tooBig.after === tooBig.before &&
        tooBig.toasts.some((t) => t.startsWith("error:") && /너무 큽니다/.test(t)),
      `assets ${tooBig.before}→${tooBig.after} toasts=${J(tooBig.toasts)}`,
    );

    // ── (c) 원본이 바뀌었으면 crop 을 버리고 알린다 ──────────────────────────
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([
      rect("c1", 10, 10, 40, 40),
    ])}, assets: {}, crop: { x: 10, y: 10, w: 50, h: 50 } })`);
    await cdp.eval(`window.__gpvPersist.ed().history.flush()`);
    await closeEditor();
    await sleep(300);
    const b64b = await cdp.eval(`window.__gpvPersist.solidPng(240, 240, '#eeeeee')`);
    await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: b64b, overwrite: true,
    });
    if (!r.check("(c-0) 바뀐 원본으로 재오픈", (await openEditor()) === true)) return;
    const changed = await poll(
      () =>
        cdp
          .eval(`(() => ({
            banner: /원본 이미지가 바뀌었습니다/.test(window.__gpvPersist.text()),
            crop: window.__gpvPersist.doc().crop,
            n: window.__gpvPersist.doc().objects.length,
            outW: window.__gpvPersist.doc().outW,
          }))()`)
          .catch(() => null),
      (v) => v && v.banner === true,
      12,
      300,
    );
    r.check(
      "(c-1) 원본이 바뀌면 배너로 알린다",
      changed?.banner === true,
      `banner=${changed?.banner}`,
    );
    r.check(
      "(c-2) 낡은 crop 을 버리고 출력 크기를 새 이미지로 되돌린다(주석은 유지)",
      changed?.crop === null && changed?.outW === 240 && changed?.n === 1,
      `crop=${J(changed?.crop)} outW=${changed?.outW} n=${changed?.n}`,
    );

    // ── (e) '다른 이름으로' 저장은 문서를 살려 둔다 ──────────────────────────
    const sa = await cdp.eval(`window.__gpvPersist.saveAs(${J(OUT)})`);
    const closedAfterSaveAs = await poll(
      () => cdp.eval(`window.__gpvPersist.gone()`).catch(() => false),
      (v) => v === true,
    );
    r.check(
      "(e-1) 다른 이름으로 저장 성공(편집기 닫힘 + 파일 생성)",
      sa?.ok === true && closedAfterSaveAs === true && existsSync(join(fix.repo, OUT)),
      `saveAs=${J(sa)} closed=${closedAfterSaveAs}`,
    );
    const keptDoc = await readDoc();
    r.check(
      "(e-2) 원본은 한 바이트도 안 바뀌었으므로 편집 문서를 **살려 둔다**",
      keptDoc.ok && typeof keptDoc.r?.json === "string",
      keptDoc.ok ? `json=${typeof keptDoc.r?.json}` : keptDoc.message,
    );

    // ── (d) 제자리 평탄화 저장은 문서를 버린다(R8) ──────────────────────────
    if (!r.check("(d-0) 재오픈", (await openEditor()) === true)) return;
    r.check(
      "(d-1) 저장 전 문서가 복원돼 있다",
      (await cdp.eval(`window.__gpvPersist.doc().objects.length`)) === 1,
    );
    const pressed = await cdp.eval(
      `(() => { const m = window.__gpvPersist.modal();
         const b = Array.from(m.querySelectorAll('button')).find((x) => /^\\s*저장\\s*\\(/.test(x.textContent || ''));
         if (!b) return false; b.click(); return true; })()`,
    );
    await sleep(200);
    const confirmText = await cdp.eval(
      `(() => { const c = window.__gpv.ui.getState().confirm; return c ? c.title + '|' + c.message : null; })()`,
    );
    r.check(
      "(d-2) 평탄화는 비가역이라 확인을 받는다('레이어를 이미지에 굽기')",
      pressed === true && /레이어를 이미지에 굽기/.test(confirmText || ""),
      `pressed=${pressed} confirm=${confirmText}`,
    );
    await cdp.eval(`window.__gpvPersist.confirm()`);
    const closedAfterSave = await poll(
      () => cdp.eval(`window.__gpvPersist.gone()`).catch(() => false),
      (v) => v === true,
    );
    r.check("(d-3) 제자리 저장 완료(편집기 닫힘)", closedAfterSave === true);
    const goneDoc = await poll(() => readDoc(), (v) => v.ok && v.r?.json === null, 12, 300);
    r.check(
      "(d-4) 레이어가 픽셀에 구워졌으므로 편집 문서를 **버린다**(다시 열어도 두 겹이 되지 않는다)",
      goneDoc.ok && goneDoc.r?.json === null,
      goneDoc.ok ? `json=${goneDoc.r?.json}` : goneDoc.message,
    );

    // ── (f) 경로가 바뀌면 문서가 따라가고, 지우면 함께 사라진다 ──────────────
    // 사이드카 키는 **경로 정체**(sha256(projectId \\0 relPath))라, 이름을 바꾸는 순간
    // 아무것도 안 하면 편집이 통째로 사라진 것처럼 보인다.
    // ponytail: FileTreePanel 의 이름변경/이동/삭제 콜백이 이 커맨드를 부르는 것까지는
    // 여기서 확인하지 않는다(가상 스크롤 트리 행 + 컨텍스트 메뉴 구동이 스위트를 부서지기 쉽게
    // 만든다). 세 호출부가 전부 useRenamePath/useDeletePath/moveItems 한 곳씩이라 tsc 가 잡는다.
    if (!r.check("(f-0) 재오픈", (await openEditor()) === true)) return;
    await cdp.eval(`window.__gpvPersist.ed().setDoc({ objects: ${J([rect("f1", 5, 5, 30, 30)])} })`);
    // (d) 의 평탄화 삭제가 스냅샷 파일까지 지웠다 — 이동이 둘 다 옮기는지 보려면 하나 더 만든다.
    await cdp.eval(`window.__gpvPersist.ed().history.snapshot('이동 전')`);
    await cdp.eval(`window.__gpvPersist.ed().history.flush()`);
    await closeEditor();
    await sleep(300);
    const mv = await cdp.try("image_doc_move", {
      projectId: fix.projectId, from: SRC, to: RENAMED,
    });
    const atOld = await readDoc(SRC);
    const atNew = await readDoc(RENAMED);
    r.check(
      "(f-1) image_doc_move: 문서가 새 경로로 따라가고 옛 경로에는 남지 않는다",
      mv.ok && atOld.ok && atOld.r?.json === null && atNew.ok && typeof atNew.r?.json === "string",
      `mv=${mv.ok} old=${atOld.r?.json === null} new=${typeof atNew.r?.json}`,
    );
    const snapMoved = await cdp.try("image_doc_read", {
      projectId: fix.projectId, relPath: RENAMED, kind: "snapshots",
    });
    r.check(
      "(f-2) 스냅샷 파일도 함께 따라간다",
      snapMoved.ok && typeof snapMoved.r?.json === "string",
      snapMoved.ok ? `json=${typeof snapMoved.r?.json}` : snapMoved.message,
    );
    await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: RENAMED, base64: b64b, overwrite: true,
    });
    if (!r.check("(f-3) 새 경로로 열면 문서가 따라와 있다", (await openEditor(RENAMED)) === true)) {
      return;
    }
    const followed = await poll(
      () => cdp.eval(`window.__gpvPersist.doc().objects.map((o) => o.id)`).catch(() => null),
      (v) => Array.isArray(v) && v.length === 1,
      12,
      300,
    );
    r.check(
      "(f-4) 이름을 바꾼 뒤에도 편집이 그대로 이어진다",
      J(followed) === J(["f1"]),
      `ids=${J(followed)}`,
    );
    await closeEditor();
    await sleep(200);
    const del = await dropDoc(RENAMED);
    const afterDel = await readDoc(RENAMED);
    r.check(
      "(f-5) image_doc_delete: 이미지를 지우면 문서도 사라진다(같은 이름의 새 이미지가 남의 주석을 물려받지 않는다)",
      del.ok && afterDel.ok && afterDel.r?.json === null,
      `del=${del.ok} json=${afterDel.r?.json}`,
    );
  } finally {
    await closeEditor().catch(() => {});
    for (const f of created) await dropDoc(f).catch(() => {});
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
