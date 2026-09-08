// 태스크 62 — 터미널 세션 헤더의 파일 트리 버튼 → 그 프로젝트의 **파일 트리 모달**.
//
// 지키는 계약 다섯:
//   ① 모달은 **그 세션의 프로젝트**를 그린다 — 사이드바가 다른 프로젝트를 고른 상태에서도
//      헤더 이름·트리 내용이 인자로 준 프로젝트의 것이어야 한다. `selectDiff`처럼 "현재 선택된
//      프로젝트" 기준으로 경로를 푸는 경로가 하나라도 남으면 여기서 갈린다(설계 §2).
//   ② 모달에서 파일을 눌러도 **전역이 안 움직인다** — `selectedDiff`·뷰어 탭 수·모아보기 열림이
//      클릭 전후로 같다. `selectDiff`를 부르면 뷰어 탭이 늘고 모아보기가 닫힌다(ui.ts selectDiff).
//   ③ 대신 **문서 창**이 뜨고, 그 창이 받은 대상이 **그 프로젝트의** 그 파일이다
//      (`openDocWindow`가 남기는 `gp:doc-windows` 기록 = main.tsx `docTarget`이 읽는 그 값).
//   ④ 모달이 열린 동안 `selectBlockingOverlay`가 true — 빠지면 모아보기의 네이티브 브라우저
//      webview가 모달을 통째로 덮는다(태스크 55에서 실제로 났던 버그).
//   ⑤ Esc·배경 클릭으로 닫히고, **모달 안에서 시작해 배경에서 놓은** 클릭으로는 안 닫힌다
//      (트리의 드래그 이동을 배경에서 놓으면 click이 공통 조상인 배경으로 온다).
//
// 회귀: 사이드바 `FileTreePanel`(variant 기본값 "panel")의 행 클릭은 지금까지대로 중앙 뷰어로
// 간다 — 훅(`onActivate`)을 넣으면서 기본 경로가 바뀌지 않았는지 본다.
import { connectLabel } from "../lib/cdp.mjs";

export const name =
  "파일 트리 모달 (그 탭의 프로젝트 · 전역 불변 · 문서 창 라우팅 · 점유 계약 · 배경/Esc 닫기)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

/**
 * 파일 트리 모달의 **배경(백드롭)** — 같은 `fixed inset-0 z-50` 껍데기를 쓰는 GitDialog와
 * 트리 헤더 버튼으로 가른다. 모달 박스는 이 요소의 자식이다(닫기 판정이 배경 기준이라
 * 이 구분이 중요하다 — 배경의 부모에 이벤트를 쏘면 React 핸들러 경로에 배경이 없다).
 */
const MODAL = `Array.from(document.querySelectorAll('div.fixed.inset-0.z-50'))
  .find(el => el.querySelector('button[title="새 파일 (루트)"]'))`;

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;

  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  // 훅 노출은 **폴링**한다 — dev 서버가 방금 리로드했으면 모듈 스코프의 `__gpv` 대입이 아직
  // 안 끝나 한 번만 보고는 "dev 빌드 아님"으로 오진한다(vite HMR 리로드 직후 실측).
  const hooks = await poll(
    () =>
      cdp.eval(
        `!!(window.__gpv && window.__gpv.ui && window.__gpv.queryClient && window.__gpv.selectBlockingOverlay)`,
      ),
    (v) => v === true,
    16,
    250,
  );
  if (hooks !== true) {
    r.skip("파일 트리 모달", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );
  const closeLabel = (label) =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${J(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);
  /** 닫힌 doc 창이 localStorage(`gp:doc-windows`)에 남긴 대상 기록 제거 — 이 실행분만. */
  const forgetDoc = (docKey) =>
    cdp
      .eval(
        `(()=>{ try{ const k='gp:doc-windows'; const v=JSON.parse(localStorage.getItem(k)||'{}');
           delete v[${J(docKey)}]; localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);
  const docKeys = () =>
    cdp.eval(
      `(()=>{ try{ return Object.keys(JSON.parse(localStorage.getItem('gp:doc-windows')||'{}')); }catch(e){ return []; } })()`,
    );

  const dialogOpen = () => cdp.eval(`!!window.__gpv.ui.getState().fileTreeDialog`);
  const openDialog = (id) =>
    cdp.eval(`window.__gpv.ui.getState().openFileTreeDialog(${J(id)})`);
  const closeDialog = () => cdp.eval(`window.__gpv.ui.getState().closeFileTreeDialog()`);
  const esc = () =>
    cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );

  /** 전역 스냅샷 — ②의 불변 단언 대상. */
  const globals = () =>
    cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      return {
        diff: s.selectedDiff ? JSON.stringify(s.selectedDiff) : null,
        repo: s.selectedDiffRepoId || null,
        tabs: s.viewerTabs.length,
        agg: !!s.aggregateOpen,
      };
    })()`);

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  let docKey = null;
  let docLabel = null;
  // 사이드바 트리를 접어/닫아 둔 사용자도 회귀 검사를 돌 수 있게 잠깐 펼친다 — 끝에 원복한다.
  const origFileTreeOpen = await cdp.eval(`window.__gpv.ui.getState().fileTreeOpen`);
  let expandedSidebar = false;

  try {
    // ── 셋업: 픽스처를 캐시에 인지시키고, 사이드바는 **다른** 프로젝트를 고른 상태로 만든다 ──
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    const known = await poll(
      () =>
        cdp.eval(`(()=>{
          const ps = window.__gpv.queryClient.getQueryData(["projects"]) || [];
          const me = ps.find(p => p.id === ${J(fix.projectId)});
          const other = ps.find(p => p.id !== ${J(fix.projectId)});
          return { name: me ? me.name : null, otherId: other ? other.id : null, otherName: other ? other.name : null };
        })()`),
      (v) => !!v && !!v.name,
      16,
      250,
    );
    if (!known?.name) {
      r.skip("파일 트리 모달", "픽스처 프로젝트가 목록 캐시에 없다");
      return;
    }
    // 사이드바 선택을 픽스처가 **아닌** 프로젝트로 — ①의 함정(선택 프로젝트 기준 경로 해석)을
    // 재현할 수 있는 상태를 만든다. 다른 프로젝트가 하나도 없으면 그 대비만 못 한다.
    if (known.otherId)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(known.otherId)})`);
    await sleep(300);
    // 모아보기를 켜 둔 채로 전부 돈다. 셀 헤더가 있어야 ①의 실제 동선(버튼)을 누를 수 있고,
    // 파일 클릭이 모아보기를 닫지 않는다는 ②의 세 번째 부작용도 같은 회차에서 잡힌다.
    // (별도 모아보기 창이 떠 있으면 메인은 켤 수 없다 — 그때는 그 부분만 건너뛴다.)
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`).catch(() => {});
    const aggOn = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().aggregateOpen`),
      (v) => v === true,
      12,
      250,
    );

    // ── ① 세션 헤더 버튼으로 열린다 + 헤더가 그 프로젝트다 ──────────────────
    const btn = await poll(
      () =>
        cdp.eval(`(()=>{
          const b = document.querySelector('button[title="파일 트리 보기"]');
          if (!b) return 'no-button';
          b.click();
          return 'ok';
        })()`),
      (v) => v === "ok",
      12,
      250,
    );
    if (btn === "ok") {
      const opened = await poll(dialogOpen, (v) => v === true, 12, 250);
      r.check("세션 헤더 파일 트리 버튼 클릭으로 모달이 열린다", opened === true, `open=${opened}`);
      await closeDialog();
      await sleep(200);
    } else {
      r.skip("세션 헤더 파일 트리 버튼", "버튼이 없다(터미널·브라우저 셀 없음) — 스토어로 대체");
    }

    await openDialog(fix.projectId);
    const shell = await poll(
      () =>
        cdp.eval(`(()=>{
          const m = ${MODAL};
          if (!m) return null;
          const head = m.querySelector('.font-semibold');
          return {
            name: head ? head.textContent.trim() : null,
            paths: Array.from(m.querySelectorAll('[data-tree-path]')).map(e => e.getAttribute('data-tree-path')),
            hasClose: !!m.querySelector('button[title="닫기"]'),
            hasNewDir: !!m.querySelector('button[title="새 폴더 (루트)"]'),
            // 패널 크롬은 없어야 한다 — 접기 버튼·폭 핸들은 사이드바 영속 상태를 건드린다.
            hasCollapse: !!m.querySelector('button[title="패널 접기"]'),
          };
        })()`),
      (v) => !!v && v.paths.length > 0,
      24,
      250,
    );
    if (
      !r.check(
        "openFileTreeDialog → 모달에 파일 트리 + 새 파일·새 폴더·닫기(접기 버튼 없음)",
        !!shell && shell.hasClose === true && shell.hasNewDir === true && shell.hasCollapse === false,
        `shell=${J(shell)}`,
      )
    )
      return;

    r.check(
      "모달 헤더가 **그 탭의 프로젝트** 이름이다(사이드바 선택은 다른 프로젝트)",
      shell.name === known.name &&
        (!known.otherName || known.otherName === known.name || shell.name !== known.otherName),
      `헤더="${shell.name}" 픽스처="${known.name}" 사이드바선택="${known.otherName ?? "(없음)"}"`,
    );
    r.check(
      "모달 트리가 그 프로젝트의 파일을 나열한다(README.md · src · .gitignore)",
      ["README.md", "src", ".gitignore"].every((p) => shell.paths.includes(p)),
      `paths=${J(shell.paths)}`,
    );

    // ── ② ③ 파일 클릭 → 전역 불변 + 문서 창 ─────────────────────────────────
    // 모아보기가 켜진 채로 누른다 — selectDiff 경로였다면 여기서 모아보기가 **닫힌다**.
    const beforeKeys = arr(await docKeys());
    const beforeLabels = arr(await labels());
    const g0 = await globals();
    const clicked = await cdp.eval(`(()=>{
      const m = ${MODAL};
      if (!m) return 'no-modal';
      const el = m.querySelector('[data-tree-file="README.md"]');
      if (!el) return 'no-row';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
    r.check("모달에서 파일 행 클릭", clicked === "ok", `res=${clicked}`);

    const newKey = await poll(
      async () => arr(await docKeys()).find((k) => !beforeKeys.includes(k)) ?? null,
      (v) => !!v,
      20,
      250,
    );
    docKey = newKey;
    const record = newKey
      ? await cdp.eval(
          `(()=>{ try{ return JSON.parse(localStorage.getItem('gp:doc-windows')||'{}')[${J(newKey)}] || null; }catch(e){ return null; } })()`,
        )
      : null;
    r.check(
      "문서 창 대상이 **그 프로젝트의** 그 파일이다(다른 레포의 같은 경로가 아니다)",
      !!record && record.projectId === fix.projectId && record.path === "README.md",
      `record=${J(record)} 기대projectId=${fix.projectId}`,
    );
    docLabel = await poll(
      async () =>
        arr(await labels()).find((l) => l.startsWith("doc-") && !beforeLabels.includes(l)) ??
        null,
      (v) => !!v,
      20,
      500,
    );
    r.check("모달에서 파일 활성화 → doc-* 창이 실제로 뜬다", !!docLabel, docLabel || "미발견");

    await sleep(500);
    const g1 = await globals();
    r.check(
      "전역 불변 — selectedDiff·뷰어 탭 수가 클릭 전후 동일(모달이 selectDiff를 부르지 않는다)",
      !!g1 && g1.diff === g0.diff && g1.repo === g0.repo && g1.tabs === g0.tabs,
      `before=${J(g0)} after=${J(g1)}`,
    );
    if (aggOn === true)
      r.check(
        "모아보기가 열린 채 모달에서 파일을 눌러도 모아보기가 닫히지 않는다",
        g1?.agg === true,
        `agg=${g1?.agg}`,
      );
    else r.skip("모아보기 유지 단언", "모아보기를 열지 못했다(별도 창이 떠 있을 수 있다)");
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});

    // 그 창이 실제로 픽스처 파일을 그리는지 — 기록이 아니라 화면으로 한 번 더 본다.
    if (docLabel) {
      const dcdp = await connectLabel(docLabel, { port: cdpPort }).catch(() => null);
      if (dcdp) {
        const shown = await poll(
          () =>
            dcdp.eval(
              `(document.body.textContent || '').includes('gitpervisor e2e fixture')`,
            ),
          (v) => v === true,
          30,
          500,
        );
        r.check(
          "doc 창이 픽스처의 README.md 내용을 그린다",
          shown === true,
          `본문에 시드 문구 ${shown === true ? "있음" : "없음"}`,
        );
        dcdp.close();
      } else {
        r.skip("doc 창 내용 확인", "doc 창 CDP 연결 실패");
      }
    }

    // ── ④ 점유 계약 ─────────────────────────────────────────────────────────
    const overlayNow = () =>
      cdp.eval(
        `(()=>{ const f=window.__gpv.selectBlockingOverlay; return f ? f(window.__gpv.ui.getState()) : null; })()`,
      );
    const onOpen = await overlayNow();
    await closeDialog();
    await sleep(200);
    const onClose = await overlayNow();
    r.check(
      "점유 계약(selectBlockingOverlay에 fileTreeDialog)",
      onOpen === true && onClose === false,
      `열림=${J(onOpen)} 닫힘=${J(onClose)}`,
    );

    // ── ⑤ 닫기 규칙 ─────────────────────────────────────────────────────────
    await openDialog(fix.projectId);
    await poll(dialogOpen, (v) => v === true, 12, 250);
    await esc();
    const escClosed = await poll(dialogOpen, (v) => v === false, 12, 250);
    r.check("Esc → 모달 닫힘(fileTreeDialog === null)", escClosed === false, `open=${escClosed}`);

    await openDialog(fix.projectId);
    await poll(dialogOpen, (v) => v === true, 12, 250);
    // 모달 **안에서** 시작해 배경에서 놓은 클릭 — 배경이 pointerdown도 자기에게서 받았을 때만
    // 닫아야 한다. 안 그러면 트리에서 시작한 드래그 이동이 모달을 닫아 버린다.
    const dragOut = await cdp.eval(`(()=>{
      const backdrop = ${MODAL};
      if (!backdrop) return 'no-modal';
      const inside = backdrop.querySelector('.overflow-auto');
      if (!inside) return 'no-inside';
      inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
    await sleep(300);
    const stillOpen = await dialogOpen();
    r.check(
      "모달 안에서 시작해 배경에서 놓은 클릭으로는 **안 닫힌다**",
      dragOut === "ok" && stillOpen === true,
      `dispatch=${dragOut} open=${stillOpen}`,
    );

    const bgClick = await cdp.eval(`(()=>{
      const backdrop = ${MODAL};
      if (!backdrop) return 'no-modal';
      backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
    const bgClosed = await poll(dialogOpen, (v) => v === false, 12, 250);
    r.check(
      "배경(백드롭)에서 시작해 배경에서 놓은 클릭 → 닫힘",
      bgClick === "ok" && bgClosed === false,
      `dispatch=${bgClick} open=${bgClosed}`,
    );

    // ── 회귀: 사이드바 트리는 지금까지대로 중앙 뷰어로 간다 ──────────────────
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (stuck !== fix.projectId) {
      r.skip("사이드바 트리 회귀", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
    } else {
      await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
      // 사용자가 패널을 접어 뒀거나 닫아 뒀으면 잠깐 펼친다(finally에서 원복).
      if ((await cdp.eval(`window.__gpv.ui.getState().fileTreeOpen`)) !== true)
        await cdp.eval(`window.__gpv.ui.getState().toggleFileTree()`).catch(() => {});
      const expanded = await cdp.eval(`(()=>{
        const b = document.querySelector('button[title="Files 펼치기"]');
        if (!b) return 'already';
        b.click();
        return 'expanded';
      })()`);
      if (expanded === "expanded") expandedSidebar = true;
      await sleep(400);
      const sideRow = await poll(
        () =>
          cdp.eval(`(()=>{
            const el = Array.from(document.querySelectorAll('[data-tree-file="README.md"]'))
              .find(e => !e.closest('div.fixed.inset-0.z-50'));
            if (!el) return 'no-row';
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'ok';
          })()`),
        (v) => v === "ok",
        16,
        250,
      );
      if (sideRow !== "ok") {
        r.skip("사이드바 트리 회귀", "사이드바 트리 행이 없다(패널이 닫혀 있거나 접힘)");
      } else {
        const sel = await poll(
          () =>
            cdp.eval(
              `(()=>{ const d = window.__gpv.ui.getState().selectedDiff; return d ? d.mode + ':' + d.path : null; })()`,
            ),
          (v) => v === "file:README.md",
          16,
          250,
        );
        r.check(
          "회귀 — 사이드바 트리 행 클릭은 여전히 중앙 뷰어로 간다(variant 기본값 'panel')",
          sel === "file:README.md",
          `selectedDiff=${J(sel)}`,
        );
      }
    }
  } finally {
    await esc().catch(() => {});
    await closeDialog().catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    // 사이드바 패널 원복 — 접힘은 usePanelCollapsed가 localStorage에 쓰므로 버튼으로 되돌린다.
    if (expandedSidebar)
      await cdp
        .eval(`(()=>{
          const b = Array.from(document.querySelectorAll('button[title="새 파일 (루트)"]'))
            .find(x => !x.closest('div.fixed.inset-0.z-50'));
          const c = b && b.parentElement.querySelector('button[title="패널 접기"]');
          if (!c) return false;
          c.click();
          return true;
        })()`)
        .catch(() => {});
    if ((await cdp.eval(`window.__gpv.ui.getState().fileTreeOpen`).catch(() => null)) !== origFileTreeOpen)
      await cdp.eval(`window.__gpv.ui.getState().toggleFileTree()`).catch(() => {});
    if (docLabel) await closeLabel(docLabel);
    if (docKey) await forgetDoc(docKey);
    await cdp
      .eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(fix.projectId)})`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await sleep(300);
  }
}
