// 프론트(DOM) 기능 e2e — 실제 키보드/클릭/우클릭/포인터로 구동하고 결과를 DOM·스토어로 단언한다.
// dev 빌드가 노출한 window.__gpv(ui·terminals·queryClient)로 픽스처 선택·상태확인·정리를 안정화한다.
// 모두 픽스처 프로젝트에서만 동작하고, 끝나면 만든 터미널/모아보기/선택/Log 상태를 원복한다.
//
// 순서 주의: 이미지 뷰어(프론트 IPC call 래퍼 경유)는 터미널 대량 개폐가 만든 IPC 게이트 혼잡에
// 막혀 로딩이 걸릴 수 있어, 터미널 조작 "전" 깨끗한 상태에서 먼저 검증한다(메모: WebView2 IPC 함정).
import { unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "프론트 DOM 기능 (사이드바 이동 / 이미지뷰어 / 그리드분할 / Ctrl+W / 모아보기·단축키·새터미널 / Log 리사이즈)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!window.__gpv`);
  if (!hasStore) {
    r.skip("프론트 DOM 기능", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const J = (v) => JSON.stringify(v);
  const uGet = (p) => cdp.eval(`window.__gpv.ui.getState().${p}`);
  const selectProject = (id) =>
    cdp.eval(`window.__gpv.ui.getState().selectProject(${J(id)})`);
  const xtermCount = () => cdp.eval(`document.querySelectorAll('.xterm').length`);
  const poll = async (fn, ok, tries = 28, ms = 300) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const ensureFixture = async () => {
    await selectProject(fix.projectId);
    return poll(() => uGet("selectedProjectId"), (v) => v === fix.projectId, 10, 200);
  };

  const origSel = await uGet("selectedProjectId");
  const origLogOpen = await uGet("logOpen");
  const origLogHeight = await uGet("logHeight");
  const origLayout = await uGet("aggregateLayout"); // #11d가 바꾼다 — finally에서 원복
  let tabId = null;
  // 픽스처 탭의 리프 paneId — #2a(세션 컨트롤)·이후 블록들이 함께 쓴다. 재선언 금지
  // (try 스코프에 const로 다시 선언하면 그 앞 블록이 TDZ ReferenceError로 죽는다).
  let paneId = null;
  let tabClosed = false;
  let newTabId = null; // #11c 새 터미널 버튼이 만든 탭 — 정리 대상
  let newTabClosed = false;

  // 보이는 첫 .xterm 을 고르는 페이지 안 표현식. 비활성 탭도 hidden 클래스로 **마운트된 채**
  // 남으므로(WorkspaceTabs.tsx의 active?…:"hidden") 문서 순서 첫 .xterm 은 사용자가 볼 수 없는
  // 탭의 것일 수 있다 — 레이아웃 상자가 있는(=실제로 보이는) 것만 고른다. #2a·#2c·4분할 공용.
  const VIS_XTERM = `Array.from(document.querySelectorAll('.xterm')).find((e) => e.getBoundingClientRect().width > 0)`;

  try {
    // ── 셋업: 픽스처는 원시 invoke로 추가돼 UI 캐시에 없을 수 있다 → projects 쿼리 갱신 후 선택.
    //    선택이 박혀야(=목록에 픽스처 존재) 이후 테스트가 사용자 프로젝트가 아닌 픽스처에서 격리 실행된다.
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    const stuck = await ensureFixture();
    if (
      !r.check(
        "픽스처 프로젝트 선택(이후 테스트 격리)",
        stuck === fix.projectId,
        `selected=${String(stuck).slice(0, 8)}`,
      )
    ) {
      return; // 픽스처를 못 고르면 사용자 UI를 건드리므로 중단
    }

    // ── #1 사이드바 Ctrl+Shift+↑/↓ 이동 ──
    const sel0 = await uGet("selectedProjectId");
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',ctrlKey:true,shiftKey:true,bubbles:true}))`,
    );
    const selDown = await poll(() => uGet("selectedProjectId"), (v) => v !== sel0, 10, 250);
    r.check(
      "Ctrl+Shift+↓: 선택 프로젝트 이동",
      selDown !== sel0,
      `${String(sel0).slice(0, 8)}→${String(selDown).slice(0, 8)}`,
    );
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',ctrlKey:true,shiftKey:true,bubbles:true}))`,
    );
    const selUp = await poll(() => uGet("selectedProjectId"), (v) => v === sel0, 10, 250);
    r.check("Ctrl+Shift+↑: 원위치 복귀", selUp === sel0);
    await ensureFixture();

    // ── #9 이미지 뷰어 (터미널 조작 전 — IPC 게이트 깨끗할 때) ──
    fix.writeFile("e2e-pixel.png", Buffer.from(PNG_B64, "base64"));
    await cdp.eval(
      `(()=>{ window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer"); window.__gpv.ui.getState().selectDiff({ mode: "file", path: "e2e-pixel.png" }); })()`,
    );
    const gotImg = await poll(
      () => cdp.eval(`!!document.querySelector('img[src^="data:image"]')`),
      (v) => v === true,
      30,
      400,
    );
    r.check("이미지 파일 선택 → <img data:image> 렌더", gotImg === true);
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`);
    try {
      unlinkSync(join(fix.repo, "e2e-pixel.png"));
    } catch {
      /* cleanup이 픽스처 통째로 지운다 */
    }

    // ── #9b Office 문서 라우팅 (확장자만 보므로 실제 파일이 없어도 된다) ──
    // 회귀 대상: 예전엔 docx/xlsx/pptx가 "바이너리 파일"이라는 막다른 안내로 떨어져 열 방법이
    // 없었다. 세 가족 모두 각자 이름의 카드 + 외부 앱 버튼이 나와야 한다.
    for (const [file, want] of [
      ["e2e.docx", "Word 문서"],
      ["e2e.xlsx", "Excel 통합 문서"],
      ["e2e.pptx", "PowerPoint 프레젠테이션"],
    ]) {
      await cdp.eval(
        `window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(file)} })`,
      );
      const shown = await poll(
        () => cdp.eval(`document.querySelector('main')?.innerText ?? ""`),
        (v) => v.includes(want) && v.includes("외부 앱으로 열기"),
        12,
        250,
      );
      r.check(
        `Office 라우팅: ${file} → ${want} 카드 + 외부 앱 버튼`,
        shown.includes(want) && shown.includes("외부 앱으로 열기"),
        shown.slice(0, 80),
      );
    }
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`);

    // ── 아래 터미널 검사들의 공통 전제: 모아보기 뷰가 닫혀 있어야 한다 ──
    //
    // 열려 있으면 `main`을 모아보기 그리드가 통째로 차지한다(App.tsx: `aggregateOpen ? <AggregateTerminals/> : …`).
    // 그러면 (a) 문서의 `.xterm`이 전부 우클릭 메뉴 없는 그리드 셀이라 #2가 깨지고,
    // (b) #11의 모아보기 버튼은 "열기"가 아니라 **닫기**로 동작해 뷰 진입·그리드 검사가 연쇄로 무너진다.
    // 2026-09-02 전체 러너의 실패 3건이 정확히 이 상태였다 — 이 자리에 setAggregateOpen(true)만
    // 끼워 세 줄이 같은 값(4분할 거짓 통과 xterm=11, gridXterm=0)으로 그대로 재현됐다.
    // 모아보기를 여는 경로는 mod+Shift+A(GlobalShortcuts의 window keydown)와 타이틀바 버튼뿐이라
    // 앞 스위트가 남긴 것이 아니라 **러너가 도는 동안 이 창에 도달한 키 입력**일 수 있다.
    // 그래서 한 번만 확인하지 않고, 긴 대기(#2b는 셸 응답을 최대 ~55s 기다린다)를 지난 직후마다
    // 원위치시키고 그 사실을 검사 상세에 남긴다.
    const ensureAggClosed = async () => {
      if ((await uGet("aggregateOpen")) !== true) return "전제ok";
      await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
      const v = await poll(() => uGet("aggregateOpen"), (x) => x === false, 12, 250);
      return v === false ? "모아보기 열려 있어 닫음" : "모아보기 닫기 실패";
    };
    r.check(
      "전제: 모아보기 뷰·별도 창 없이 시작",
      (await ensureAggClosed()) === "전제ok" && (await uGet("aggregateWindowOpen")) !== true,
      `별도창=${await uGet("aggregateWindowOpen")}`,
    );

    // ── #2 그리드 분할 (우클릭 → 4분할) ──
    // openTerminal은 { tabId, paneId }를 반환한다 — tabId는 탭 전환/정리용, paneId는 새 탭의
    // 유일한 리프(=activePaneId)라 #2a가 세션 상태(프롬프트 컬럼)를 그 키로 관측한다.
    const opened = await cdp.eval(
      `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
    );
    tabId = opened.tabId;
    paneId = opened.paneId;
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, ${J(tabId)})`,
    );
    const rendered = await poll(xtermCount, (n) => n >= 1);
    r.check("새 터미널 렌더(콜드스타트)", rendered >= 1, `xterm=${rendered}`);

    // ── #2a 세션 컨트롤 오버레이 병합 hit-test (태스크 23) ──
    // 회귀 대상: TerminalPane 우상단 세션 클러스터(z-10)가 같은 앵커의 PaneControls 오버레이(z-30)에 완전히 덮여
    // 테마·히스토리 버튼이 눌리지 않았다. 병합 뒤엔 pane에 오버레이가 하나고, 각 버튼 중심의 elementFromPoint가
    // 자기 자신이어야 한다. opacity-0은 hit-test에 영향이 없어 hover 없이도 판정된다(합성 mouseover는 CSS :hover를
    // 바꾸지 못한다 — 보이는지는 실기가 본다).
    if (rendered >= 1) {
      // paneId: 위에서 잡은 함수 스코프 변수 — 재선언 금지(뒤 블록들도 같은 것을 쓴다).
      const hit = await cdp.eval(`(()=>{
        const x = ${VIS_XTERM};
        const pane = x && x.closest('[class~="group/pane"]');
        if (!pane) return { err: 'pane 래퍼 없음' };
        for (const t of ['pointerover','mouseover','mouseenter']) x.dispatchEvent(new MouseEvent(t,{bubbles:true}));
        const log = pane.querySelector('button[title^="입력한 프롬프트"]');
        const theme = pane.querySelector('button[title^="이 터미널의 컬러 테마"]');
        if (!log || !theme) return { err: '세션 버튼 없음', buttons: pane.querySelectorAll('button').length };
        const center = (b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); };
        const hitLog = center(log), hitTheme = center(theme);
        const overlay = log.closest('.z-30');
        return {
          log: !!hitLog && log.contains(hitLog),
          theme: !!hitTheme && theme.contains(hitTheme),
          top: hitLog ? (hitLog.closest('button') || hitLog).title : null,
          merged: !!overlay && overlay.contains(pane.querySelector('button[title="패널 닫기"]')),
          closeBtns: pane.querySelectorAll('button[title^="패널 닫기"]').length,
        };
      })()`);
      r.check("세션 컨트롤 hit-test: 히스토리 버튼 중심 = 그 버튼", hit.log === true, hit.err || `top="${hit.top}"`);
      r.check("세션 컨트롤 hit-test: 팔레트 버튼 중심 = 그 버튼", hit.theme === true, hit.err || "");
      r.check(
        "오버레이 병합: 세션 버튼이 PaneControls와 한 오버레이(z-30), 닫기 버튼 1개",
        hit.merged === true && hit.closeBtns === 1,
        `merged=${hit.merged} close=${hit.closeBtns}`,
      );
      // 클릭 → 컬럼 여닫힘. 스토어(usePromptHistory)는 __gpv에 없으므로 write-through된 localStorage
      // (gp:prompt-panel-open — promptHistory.ts persistPanel)와 DOM(PromptSidePanel 헤더의 X)으로 본다.
      const panelState = () => cdp.eval(`(()=>{
        let ls = {}; try { ls = JSON.parse(localStorage.getItem('gp:prompt-panel-open') || '{}'); } catch (e) {}
        const pane = ${VIS_XTERM}?.closest('[class~="group/pane"]');
        return { ls: ls[${J(paneId)}] === true, dom: !!pane && !!pane.querySelector('button[title="프롬프트 목록 닫기"]') };
      })()`);
      const clickLog = () => cdp.eval(
        `(()=>{ const b = document.querySelector('[class~="group/pane"] button[title^="입력한 프롬프트"]'); if (b) { b.click(); return true; } return false; })()`,
      );
      await clickLog();
      const st1 = await poll(panelState, (v) => v.ls && v.dom, 12, 250);
      r.check("히스토리 버튼 클릭 → 컬럼 열림(localStorage + DOM)", st1.ls && st1.dom, J(st1));
      await clickLog();
      const st2 = await poll(panelState, (v) => !v.ls && !v.dom, 12, 250);
      r.check("히스토리 버튼 재클릭 → 컬럼 닫힘", !st2.ls && !st2.dom, J(st2));

      // ── 컬럼 헤더 X가 오버레이에 덮이지 않는다 (태스크 23 §10) ──
      // 회귀 대상: 오버레이 앵커가 pane 루트였을 때, 컬럼이 열리면 pane 우상단 = **컬럼 헤더 우측**이라
      // 오버레이(맨 오른쪽 버튼이 '패널 닫기')가 헤더의 X를 정확히 덮었다 → X를 누르면 컬럼이 아니라
      // pane이 닫히고 PTY가 죽었다. 앵커를 xterm 호스트 래퍼로 옮겨 겹침 자체를 없앤다.
      await clickLog();
      await poll(panelState, (v) => v.ls && v.dom, 12, 250);
      const geo = await cdp.eval(`(()=>{
        const pane = ${VIS_XTERM}?.closest('[class~="group/pane"]');
        if (!pane) return { err: 'pane 래퍼 없음' };
        const ov = pane.querySelector('.z-30');
        const x = pane.querySelector('button[title="프롬프트 목록 닫기"]');
        if (!ov || !x) return { err: '오버레이/컬럼 X 없음 ov=' + !!ov + ' x=' + !!x };
        // 컬럼 루트 = X 버튼 → 헤더 div → PromptSidePanel 루트(TermSessionControls).
        const c = x.parentElement.parentElement.getBoundingClientRect();
        const o = ov.getBoundingClientRect(), b = x.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          ovRight: o.right, ovWidth: o.width, colLeft: c.left, colWidth: c.width,
          hitX: !!top && x.contains(top),
          topTitle: top ? ((top.closest('button') || {}).title ?? null) : null,
        };
      })()`);
      r.check(
        "컬럼 열림: 오버레이가 컬럼과 겹치지 않음(오버레이 right ≤ 컬럼 left)",
        !geo.err && geo.ovRight <= geo.colLeft + 0.5,
        geo.err || `overlay right=${geo.ovRight} (w=${geo.ovWidth}) · column left=${geo.colLeft} (w=${geo.colWidth})`,
      );
      r.check(
        "컬럼 헤더 X 중심 elementFromPoint = 그 X 버튼",
        geo.hitX === true,
        geo.err || `top="${geo.topTitle}"`,
      );
      // 실클릭 — elementFromPoint가 돌려준 **최상단** 요소를 누른다. 오버레이가 덮고 있었다면
      // 여기서 '패널 닫기'가 눌려 pane이 사라진다(그게 이 단언이 잡는 회귀다).
      const paneBefore = await xtermCount();
      const projOf = () =>
        cdp.try("term_project", { termId: paneId }).then((v) => (v.ok ? (v.r ?? null) : null));
      // term_open은 셸 spawn이 끝난 뒤에야 세션 맵에 등록한다(terminal-engine의 "PTY가 80x24로
      // 박제" 주석) — 그 전까지 term_project는 null이다. 한가한 앱에서 ~4.5s, 러너 부하에서는
      // 십수 초가 걸린 실측이 있어 넉넉히 기다린다(정상이면 첫 호출에 바로 나온다).
      const ptyBefore = await poll(projOf, (v) => v !== null, 40, 500);
      const clickTop = await cdp.eval(`(()=>{
        const pane = ${VIS_XTERM}?.closest('[class~="group/pane"]');
        const x = pane && pane.querySelector('button[title="프롬프트 목록 닫기"]');
        if (!x) return { ok: false, title: null };
        const b = x.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const btn = top && top.closest('button');
        if (btn) btn.click();
        return { ok: !!btn, title: btn ? btn.title : null };
      })()`);
      const st3 = await poll(panelState, (v) => !v.ls && !v.dom, 12, 250);
      const paneAfter = await xtermCount();
      const ptyAfter = await poll(projOf, (v) => v !== null, 6, 250);
      r.check(
        "컬럼 헤더 X 실클릭 → 컬럼만 닫힘 · pane 수·PTY 불변",
        clickTop.title === "프롬프트 목록 닫기" &&
          !st3.ls &&
          !st3.dom &&
          paneAfter === paneBefore &&
          !!ptyAfter &&
          ptyAfter === ptyBefore,
        `top="${clickTop.title}" ls=${st3.ls} dom=${st3.dom} xterm ${paneBefore}→${paneAfter} pty ${J(ptyBefore)}→${J(ptyAfter)}`,
      );
    } else {
      r.skip("세션 컨트롤 오버레이 병합", "터미널 렌더 선행 실패 — 스킵");
    }

    // ── #2b 모아보기 별도 창이 돌려준 뒤 PTY 크기 복구 ──
    //
    // 회귀 대상(2026-08-28 실사례): 모아보기 별도 창이 터미널을 가져가면 그 창의 작은 셀 크기로
    // PTY가 줄어든다. 창을 닫고 메인이 이어받을 때 출력 채널만 되돌아오고 **크기는 작게 남아**,
    // 넓은 터미널인데 글자가 왼쪽 일부에만 그려졌다(1718px 창에 내용 810px).
    // 메인 창 xterm은 내내 큰 상태라 fit()이 아무것도 안 바꿔 onResize가 안 뜨는 것이 원인이라,
    // reattachAllTerminals가 **값이 같아도** 크기를 다시 보내야 한다.
    // 관측은 **셸에게 직접 묻는다.** `window.__TAURI_INTERNALS__.invoke`는 non-writable이라
    // 스파이를 끼울 수 없고, IPC 호출을 셌자 한들 PTY가 실제로 그 크기가 됐는지는 증명하지 못한다.
    // 셸이 보고하는 폭이 진짜 ConPTY 폭이다.
    const resync = await cdp.eval(`(async()=>{
      // 앱이 **실제로 로드한** URL로 import한다. vite HMR은 갱신된 모듈에 ?t=… 를 붙이는데,
      // 맨 경로로 import하면 레지스트리가 빈 별개 인스턴스를 받아 늘 "터미널 없음"이 된다.
      const url = performance.getEntriesByType("resource").map((e) => e.name)
        .find((n) => /\\/src\\/lib\\/terminal\\.ts/.test(n)) || "/src/lib/terminal.ts";
      const t = await import(url);
      const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
      // PTY가 응답할 때까지 기다린다 — term_open 완료 전 write는 NOT_FOUND로 튄다.
      let inst = null;
      for (let i = 0; i < 60; i++) {
        inst = t.listTerminals().find((x) => x.status === "live");
        if (inst) { try { await inv("term_write", { termId: inst.id, data: "\\r" }); break; } catch (e) { inst = null; } }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!inst) return { skip: "살아있는 터미널이 응답하지 않음" };
      const want = inst.term.cols;
      const read = () => {
        const b = inst.term.buffer.active;
        let s = "";
        for (let i = Math.max(0, b.length - 90); i < b.length; i++)
          s += (b.getLine(i)?.translateToString(true) ?? "") + "\\n";
        return s;
      };
      // 정규식을 문자열로 조립하지 않는다 — 이 소스는 템플릿 리터럴 → CDP → eval 여러 겹을
      // 지나며 역슬래시가 먹혀 \d 가 d 로 죽는다(실제로 겪었다). 숫자 파싱은 손으로 한다.
      const grab = (tag) => {
        const s = read(), key = tag + ":";
        let out = null, i = -1;
        while ((i = s.indexOf(key, i + 1)) >= 0) {
          const rest = s.slice(i + key.length), e = rest.indexOf(":");
          if (e > 0) { const n = Number(rest.slice(0, e)); if (Number.isFinite(n) && n > 0) out = n; }
        }
        return out; // 마지막 숫자 매치 — 에코된 입력줄은 숫자가 아니라 걸러진다
      };
      const ask = async (tag) => {
        try {
          await inv("term_write", { termId: inst.id, data: 'Write-Host "' + tag + ':$($Host.UI.RawUI.WindowSize.Width):"\\r' });
        } catch (e) { return null; }
        for (let i = 0; i < 36; i++) {
          const v = grab(tag);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      };
      const before = await ask("GPVA");
      if (before == null) return { skip: "셸이 폭을 보고하지 않는다(비-PowerShell 또는 미준비)" };
      // 저쪽 창이 가져가 작게 줄인 상황을 그대로 흉내낸다 — PTY만 줄고 이쪽 xterm은 그대로다.
      await inv("term_resize", { termId: inst.id, cols: 40, rows: 10 });
      const shrunk = await ask("GPVB");
      t.reattachAllTerminals();
      await new Promise((r) => setTimeout(r, 1500));
      const after = await ask("GPVC");
      return { want, before, shrunk, after };
    // 페이지 안 예산이 최악 ~55s(PTY 대기 18s + 폭 질문 3회 × 9s + 1.5s)라 cdp.eval 기본 60s
    // 시한에 아슬아슬하게 걸린다 — 부하가 큰 머신에선 실제로 걸렸다. 넉넉히 잡는다.
    })()`, { timeoutMs: 180000 });
    if (resync?.skip) {
      r.skip("모아보기 반환 후 PTY 크기 복구", resync.skip);
    } else {
      r.check(
        "PTY 축소가 실제로 먹는다(전제)",
        resync?.shrunk === 40,
        `40 기대 · 실제 ${resync?.shrunk}`,
      );
      r.check(
        "모아보기 반환 후 PTY 폭 복구(reattach가 크기도 되돌린다)",
        resync?.after === resync?.want,
        `xterm ${resync?.want}열 · 축소 ${resync?.shrunk} → 복구 ${resync?.after}`,
      );
    }

    // ── #2c 우클릭 메뉴 → 프롬프트 목록 열기/닫기 (태스크 24) ──
    // paneId는 위(#2)에서 openTerminal 반환값으로 잡은 함수 스코프 변수. 새 탭의 layout은 leaf
    // 하나(stores/terminals.ts)라 그 값이 곧 프롬프트 스토어의 termId. 재선언 금지 — try 스코프에
    // `const paneId`를 두면 앞의 #2a가 TDZ ReferenceError로 죽는다.
    // openPanels는 __gpv에 없다 — 산출물(영속 키·PromptSidePanel DOM)로 관측한다.
    const panelPersisted = () =>
      cdp.eval(`JSON.parse(localStorage.getItem('gp:prompt-panel-open')||'{}')[${J(paneId)}] === true`);
    const panelCount = () => cdp.eval(`document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length`);
    const MENU = `document.querySelector('div.fixed.z-50.min-w-52')`;
    const menuLabels = () =>
      cdp.eval(`(()=>{ const m=${MENU}; return m ? Array.from(m.querySelectorAll('button')).map(b=>b.textContent.trim()) : null; })()`);
    const clickMenu = (label) =>
      cdp.eval(`(()=>{ const m=${MENU}; const b = m && Array.from(m.querySelectorAll('button')).find(el => (el.textContent||'').trim() === ${J(label)}); if (b) { b.click(); return true; } return false; })()`);
    const esc = () => cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    // .xterm에 contextmenu → TerminalPane onContextMenu가 PaneMenu를 연다(#2의 '4분할'과 같은 경로).
    const rightClickXterm = (yExpr = "r.top+40") =>
      cdp.eval(`(()=>{ const x=${VIS_XTERM}; if(!x) return false; const r=x.getBoundingClientRect();
        x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+40,clientY:${yExpr}})); return true; })()`);
    const noMenu = () => cdp.eval(`!${MENU}`);
    // 라벨이 반전됐는지 보려고 메뉴를 **다시** 열 때 쓴다. 항목 클릭 직후엔 이전 메뉴가 아직 떠
    // 있을 수 있고, 그 상태로 곧바로 우클릭하면 새 메뉴가 이전 메뉴의 정리 경로(window click·
    // onClose)에 함께 닫혀 라벨을 못 읽는다 — #11a가 4회 중 1회 그렇게 실패했다. 고정 sleep +
    // 1회 읽기 대신 (a) 닫힘을 먼저 확인하고 (b) 기대 라벨이 보일 때까지 읽으며 (c) 그래도 안
    // 되면 다시 연다(최대 3회 ≈ 4s). 못 읽으면 마지막 스냅샷을 그대로 돌려줘 detail에 남긴다.
    const openMenuFor = async (open, want) => {
      let labels = null;
      for (let i = 0; i < 3; i++) {
        await poll(noMenu, (v) => v === true, 10, 120);
        await open();
        labels = await poll(menuLabels, (v) => !!v && v.includes(want), 8, 150);
        if (labels && labels.includes(want)) break;
      }
      return labels;
    };

    const dom0 = await panelCount();
    r.check("프롬프트 컬럼 초기 닫힘(전제)", !!paneId && (await panelPersisted()) === false, `pane=${String(paneId).slice(0, 8)}`);
    await rightClickXterm();
    await sleep(300);
    const labels1 = await menuLabels();
    const iMax = labels1?.findIndex((l) => /^패널 최대화/.test(l)) ?? -1;
    const iPrompt = labels1?.indexOf("프롬프트 목록 열기") ?? -1;
    const iFloat = labels1?.findIndex((l) => /새 창으로 분리/.test(l)) ?? -1;
    r.check("PaneMenu: '프롬프트 목록 열기' — '패널 최대화' 다음·'새 창으로 분리' 앞", iMax >= 0 && iPrompt === iMax + 1 && iFloat === iPrompt + 1, J(labels1));
    const clicked1 = await clickMenu("프롬프트 목록 열기");
    const persisted1 = await poll(panelPersisted, (v) => v === true, 10, 200);
    const dom1 = await poll(panelCount, (n) => n === dom0 + 1, 10, 200);
    r.check("클릭 → openPanels[paneId] 영속 + PromptSidePanel 렌더", clicked1 && persisted1 === true && dom1 === dom0 + 1, `ls=${persisted1} dom=${dom0}→${dom1}`);
    const labels2 = await openMenuFor(rightClickXterm, "프롬프트 목록 닫기");
    r.check(
      "PaneMenu: 열린 뒤 라벨 '프롬프트 목록 닫기'",
      !!labels2 && labels2.includes("프롬프트 목록 닫기") && !labels2.includes("프롬프트 목록 열기"),
      J(labels2),
    );
    const clicked2 = await clickMenu("프롬프트 목록 닫기");
    const persisted2 = await poll(panelPersisted, (v) => v === false, 10, 200);
    const dom2 = await poll(panelCount, (n) => n === dom0, 10, 200);
    r.check(
      "클릭 → 컬럼 닫힘(영속 키 제거 + DOM 제거)",
      clicked2 && persisted2 === false && dom2 === dom0,
      `click=${clicked2} ls=${persisted2} dom ${dom0}→${dom2}`,
    );
    // 하단 클램프 — 창 바닥에서 우클릭해도 메뉴 바닥이 창 안에 있다(항목 13개 ≈ 445px, 상수 448).
    await rightClickXterm("window.innerHeight-4");
    await sleep(300);
    const clamp = await cdp.eval(`(()=>{ const m=${MENU}; if(!m) return null; const r=m.getBoundingClientRect(); return { h: r.height, bottom: r.bottom, ih: window.innerHeight }; })()`);
    r.check("PaneMenu 하단 클램프: 메뉴 바닥 ≤ innerHeight", !!clamp && clamp.bottom <= clamp.ih + 0.5, J(clamp));
    await esc();
    await sleep(150);

    // ── #2d 프롬프트 컬럼 호버 카드 (태스크 26) — pane이 아직 하나일 때 ──
    // React의 onMouseEnter/Leave는 네이티브 mouseenter가 아니라 **mouseover/mouseout**에서 합성된다
    // (react-dom 19.2.7). mouseover의 relatedTarget이 React 노드면 그쪽 mouseout이 처리한다고 보고
    // 건너뛰므로, 진입은 relatedTarget 없이 · 이탈은 relatedTarget=document.body(React 밖)로 보낸다.
    // 정규식·역슬래시는 쓰지 않는다(#2b 주석의 함정 — 여러 겹 eval에서 먹힌다).
    if (!(await cdp.eval(`!!window.__gpv.promptHistory`))) {
      r.skip("프롬프트 호버 카드", "__gpv.promptHistory 미노출 — 구 빌드");
    } else {
      const ph = `window.__gpv.promptHistory.getState()`;
      const ITEM = (prefix) =>
        `Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').startsWith(${J(prefix)}))`;
      const card = () =>
        cdp.eval(`(()=>{
          const c = document.querySelector('[role="tooltip"]');
          if (!c) return null;
          const cs = getComputedStyle(c), r = c.getBoundingClientRect();
          const pre = c.querySelector('pre'), ps = pre ? getComputedStyle(pre) : null;
          return { text: c.textContent, pe: cs.pointerEvents, pos: cs.position,
                   left: r.left, width: r.width, top: r.top, bottom: r.bottom, ih: window.innerHeight,
                   mono: ps ? ps.fontFamily : '', ws: ps ? ps.whiteSpace : '', lh: ps ? ps.lineHeight : '' };
        })()`);
      const enter = (prefix) =>
        cdp.eval(`(()=>{
          const b = ${ITEM(prefix)};
          if (!b) return { ok: false };
          b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return { ok: true, cardNow: !!document.querySelector('[role="tooltip"]') };
        })()`);
      const leave = (prefix) =>
        cdp.eval(`(()=>{
          const b = ${ITEM(prefix)};
          if (b) b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
          return !!b;
        })()`);
      const long40 = Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n");

      await cdp.eval(`${ph}.clear(${J(paneId)})`);
      await cdp.eval(
        `${ph}.record(${J(paneId)}, ${J(["e2e-hover-A 첫 프롬프트", "e2e-hover-B 둘째 프롬프트", long40])})`,
      );
      await cdp.eval(`if (!${ph}.openPanels[${J(paneId)}]) ${ph}.togglePanel(${J(paneId)})`);
      const listed = await poll(
        () =>
          cdp.eval(
            `['e2e-hover-A', 'e2e-hover-B', 'L0'].every(p => Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').startsWith(p)))`,
          ),
        (v) => v === true,
        12,
        250,
      );
      r.check("프롬프트 컬럼 열림 + 항목 3개 렌더", listed === true);
      r.check(
        "항목에 native title 없음(이중 표시 방지)",
        await cdp.eval(`(() => { const b = ${ITEM("e2e-hover-A")}; return !!b && !b.hasAttribute('title'); })()`),
      );

      // 최초 표시: 150ms 지연
      const e1 = await enter("e2e-hover-A");
      r.check("mouseover 동기 시점에는 카드 없음(150ms 지연)", e1.ok && e1.cardNow === false, J(e1));
      const cA = await poll(card, (c) => !!c && c.text.includes("e2e-hover-A"), 8, 50);
      r.check(
        "150ms 후 카드: 전문 + 헤더(줄·자) + 힌트",
        !!cA && cA.text.includes("e2e-hover-A 첫 프롬프트") && cA.text.includes("1줄") && cA.text.includes("클릭하면 복사"),
        cA ? cA.text.slice(0, 80) : "카드 없음",
      );
      r.check(
        "카드 비상호작용·fixed·monospace pre-wrap",
        !!cA && cA.pe === "none" && cA.pos === "fixed" && cA.mono.includes("monospace") && cA.ws === "pre-wrap" && cA.lh === "20px",
        cA && `pe=${cA.pe} pos=${cA.pos} ws=${cA.ws} lh=${cA.lh}`,
      );
      // 기하: 항목 rect로 W·left를 재계산해 카드와 비교
      const ir = await cdp.eval(
        `(() => { const r = ${ITEM("e2e-hover-A")}.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; })()`,
      );
      const ihCard = await cdp.eval(`window.innerHeight`);
      const wantW = Math.max(240, Math.min(480, ir.left - 16));
      const wantL = Math.max(8, ir.left - 8 - wantW);
      const below = ir.top < ihCard / 2;
      r.check(
        "카드 폭·left = max(240,min(480,left−16)) / max(8,left−8−W)",
        !!cA && Math.abs(cA.width - wantW) <= 1 && Math.abs(cA.left - wantL) <= 1,
        `w=${cA?.width}/${wantW} l=${cA?.left}/${wantL} itemLeft=${ir.left}`,
      );
      r.check(
        "세로 앵커(50% 규칙) + 화면 안",
        !!cA && (below ? Math.abs(cA.top - ir.top) <= 1 : Math.abs(cA.bottom - ir.bottom) <= 1) && cA.top >= 0 && cA.bottom <= cA.ih,
        `below=${below} top=${cA?.top} bottom=${cA?.bottom} ih=${cA?.ih}`,
      );

      // 항목 간 이동 — 지연 없이 바뀐다(60ms 안)
      await enter("e2e-hover-B");
      await sleep(60);
      const cB = await card();
      r.check("항목 간 이동: 즉시 전환", !!cB && cB.text.includes("e2e-hover-B") && !cB.text.includes("e2e-hover-A"));

      // 40줄 → 30줄 + "외 10줄"
      await enter("L0");
      await sleep(60);
      const cL = await card();
      r.check(
        "40줄 프롬프트: 헤더 40줄, 본문 30줄(L29까지), 푸터 '외 10줄'",
        !!cL && cL.text.includes("40줄") && cL.text.includes("외 10줄") && cL.text.includes("L29") && !cL.text.includes("L30"),
        cL ? cL.text.slice(0, 40) : "카드 없음",
      );

      // 리스트 이탈 → 즉시 숨김
      await leave("L0");
      r.check("리스트 이탈(mouseout→body): 카드 숨김", (await poll(card, (c) => c === null, 8, 50)) === null);

      // 다른 창의 기록 교체 시뮬레이션 — storage 리스너와 같은 setState 경로(promptHistory.ts)
      await enter("e2e-hover-A");
      await poll(card, (c) => !!c, 8, 50);
      await cdp.eval(`window.__gpv.promptHistory.setState({ byTerminal: { ...${ph}.byTerminal, [${J(paneId)}]: [] } })`);
      const wiped = await poll(card, (c) => c === null, 8, 50);
      const panelAlive = await cdp.eval(`document.body.innerText.includes('아직 입력한 프롬프트가 없습니다')`);
      r.check("hover 중 기록 교체 → 카드 소멸, 패널은 빈 상태로 정상", wiped === null && panelAlive === true);

      await cdp.eval(`${ph}.clear(${J(paneId)})`); // 기록(localStorage)·패널 열림 원복
    }

    const aggGuard2 = await ensureAggClosed(); // #2b의 긴 대기 사이에 열렸을 수 있다
    const before4 = await xtermCount();
    const ctx = await cdp.eval(`(()=>{
      const x = ${VIS_XTERM};
      if (!x) return false;
      x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:200}));
      return true;
    })()`);
    await sleep(400);
    const clicked = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(el => /4분할/.test(el.textContent||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    r.check(
      "터미널 우클릭 → '4분할' 메뉴 노출·클릭",
      ctx === true && clicked === true,
      `ctx=${ctx} click=${clicked} ${aggGuard2}`,
    );
    // 클릭 **전** 개수를 기준으로 센다. `>= 4` 는 다른 탭·모아보기 그리드의 패널만으로도 충족돼
    // 4분할이 실제로 실행됐는지 증명하지 못한다 — 실제로 전체 러너에서 메뉴 클릭이 실패했는데도
    // xterm=12 라 이 줄만 통과했다. splitGrid(4)는 대상 패널 1개를 4개로 만드니 정확히 +3이다.
    const after4 = await poll(xtermCount, (n) => n >= before4 + 3, 28, 350);
    r.check("4분할: 터미널 패널 4개 생성", after4 === before4 + 3, `xterm ${before4}→${after4}`);

    // ── #10 Ctrl+W 포커스 패널 닫기 ──
    if (after4 === before4 + 3) {
      const beforeW = await xtermCount();
      await cdp.eval(`(()=>{
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) { ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true})); }
      })()`);
      const afterW = await poll(xtermCount, (n) => n < beforeW, 16, 300);
      r.check("Ctrl+W: 포커스 터미널 닫힘(-1)", afterW === beforeW - 1, `${beforeW}→${afterW}`);
    } else {
      r.skip("Ctrl+W", "4분할 선행 실패 — 스킵");
    }

    // ── #11 모아보기 ──
    const aggGuard3 = await ensureAggClosed(); // 열린 채로 누르면 버튼은 "닫기"가 된다
    // 타이틀바 토글로 **한정**한다. 텍스트 /모아보기/ 로 찾으면 문구에 그 말이 든 다른 버튼이
    // 늘어나는 순간 첫 매치가 엉뚱한 것이 된다 — title 은 이 토글만 갖는다(TitleBar.tsx AggregateButton).
    const aggBtn = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => /터미널 모아보기|모아보기가 별도 창에/.test(x.title||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const aggOpen = await uGet("aggregateOpen");
    const aggHeader = await cdp.eval(`document.body.innerText.includes('터미널 모아보기')`);
    r.check(
      "모아보기 버튼 → 뷰 진입",
      aggBtn === true && aggOpen === true && aggHeader === true,
      `btn=${aggBtn} open=${aggOpen} header=${aggHeader} ${aggGuard3}`,
    );
    // 셀의 xterm 은 엔진 청크 로드 뒤 비동기로 붙는다 — 즉시 세면 0이 나온다(#11c와 같은 이유).
    const aggGrid = await poll(
      () =>
        cdp.eval(
          `(()=>{ const g=document.querySelector('[style*="grid-template-columns"]'); return g?g.querySelectorAll('.xterm').length:0; })()`,
        ),
      (n) => n >= 1,
      20,
      300,
    );
    r.check("모아보기: 그리드에 터미널 표시", aggGrid >= 1, `gridXterm=${aggGrid}`);

    // ── #11a ChipMenu → 프롬프트 목록 (태스크 24) — 표시 중 터미널 셀에만 ──
    const rightClickCell = () =>
      cdp.eval(`(()=>{ const g=document.querySelector('[style*="grid-template-columns"]'); const x=g&&g.querySelector('.xterm'); if(!x) return false;
        const r=x.getBoundingClientRect(); x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+30,clientY:r.top+30})); return true; })()`);
    const cell0 = await panelCount();
    await rightClickCell();
    await sleep(300);
    const cl1 = await menuLabels();
    const iZoom = cl1?.findIndex((l) => /^확대/.test(l)) ?? -1;
    r.check("ChipMenu(표시 셀): '프롬프트 목록 열기' — '확대해서 보기' 다음", iZoom >= 0 && cl1[iZoom + 1] === "프롬프트 목록 열기", J(cl1));
    const cClick1 = await clickMenu("프롬프트 목록 열기");
    const cDom1 = await poll(panelCount, (n) => n === cell0 + 1, 10, 200);
    r.check("셀 메뉴 클릭 → 셀 안 PromptSidePanel", cClick1 && cDom1 === cell0 + 1, `dom ${cell0}→${cDom1}`);
    const cl2 = await openMenuFor(rightClickCell, "프롬프트 목록 닫기");
    const cClick2 = await clickMenu("프롬프트 목록 닫기");
    const cDom2 = await poll(panelCount, (n) => n === cell0, 10, 200);
    r.check(
      "셀 메뉴: 라벨 '프롬프트 목록 닫기' → 닫힘",
      !!cl2 && cl2.includes("프롬프트 목록 닫기") && cClick2 && cDom2 === cell0,
      `cl2=${J(cl2)} click=${cClick2} dom ${cell0}→${cDom2}`,
    );
    // 숨김 셀의 칩 우클릭 → 항목 없음. 칩은 title "(우클릭: 메뉴)"; 탭 모으기 모드면 개별 칩이 없어 스킵.
    const CHIP = `document.querySelector('button[title*="우클릭: 메뉴"]')`;
    const hasChip = await cdp.eval(`!!${CHIP}`);
    if (!hasChip) {
      r.skip("숨김 셀 칩 메뉴", "개별 칩 없음(탭 모으기 모드) — 스킵");
    } else {
      await cdp.eval(`${CHIP}.click()`); // 첫 칩 숨김(all은 이름순 정렬이라 첫 칩은 안정)
      await sleep(300);
      try {
        await cdp.eval(`(()=>{ const c=${CHIP}; const r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+4,clientY:r.bottom+2})); })()`);
        await sleep(300);
        const hl = await menuLabels();
        r.check("숨김 셀 칩 메뉴: '그리드에 표시'는 있고 프롬프트 목록 항목은 없음", !!hl && hl.includes("그리드에 표시") && !hl.some((l) => l.startsWith("프롬프트 목록")), J(hl));
        await esc();
        await sleep(150);
      } finally {
        await cdp.eval(`(()=>{ const c=${CHIP}; if (c && !c.classList.contains('ring-1')) c.click(); })()`); // 다시 표시
        await sleep(300);
      }
    }

    await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /닫기/.test(x.textContent||''));
      if (b) b.click();
    })()`);
    await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    r.check("모아보기 닫기 → 워크스페이스 복귀", (await uGet("aggregateOpen")) === false);

    // ── #11b 모아보기 토글 단축키 (Ctrl+Shift+A — GlobalShortcuts + xterm 화이트리스트) ──
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`,
    );
    const hkOpen = await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const hkHeader = await cdp.eval(`document.body.innerText.includes('터미널 모아보기')`);
    r.check("Ctrl+Shift+A: 모아보기 열림", hkOpen === true && hkHeader);
    // 터미널(xterm) 포커스 상태에서도 토글돼야 한다 — 엔진 화이트리스트 통과 검증(Ctrl+W 패턴 미러)
    await poll(
      () => cdp.eval(`!!document.querySelector('.xterm-helper-textarea')`),
      (v) => v === true,
      12,
      300,
    );
    await cdp.eval(`(()=>{
      const ta = document.querySelector('.xterm-helper-textarea');
      const target = ta || window;
      if (ta) ta.focus();
      target.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    })()`);
    const hkClosed = await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    r.check("Ctrl+Shift+A(터미널 포커스): 모아보기 닫힘", hkClosed === false);

    // ── #11c 모아보기 헤더 '새 터미널' 버튼 → 그리드에 셀 즉시 등장 ──
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const tabsBefore = await cdp.eval(
      `window.__gpv.terminals.getState().terminals.map(t=>t.id)`,
    );
    const gridCount = () =>
      cdp.eval(
        `(()=>{ const g=document.querySelector('[style*="grid-template-columns"]'); return g?g.querySelectorAll('.xterm').length:0; })()`,
      );
    // 재진입 직후엔 기존 셀들의 xterm attach가 진행 중일 수 있다 — 카운트가 멈출 때까지 대기
    let gridBefore = await gridCount();
    for (let i = 0; i < 20; i++) {
      await sleep(350);
      const nx = await gridCount();
      if (nx === gridBefore && nx >= 1) break;
      gridBefore = nx;
    }
    // 헤더의 "+" 버튼 — 텍스트가 없어 title로 찾는다(종류 선택 메뉴를 연다).
    const plusBtn = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /새 터미널/.test(x.title||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    await sleep(350);
    // 1단계: 메뉴에서 '새 터미널' 선택.
    await cdp.eval(`(()=>{
      const m = document.querySelector('div.fixed.z-50');
      if (!m) return false;
      const b = Array.from(m.querySelectorAll('button')).find(x => /새 터미널/.test(x.textContent||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    await sleep(350);
    // 2단계: 프로젝트 2개 이상이면 프로젝트 목록이 이어서 뜬다 — 선택 프로젝트(=픽스처)가
    // 맨 위라 첫 항목 클릭. 1개뿐이면 종류 선택 즉시 생성(지름길)이라 이미 탭이 늘어 클릭 생략.
    const grewNow = await cdp.eval(
      `window.__gpv.terminals.getState().terminals.length > ${tabsBefore.length}`,
    );
    if (!grewNow) {
      await cdp.eval(`(()=>{
        const m = document.querySelector('div.fixed.z-50');
        const b = m && m.querySelector('button');
        if (b) b.click();
      })()`);
    }
    newTabId = await poll(
      () =>
        cdp.eval(
          `window.__gpv.terminals.getState().terminals.map(t=>t.id).find(id=>!${J(tabsBefore)}.includes(id)) || null`,
        ),
      (v) => !!v,
      12,
      300,
    );
    const newTabProj = newTabId
      ? await cdp.eval(
          `(window.__gpv.terminals.getState().terminals.find(t=>t.id===${J(newTabId)})||{}).projectId || null`,
        )
      : null;
    r.check(
      "새 터미널 버튼 → 픽스처 프로젝트에 탭 생성",
      plusBtn && !!newTabId && newTabProj === fix.projectId,
      `tab=${String(newTabId).slice(0, 8)}`,
    );
    const gridAfter = await poll(gridCount, (n) => n > gridBefore, 28, 350);
    r.check(
      "새 터미널: 모아보기 그리드에 셀 등장",
      gridAfter > gridBefore,
      `grid ${gridBefore}→${gridAfter}`,
    );
    // ── #11d 자동배치 모드(태스크 27) — 모아보기 열림·셀 ≥ 2 상태에서 ──
    // gridAfter는 그리드 안 `.xterm` 수라 브라우저 셀은 안 센다 → n>1 판정으로는 보수적(스킵 쪽).
    if (gridAfter < 2) {
      r.skip("자동배치 모드", `셀 ${gridAfter}개 — 자동배치 버튼은 n>1에서만 렌더`);
    } else {
      // 그리드 자식(=셀 슬롯)의 top으로 행 구성을 읽는다. 배치가 absolute+calc라 DOM 순서로는
      // 행을 알 수 없다.
      const rowShape = () => cdp.eval(`(()=>{
        const g = document.querySelector('[style*="grid-template-columns"]');
        if (!g) return null;
        const tops = [...g.children].map(el => Math.round(el.getBoundingClientRect().top));
        const first = tops.filter(t => t === Math.min(...tops)).length;
        return { n: tops.length, first, rows: new Set(tops).size };
      })()`);
      const gridColsOf = (k) => (k <= 1 ? 1 : k <= 4 ? 2 : k <= 9 ? 3 : 4);

      await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("columns")`);
      const colShape = await poll(rowShape, (v) => v && v.first === Math.min(v.n, 4), 10, 250);
      r.check(
        "자동배치 columns: 첫 행 셀 수 = min(n, 4)",
        !!colShape && colShape.first === Math.min(colShape.n, 4),
        J(colShape),
      );
      r.check(
        "aggregateLayout localStorage 영속",
        (await cdp.eval(`localStorage.getItem('gp:aggregate-layout')`)) === "columns",
      );
      await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("grid")`);
      const gridShape = await poll(rowShape, (v) => v && v.first === gridColsOf(v.n), 10, 250);
      r.check(
        "자동배치 grid: 첫 행 셀 수 = gridCols(n)",
        !!gridShape && gridShape.first === gridColsOf(gridShape.n),
        J(gridShape),
      );

      // 팝오버 — 균등 상태(aria-disabled)에서도 래퍼 hover로 열려야 한다. React는 disabled 버튼의
      // onMouseEnter를 등록조차 하지 않으므로(getListener) 버튼에 달았다면 여기서 죽는다.
      // onMouseEnter는 네이티브 mouseover에서 합성된다(relatedTarget null = 밖에서 들어옴).
      const hover = await cdp.eval(`(()=>{
        const b = [...document.querySelectorAll('button')].find(x => /자동배치/.test(x.textContent||''));
        if (!b) return { found: false };
        b.parentElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { found: true, aria: b.getAttribute('aria-disabled'), nativeDisabled: b.disabled };
      })()`);
      const popBtns = () => cdp.eval(`(()=>{
        const m = [...document.querySelectorAll('div.fixed.z-50')].find(d => d.querySelector('button[title^="그리드"]'));
        return m ? m.querySelectorAll('button').length : 0;
      })()`);
      const icons = await poll(popBtns, (v) => v === 2, 8, 150);
      r.check(
        "자동배치 hover → 모드 팝오버(아이콘 2개) — aria-disabled 상태에서도",
        hover.found && hover.nativeDisabled === false && icons === 2,
        J({ ...hover, icons }),
      );
      // 아이콘 클릭 = 모드 설정 + 대상 모드 균등 트랙 + 닫힘
      await cdp.eval(
        `[...document.querySelectorAll('div.fixed.z-50 button')].find(b => /^세로 컬럼/.test(b.title))?.click()`,
      );
      const picked = await poll(() => uGet("aggregateLayout"), (v) => v === "columns", 8, 150);
      const popGone = await poll(popBtns, (v) => v === 0, 8, 150);
      const tracks = await cdp.eval(`(()=>{
        const s = window.__gpv.ui.getState();
        const t = s.aggregateTracks['n' + ${colShape?.n ?? 0}];
        return t && {
          lens: t.cols.map(a => a.length),
          even: t.rows.every(v => v === 1) && t.cols.every(a => a.every(v => v === 1)),
        };
      })()`);
      r.check(
        "모드 아이콘 클릭 → aggregateLayout=columns · 트랙 균등(첫 행 min(n,4)) · 팝오버 닫힘",
        picked === "columns" &&
          popGone === 0 &&
          !!tracks &&
          tracks.even &&
          tracks.lens[0] === Math.min(colShape?.n ?? 0, 4),
        J({ picked, popGone, tracks }),
      );
      const iconNow = await cdp.eval(
        `!![...document.querySelectorAll('button')].find(x => /자동배치/.test(x.textContent||''))?.querySelector('svg.lucide-columns-3')`,
      );
      r.check("메인 버튼 아이콘 = 현재 모드(Columns3)", iconNow === true);
      await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("grid")`);
    }

    // 모아보기 닫고 새 탭 정리 — 이후 검증이 원래 상태에서 돌게.
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    if (newTabId) {
      await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(newTabId)})`);
      newTabClosed = true;
      await sleep(300);
    }

    // ── #12 프로젝트 색: 사이드바 행 배경 == 모아보기 칩 색(같은 프로젝트) · 정렬 토글 뒤 불변 (태스크 28) ──
    const bgOf = (elExpr) =>
      cdp.eval(`(()=>{ const el=${elExpr}; return el ? getComputedStyle(el).backgroundColor : null; })()`);
    const rgb3 = (s) => (s && s.match(/^rgba?\((\d+), (\d+), (\d+)/)?.slice(1, 4).join(",")) || null;
    const rowExpr = `document.querySelector('[data-project-id=${J(fix.projectId)}]')`;
    const fixName = await cdp.eval(
      `(window.__gpv.queryClient.getQueryData(["projects"])||[]).find(p=>p.id===${J(fix.projectId)})?.name ?? null`,
    );
    const rowTint = await cdp.eval(`${rowExpr}?.style.getPropertyValue('--tint') ?? ''`);
    const rowBg = await bgOf(rowExpr);
    r.check(
      "사이드바 행: --tint 인라인 변수 + 배경 실제 적용(bg-(--tint) 규칙 생성)",
      /^hsl\(\d+ 70% var\(--proj-l\) \/ var\(--proj-a-row/.test(rowTint) && !!rowBg && rowBg !== "rgba(0, 0, 0, 0)",
      `tint=${rowTint} bg=${rowBg}`,
    );
    // 모아보기 칩 — 개별 칩 title "이름 · 제목 (우클릭: 메뉴)" 또는 묶음 칩 "이름 — 탭 N개 …" 둘 다 이름으로 시작
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const chipExpr = `Array.from(document.querySelectorAll('button')).find(b => (b.title||'').startsWith(${J(fixName)} + ' · ') || (b.title||'').startsWith(${J(fixName)} + ' — 탭'))`;
    const chipBg = await poll(() => bgOf(chipExpr), (v) => !!v, 12, 300);
    r.check(
      "모아보기 칩 색 == 사이드바 행 색 (r,g,b 동일 — 알파만 다름)",
      !!chipBg && rgb3(chipBg) === rgb3(rowBg),
      `chip=${chipBg} row=${rowBg}`,
    );
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    // 변경 우선 정렬 토글 → 표시 순서가 바뀌어도 색은 그대로(배정이 이름순 전체 기준)
    const sort0 = await uGet("projectSortByChanges");
    await cdp.eval(`window.__gpv.ui.getState().toggleProjectSort()`);
    await sleep(300);
    const rowBgSorted = await bgOf(rowExpr);
    r.check("변경 우선 정렬 토글 뒤 행 색 불변", rgb3(rowBgSorted) === rgb3(rowBg), `${rowBg} → ${rowBgSorted}`);
    if ((await uGet("projectSortByChanges")) !== sort0)
      await cdp.eval(`window.__gpv.ui.getState().toggleProjectSort()`); // 원복(localStorage 영속이라 반드시)

    // 터미널 탭 닫기 — 이후 Log 핸들이 패널 divider(.cursor-row-resize)와 안 헷갈리게.
    await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`);
    tabClosed = true;
    await sleep(400);

    // ── #4 Log 패널 높이 드래그 리사이즈 ──
    // 높이는 [120, innerHeight-200]로 클램프된다 → 창이 너무 작으면(최소화 등) 여유가 없어
    // 드래그가 의미 없으므로 그때만 스킵한다(기능 자체는 정상, 환경 의존).
    const ih = await cdp.eval(`window.innerHeight`);
    if (ih < 500) {
      r.skip("Log 핸들 드래그 리사이즈", `창이 작음(innerHeight=${ih}) — 클램프 여유 없어 스킵`);
    } else {
      await cdp.eval(
        `if(!window.__gpv.ui.getState().logOpen) window.__gpv.ui.getState().toggleLog()`,
      );
      await sleep(350);
      await cdp.eval(`window.__gpv.ui.getState().setLogHeight(160)`); // 클램프 하단 근처
      await sleep(200);
      const h0 = await uGet("logHeight");
      const dragged = await cdp.eval(`(()=>{
        const h = document.querySelector('.cursor-row-resize');
        if (!h) return false;
        const rect = h.getBoundingClientRect();
        const y = rect.top + rect.height/2;
        h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientY:y,pointerId:1}));
        window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientY:y-100,pointerId:1}));
        window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientY:y-100,pointerId:1}));
        return true;
      })()`);
      await sleep(450);
      const h1 = await uGet("logHeight");
      const lsH = await cdp.eval(`Number(localStorage.getItem('gp:log-height'))`);
      r.check("Log 핸들 드래그 → 높이 증가", dragged && h1 > h0, `${h0}→${h1}`);
      r.check("Log 높이 localStorage 영속", lsH === h1, `ls=${lsH}`);
    }
  } finally {
    // 정리 — 만든 터미널 탭 닫고, 모아보기/뷰어/Log/선택 상태 원복.
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    // #2d가 만든 프롬프트 기록·컬럼 열림(localStorage)까지 되돌린다.
    if (paneId)
      await cdp
        .eval(`window.__gpv.promptHistory && window.__gpv.promptHistory.getState().clear(${J(paneId)})`)
        .catch(() => {});
    if (tabId && !tabClosed)
      await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`).catch(() => {});
    if (newTabId && !newTabClosed)
      await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(newTabId)})`).catch(() => {});
    // #11d가 바꾼 자동배치 모드 원복(사용자 설정이라 localStorage에 남는다).
    if (origLayout)
      await cdp
        .eval(`window.__gpv.ui.getState().setAggregateLayout(${J(origLayout)})`)
        .catch(() => {});
    await cdp
      .eval(`window.__gpv.ui.getState().setLogHeight(${Number(origLogHeight) || 288})`)
      .catch(() => {});
    if (!origLogOpen)
      await cdp
        .eval(`if(window.__gpv.ui.getState().logOpen) window.__gpv.ui.getState().toggleLog()`)
        .catch(() => {});
    if (origSel)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
  }
}
