// 태스크 54 — 파일 트리에서 이미지를 우클릭해 **프로젝트 로고로 지정**한다.
//
// 지키는 계약 넷:
//   ① 메뉴 항목은 이미지 파일에만 뜬다 — svg 포함(변환·편집 항목과 게이트가 다르다), 폴더엔 없다.
//   ② 지정은 `projects.json`에 남고(list_projects의 logo), 사이드바·툴바가 **재시작 없이** 그 이미지를
//      그린다(useProjectLogo 캐시가 처음으로 무효화되는 지점 — 안 하면 앱을 껐다 켜야 보인다).
//   ③ 쓸 수 없는 파일은 **저장 전에** 거절된다 — 에러를 말하고 logo는 그대로다(반쯤 지정된 상태 금지).
//   ④ 해제하면 null로 돌아간다(자동 감지 복귀).
//
// 픽스처는 레포 루트의 PNG·SVG 각 1개 + 로고로 쓸 수 없는 큰 webp 1개다.
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const name = "프로젝트 로고 수동 지정 (트리 메뉴 · 사이드바·툴바 즉시 갱신 · 거절 · 해제)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const PNG = "logo-fixture.png";
const SVG = "logo-fixture.svg";
const BAD = "logo-fixture-big.webp";

/** 200×200 단색 PNG base64 — 페이지 캔버스로 만든다(30·46 스위트와 같은 방식). */
const SOLID_PNG = `(() => {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#4488ff';
  x.fillRect(0, 0, 200, 200);
  return c.toDataURL('image/png').split(',')[1];
})()`;

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("프로젝트 로고 수동 지정", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  /** 저장된 값 — 표시가 아니라 **영속 상태**를 본다(재시작 후 유지의 근거). */
  const savedLogo = async () => {
    const list = await cdp.invoke("list_projects");
    const p = (list || []).find((x) => x.id === fix.projectId);
    return p ? (p.logo ?? null) : undefined;
  };

  /** 트리 파일 행에 contextmenu → 메뉴 버튼 라벨 목록(메뉴가 없으면 null). */
  const openTreeMenu = async (sel) => {
    const ok = await cdp.eval(`(()=>{
      const el = document.querySelector(${J(sel)});
      if (!el) return false;
      const b = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2),
      }));
      return true;
    })()`);
    if (ok !== true) return null;
    return poll(
      () =>
        cdp.eval(`(()=>{
          const m = document.querySelector('div.fixed.z-50.min-w-52');
          return m ? Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
        })()`),
      (v) => Array.isArray(v) && v.length > 0,
      12,
      150,
    );
  };

  const clickMenuItem = (label) =>
    cdp.eval(`(()=>{
      const m = document.querySelector('div.fixed.z-50.min-w-52');
      const b = m && Array.from(m.querySelectorAll('button'))
        .find(x => x.textContent.trim() === ${J(label)});
      if (!b) return false;
      b.click();
      return true;
    })()`);

  const closeMenu = () =>
    cdp
      .eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      .catch(() => {});

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  const projName = basename(fix.repo);

  try {
    // ── 셋업: 레포 루트에 PNG·SVG·큰 webp ────────────────────────────────────
    const b64 = await cdp.eval(SOLID_PNG);
    if (!r.check("픽스처 PNG 인코딩", typeof b64 === "string" && b64.length > 0)) return;
    writeFileSync(join(fix.repo, PNG), Buffer.from(b64, "base64"));
    writeFileSync(
      join(fix.repo, SVG),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f80"/></svg>\n`,
    );
    // 200KiB를 넘고 디코드도 안 되는 파일 — encode_logo가 반드시 None을 돌려준다.
    writeFileSync(join(fix.repo, BAD), Buffer.alloc(500 * 1024, 0x7a));

    // 픽스처는 원시 invoke로 추가돼 UI 캐시에 없다 — projects 갱신 후에야 선택이 박힌다(46과 같은 가드).
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (stuck !== fix.projectId) {
      r.skip("프로젝트 로고 수동 지정", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp.eval(
      `window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`,
    );
    await sleep(500);

    // ── ① 메뉴 게이트 ────────────────────────────────────────────────────────
    const LABEL = "프로젝트 로고로 지정";
    const pngRow = `[data-tree-file=${J(PNG)}]`;
    const hasRow = await poll(
      () => cdp.eval(`!!document.querySelector(${J(pngRow)})`),
      (v) => v === true,
      16,
      250,
    );

    let viaMenu = false;
    if (hasRow === true) {
      const pngLabels = await openTreeMenu(pngRow);
      r.check(
        `PNG 우클릭 메뉴에 "${LABEL}"`,
        Array.isArray(pngLabels) && pngLabels.includes(LABEL),
        `labels=${J(pngLabels)}`,
      );

      // 지정은 이 클릭으로 한다(백엔드 직접 호출이 아니라 실제 동선).
      viaMenu = (await clickMenuItem(LABEL)) === true;
      await closeMenu();

      // svg에도 뜬다 — 변환·편집(menuIsImage)과 달리 로고 게이트는 svg를 포함한다.
      const svgLabels = await openTreeMenu(`[data-tree-file=${J(SVG)}]`);
      r.check(
        `SVG 우클릭 메뉴에도 "${LABEL}"(변환·편집 게이트와 다르다)`,
        Array.isArray(svgLabels) && svgLabels.includes(LABEL),
        `labels=${J(svgLabels)}`,
      );
      await closeMenu();

      // 폴더엔 없다.
      const dirLabels = await openTreeMenu(`[data-tree-isdir="1"]`);
      r.check(
        `폴더 우클릭 메뉴엔 "${LABEL}" 없음`,
        Array.isArray(dirLabels) && !dirLabels.includes(LABEL),
        `labels=${J(dirLabels)}`,
      );
      await closeMenu();
    } else {
      r.skip("트리 우클릭 메뉴 게이트", "트리에 픽스처 행이 없다(패널 접힘 등) — 커맨드로 대체");
    }
    if (!viaMenu) {
      await cdp.invoke("set_project_logo", { id: fix.projectId, relPath: PNG });
      await cdp
        .eval(
          `window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["project-logo", fix.projectId])} })`,
        )
        .catch(() => {});
      // `Project.logo`도 갱신해야 한다 — 행 메뉴의 '로고 해제'는 그 필드로 게이트된다.
      // UI 경로(useSetProjectLogo)는 setQueryData로 같이 갱신하지만 원시 invoke는 안 한다.
      await cdp
        .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
        .catch(() => {});
    }

    // ── ② 영속 + 세 표시처 즉시 갱신 ─────────────────────────────────────────
    const saved = await poll(savedLogo, (v) => v === PNG, 12, 250);
    if (!r.check("list_projects의 logo가 지정 경로", saved === PNG, `logo=${J(saved)}`)) return;

    const title = `로고: ${PNG}`;
    const sidebar = await poll(
      () =>
        cdp.eval(
          `(()=>{ const el = document.querySelector('[data-project-id=${J(fix.projectId)}] img[title^="로고: "]');
             return el ? el.getAttribute('title') : null; })()`,
        ),
      (v) => v === title,
      12,
      250,
    );
    r.check(
      "사이드바 행 로고가 즉시 갱신(재시작 불필요 — project-logo 캐시 무효화)",
      sidebar === title,
      `title=${J(sidebar)}`,
    );

    const toolbar = await poll(
      () =>
        cdp.eval(
          `(()=>{ const el = document.querySelector('header img[title=${J(title)}]'); return !!el; })()`,
        ),
      (v) => v === true,
      12,
      250,
    );
    r.check("워크스페이스 툴바의 프로젝트 이름 앞에도 같은 로고", toolbar === true, `found=${toolbar}`);

    // 모아보기 셀 헤더 — 이 프로젝트의 터미널 셀이 있을 때만 검사한다(셀이 없으면 헤더도 없다).
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    await poll(
      () => cdp.eval(`window.__gpv.ui.getState().aggregateOpen`),
      (v) => v === true,
      12,
      250,
    );
    const cell = await poll(
      () =>
        cdp.eval(`(()=>{
          const heads = Array.from(document.querySelectorAll('div.h-6'))
            .filter(h => (h.textContent || '').includes(${J(projName)}));
          if (!heads.length) return 'no-cell';
          return heads.some(h => h.querySelector('img[title=' + ${J(J(title))} + ']')) ? 'logo' : 'no-logo';
        })()`),
      (v) => v === "logo" || v === "no-cell",
      12,
      250,
    );
    if (cell === "no-cell")
      r.skip("모아보기 셀 헤더 로고", "픽스처 프로젝트의 터미널 셀이 없다");
    else r.check("모아보기 셀 헤더에도 로고(14px)", cell === "logo", `cell=${cell}`);
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await sleep(200);

    // ── ③ 쓸 수 없는 파일은 저장 전에 거절 ───────────────────────────────────
    const bad = await cdp.try("set_project_logo", { id: fix.projectId, relPath: BAD });
    r.check(
      "500KiB 비디코드 webp 지정 → 거절(로고로 쓸 수 없는 파일)",
      bad.ok === false && /로고로 쓸 수 없는 파일/.test(bad.message || ""),
      `ok=${bad.ok} message=${J(bad.message)}`,
    );
    r.check("거절되면 logo는 그대로(반쯤 지정된 상태 없음)", (await savedLogo()) === PNG);

    // ── ④ 해제 — 행 우클릭 메뉴 ──────────────────────────────────────────────
    const rowMenu = await cdp.eval(`(()=>{
      const el = document.querySelector('[data-project-id=${J(fix.projectId)}]');
      if (!el) return false;
      const b = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2),
      }));
      return true;
    })()`);
    const rowLabels =
      rowMenu === true
        ? await poll(
            () =>
              cdp.eval(`(()=>{
                const m = document.querySelector('div.fixed.z-50.min-w-44');
                return m ? Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
              })()`),
            (v) => Array.isArray(v) && v.includes("로고 해제"),
            12,
            150,
          )
        : null;
    r.check(
      "지정된 프로젝트의 행 메뉴에 '로고 해제'",
      Array.isArray(rowLabels) && rowLabels.includes("로고 해제"),
      `labels=${J(rowLabels)}`,
    );
    const cleared =
      Array.isArray(rowLabels) && rowLabels.includes("로고 해제")
        ? await cdp.eval(`(()=>{
            const m = document.querySelector('div.fixed.z-50.min-w-44');
            const b = m && Array.from(m.querySelectorAll('button'))
              .find(x => x.textContent.trim() === '로고 해제');
            if (!b) return false;
            b.click();
            return true;
          })()`)
        : false;
    if (cleared !== true)
      await cdp.invoke("set_project_logo", { id: fix.projectId, relPath: null });
    const after = await poll(savedLogo, (v) => v === null, 12, 250);
    r.check("해제 → logo === null(자동 감지 복귀)", after === null, `logo=${J(after)}`);
  } finally {
    await closeMenu();
    await cdp.try("set_project_logo", { id: fix.projectId, relPath: null });
    for (const f of [PNG, SVG, BAD]) {
      try {
        rmSync(join(fix.repo, f), { force: true, maxRetries: 5 });
      } catch {
        /* 픽스처 정리가 통째로 지운다 — 실패해도 무해 */
      }
    }
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`)
      .catch(() => {});
    await cdp
      .eval(
        `window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["project-logo", fix.projectId])} })`,
      )
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    if (origSel)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
    await sleep(300);
  }
}
