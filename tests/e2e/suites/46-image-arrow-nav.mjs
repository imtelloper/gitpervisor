// 태스크 56 — 이미지 뷰어에서 ↑/↓(·←/→)로 **같은 폴더의 이전·다음 이미지**로 넘어간다.
//
// 지키는 계약 넷:
//   ① 이미지를 열면 뷰어 박스가 **스스로 포커스를 갖는다**. 지금껏 아무도 focus() 를 부르지 않아
//      한 번 클릭하기 전엔 키가 안 먹었다 — 클릭 없이 바로 넘길 수 있어야 태스크가 성립한다.
//   ② 화살표가 같은 폴더의 형제 이미지(트리와 같은 백엔드 자연 정렬)로 대상을 바꾸고, 끝에서 멈춘다.
//   ③ **뷰어 탭이 늘지 않는다**(`replaceDiff`). selectDiff 로 넘기면 50장을 넘길 때 탭도 50개가 된다 —
//      탭 수 불변이 이 태스크의 핵심 제약이라 전환마다 센다.
//   ④ 수식키(Ctrl)가 얹히면 양보하고, 박스 **밖** 포커스에서는 아예 개입하지 않는다(window 리스너 없음 —
//      있으면 터미널의 ↑↓ 셸 히스토리를 가로챈다).
//
// 픽스처는 `imgs/` 폴더에 같은 내용의 PNG 3장(a·b·c)이다 — 내용은 무관하고 **이름 순서**만 쓴다.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 뷰어 화살표 내비게이션 (형제 전환 · 탭 수 불변 · 자동 포커스 · 수식키 양보)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const DIR = "imgs";
const NAMES = ["a.png", "b.png", "c.png"];
const REL = NAMES.map((n) => `${DIR}/${n}`);

/** 단색 PNG base64 — 페이지 캔버스로 만든다(외부 인코더 불필요, 30·34 스위트와 같은 방식). */
const SOLID_PNG = `(() => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 64, 64);
  return c.toDataURL('image/png').split(',')[1];
})()`;

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("이미지 화살표 내비게이션", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const poll = async (fn, ok, tries = 30, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  /** 뷰어 상태 한 묶음 — 대상 경로 · 이 프로젝트의 탭 수 · 프로젝트별 활성 파일. */
  const state = () =>
    cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      const act = s.activeDiffByProject[${J(fix.projectId)}];
      return {
        path: s.selectedDiff ? s.selectedDiff.path : null,
        tabs: s.viewerTabs.filter(t => t.outerId === ${J(fix.projectId)}).length,
        active: act && act.target ? act.target.path : null,
      };
    })()`);

  /**
   * ImageView 박스(편집기 stage 도 .checkerboard 라 tabindex 로 가른다)가 **rel 을 그리고 있는지**와
   * 포커스 상태. 전환 중에는 이전 이미지의 박스가 잠깐 남으므로(`key={path}` 리마운트 전) 대상까지
   * 확인해야 옛 박스를 보고 통과하지 않는다 — `<img alt={path}>` 로 가른다.
   */
  const boxState = (rel) =>
    cdp.eval(`(()=>{
      const box = document.querySelector('.checkerboard[tabindex="0"]');
      if (!box) return 'none';
      const img = box.querySelector('img');
      if (!img || img.getAttribute('alt') !== ${J(rel)}) return 'other';
      return document.activeElement === box ? 'focused' : 'blurred';
    })()`);

  /**
   * 툴바의 형제 카운터 텍스트(`n / N`). 툴바는 `[data-image-toolbar]` 로 짚는다 — 예전엔
   * "박스 바로 위 형제"로 짚었는데, 68(글자 추출)이 박스를 [이미지 | 패널] 행으로 감싸면서
   * 그 관계가 끊겨 카운터를 못 찾았다(위치로 짚으면 레이아웃이 바뀔 때마다 깨진다).
   * 툴바 전체 textContent 는 요소 사이 공백이 없어 `2 / 3` 과 `100%` 가 "2 / 3100%" 로 붙는다
   * — 그래서 **그 형태인 span**을 골라 읽는다. 카운터가 없으면 빈 문자열(형제 1장 이하 → 미표시).
   */
  const counter = () =>
    cdp.eval(`(()=>{
      const bar = document.querySelector('[data-image-toolbar]');
      if (!bar) return null;
      const el = Array.from(bar.querySelectorAll('span'))
        .find(s => /^\\d+ \\/ \\d+$/.test(s.textContent.replace(/\\s+/g, ' ').trim()));
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);

  /** 박스에 keydown 을 쏜다. 포커스 여부는 ①에서 따로 단언하므로 여기선 직접 디스패치한다. */
  const press = (key, mods = {}) =>
    cdp.eval(`(()=>{
      const box = document.querySelector('.checkerboard[tabindex="0"]');
      if (!box) return 'no-box';
      box.dispatchEvent(new KeyboardEvent('keydown', Object.assign(
        { key: ${J(key)}, bubbles: true, cancelable: true }, ${J(mods)})));
      return 'ok';
    })()`);

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);

  try {
    // ── 셋업: imgs/ 에 PNG 3장 ───────────────────────────────────────────────
    const b64 = await cdp.eval(SOLID_PNG);
    if (!r.check("픽스처 PNG 인코딩", typeof b64 === "string" && b64.length > 0)) return;
    mkdirSync(join(fix.repo, DIR), { recursive: true });
    const bytes = Buffer.from(b64, "base64");
    for (const rel of REL) writeFileSync(join(fix.repo, rel), bytes);

    // 픽스처는 원시 invoke 로 추가돼 UI 캐시에 없다 — projects 갱신 후에야 선택이 박힌다.
    // 안 박히면 selectDiff 의 outerId 가 **사용자 프로젝트**가 돼 그쪽 탭을 건드린다(34와 같은 가드).
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
      r.skip("이미지 화살표 내비게이션", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer")`,
    );
    // 방금 만든 폴더를 트리·형제 목록이 보게 한다(워처를 기다리지 않는다).
    await cdp.eval(
      `window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`,
    );
    await sleep(400);

    // ── 열기: 트리에서 imgs/b.png 클릭 ──────────────────────────────────────
    // 트리 행이 없으면(패널 접힘 등) 같은 결과를 내는 스토어 경로로 연다 — 뒤의 단언들은
    // 트리 클릭 여부와 무관하다.
    const rowSel = `[data-tree-file=${J(REL[1])}]`;
    let opened = "tree";
    if ((await cdp.eval(`!!document.querySelector(${J(rowSel)})`)) !== true) {
      await cdp.eval(`(()=>{
        const d = document.querySelector('[data-tree-path=${J(DIR)}][data-tree-isdir="1"]');
        if (!d) return 'no-dir';
        d.click();
        return 'ok';
      })()`);
      await poll(() => cdp.eval(`!!document.querySelector(${J(rowSel)})`), (v) => v === true, 20, 250);
    }
    if ((await cdp.eval(`!!document.querySelector(${J(rowSel)})`)) === true) {
      await cdp.eval(`(()=>{
        document.querySelector(${J(rowSel)}).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
    } else {
      opened = "store";
      r.skip("트리 행 클릭으로 열기", "트리에 imgs/b.png 행이 없어 selectDiff 로 대체(패널 접힘 등)");
      await cdp.eval(
        `window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(REL[1])} })`,
      );
    }

    const box = await poll(
      () => boxState(REL[1]),
      (v) => v === "focused" || v === "blurred",
      40,
      250,
    );
    if (
      !r.check(
        "이미지 뷰어가 imgs/b.png 를 그린다(.checkerboard 박스)",
        box === "focused" || box === "blurred",
        `box=${box} via=${opened}`,
      )
    )
      return;

    // ① 포커스 — 클릭 없이 키가 먹으려면 박스가 마운트 시 스스로 포커스를 가져야 한다.
    r.check(
      "이미지를 열면 뷰어 박스가 포커스를 갖는다(마운트 시 focus — 클릭 없이 키 입력)",
      box === "focused",
      `activeElement=${box}`,
    );

    const bar0 = await poll(counter, (v) => v === "2 / 3", 20, 250);
    r.check(
      "툴바에 형제 카운터 `2 / 3`(imgs 의 두 번째 이미지)",
      bar0 === "2 / 3",
      `counter="${bar0}"`,
    );

    const s0 = await state();
    if (!r.check("열린 대상이 imgs/b.png", s0 && s0.path === REL[1], `path=${s0 && s0.path}`)) return;
    const baseTabs = s0.tabs;

    // ② ArrowDown → 다음 이미지 · ③ 탭 수 불변
    await press("ArrowDown");
    const s1 = await poll(state, (v) => v && v.path === REL[2], 20, 250);
    r.check(
      "ArrowDown → 다음 이미지(imgs/c.png)로 전환",
      s1 && s1.path === REL[2],
      `path=${s1 && s1.path}`,
    );
    r.check(
      "전환해도 뷰어 탭이 늘지 않는다(replaceDiff — 제자리 교체)",
      s1 && s1.tabs === baseTabs,
      `탭 ${s1 && s1.tabs}개 (기준 ${baseTabs})`,
    );
    const bar1 = await poll(counter, (v) => v === "3 / 3", 20, 250);
    r.check("툴바 카운터가 `3 / 3`으로 갱신", bar1 === "3 / 3", `counter="${bar1}"`);

    // 끝에서 멈춘다(순환 없음).
    await poll(() => boxState(REL[2]), (v) => v === "focused", 20, 250);
    await press("ArrowDown");
    await sleep(600);
    const s2 = await state();
    r.check(
      "마지막 이미지에서 ArrowDown → 대상 불변(순환 없음)",
      s2 && s2.path === REL[2] && s2.tabs === baseTabs,
      `path=${s2 && s2.path} 탭=${s2 && s2.tabs}`,
    );

    // ArrowUp ×2 → 첫 이미지. 전환마다 리마운트라 포커스가 돌아오길 기다린 뒤 다음 키를 쏜다.
    await poll(() => boxState(REL[2]), (v) => v === "focused", 20, 250);
    await press("ArrowUp");
    await poll(state, (v) => v && v.path === REL[1], 20, 250);
    await poll(() => boxState(REL[1]), (v) => v === "focused", 20, 250);
    await press("ArrowUp");
    const s3 = await poll(state, (v) => v && v.path === REL[0], 20, 250);
    r.check(
      "ArrowUp ×2 → 첫 이미지(imgs/a.png), 탭 수 여전히 불변",
      s3 && s3.path === REL[0] && s3.tabs === baseTabs,
      `path=${s3 && s3.path} 탭=${s3 && s3.tabs}`,
    );
    r.check(
      "activeDiffByProject 도 함께 갱신(프로젝트 전환 후 복귀 시 이 이미지)",
      s3 && s3.active === REL[0],
      `active=${s3 && s3.active}`,
    );

    // ← / → 도 같은 동작(§7 열린 질문 — 포함으로 결정).
    await poll(() => boxState(REL[0]), (v) => v === "focused", 20, 250);
    await press("ArrowRight");
    const s4 = await poll(state, (v) => v && v.path === REL[1], 20, 250);
    r.check(
      "ArrowRight/ArrowLeft 도 같은 내비게이션(→ imgs/b.png)",
      s4 && s4.path === REL[1] && s4.tabs === baseTabs,
      `path=${s4 && s4.path} 탭=${s4 && s4.tabs}`,
    );

    // ④ 수식키 양보 — Ctrl+↓ 는 전역 단축키 몫이라 뷰어가 먹지 않는다.
    await poll(() => boxState(REL[1]), (v) => v === "focused", 20, 250);
    await press("ArrowDown", { ctrlKey: true });
    await sleep(600);
    const s5 = await state();
    r.check(
      "Ctrl+ArrowDown → 대상 불변(수식키 조합은 양보)",
      s5 && s5.path === REL[1],
      `path=${s5 && s5.path}`,
    );

    // ④ 박스 밖 포커스 — 핸들러는 박스에만 달려 있어야 한다. window 리스너였다면 여기서 움직인다
    //    (그건 곧 터미널의 ↑↓ 셸 히스토리를 가로챈다는 뜻이다).
    await cdp.eval(`(()=>{
      const el = document.activeElement;
      if (el && el.blur) el.blur();
      document.body.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(600);
    const s6 = await state();
    r.check(
      "박스 밖(포커스 해제)에서 ArrowDown → 대상 불변(전역 리스너 없음 — 터미널 ↑↓ 보존)",
      s6 && s6.path === REL[1],
      `path=${s6 && s6.path}`,
    );
  } finally {
    // 정리 — 이 스위트가 연 탭·선택·픽스처 파일을 되돌린다.
    await cdp
      .eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(fix.projectId)})`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    await cdp
      .eval(
        `window.__gpv.queryClient.removeQueries({ queryKey: ${J(["file-image", fix.projectId])} })`,
      )
      .catch(() => {});
    try {
      rmSync(join(fix.repo, DIR), { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* 픽스처 정리가 통째로 지운다 — 실패해도 무해 */
    }
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`)
      .catch(() => {});
    // 사용자 선택 복원 — 이 스위트만 프로젝트 선택을 바꾼다.
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await sleep(300);
  }
}
