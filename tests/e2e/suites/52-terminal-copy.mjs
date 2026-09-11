// 태스크 65 — 터미널 텍스트 복사가 어디서나·어느 OS에서나 된다.
//
// 이 스위트가 지키는 계약 여섯:
//   ① **모아보기 셀 우클릭에 [복사]·[붙여넣기]가 있다.** 없어서 모아보기로 Claude 세션을 읽다
//      우클릭하면 복사가 아예 불가능했다(설계 §2 #1). 이 스위트의 핵심 회귀 방지다.
//   ② `rightClickSelectsWord`가 꺼져 있다. xterm 기본값은 "Macintosh면 true"라 mac에서만
//      선택 밖 우클릭이 커서 아래 단어로 선택을 갈아치웠다(§2 #4). 값 자체는 세 OS 공통이라
//      mac 러너가 없어도 여기서 잰다.
//   ③ 메뉴 [복사]는 **메뉴가 열린 순간의 선택**을 복사한다 — 클릭 시점에 다시 읽지 않는다.
//   ④ 계층 폴백이 실제로 작동한다: 네이티브 플러그인이 죽어도(Linux의 영구 Err, Windows의
//      클립보드 경합) 브라우저 경로가 받아 낸다. `__gpvClipboard.fail()`로 단계를 죽여 증명한다.
//   ⑤ 전부 실패하면 **무음이 아니다** — 사유가 담긴 토스트가 뜨고 선택은 유지된다(다시 시도 가능).
//   ⑥ 선택이 없으면 죽은 [복사] 버튼 대신 **왜 없는지**가 보인다.
//
// 클립보드는 사용자 것이다 — 시작할 때 텍스트를 저장하고 끝에 되돌린다(best-effort).
// [붙여넣기]는 **누르지 않는다.** 누르면 사용자의 셸에 실제로 글자가 들어간다 — 존재만 확인한다.
export const name =
  "터미널 복사 (모아보기 메뉴 · 계층 폴백 · 선택 스냅샷 · 실패 사유 · 안내)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

/** 버퍼에 직접 써 넣는 마커 — PTY를 거치지 않아 셸 종류·프롬프트 지연과 무관하다.
 *  한글이 든 이유: macOS WKWebView의 MacRoman 이중인코딩(dc21cae)이 되살아나면 여기서 갈린다. */
const MARK = "GPV-COPY-마커-한글-e2e";
/** 실패 단계 검증용 센티널 — "클립보드가 안 바뀌었다"의 기준값. */
const SENTINEL = "GPV-COPY-센티널";

/** 열려 있는 컨텍스트 메뉴(PaneMenu·ChipMenu 공통 껍데기 — 스위트 14와 같은 선택자). */
const MENU = `document.querySelector('div.fixed.z-50.min-w-52')`;
/** 실제로 보이는 xterm(비활성 탭도 hidden으로 마운트된 채 남는다 — 스위트 14 주석). */
const VIS_XTERM = `Array.from(document.querySelectorAll('.xterm')).find((e) => e.getBoundingClientRect().width > 0)`;

export async function run({ cdp, report: r, fix }) {
  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      // 술어의 예외도 "아직 아님"으로 본다 — 값이 null인 회차에 `v.includes(…)`가 던지면
      // 스위트가 통째로 죽는다(실측으로 한 번 그랬다).
      try {
        if (ok(v)) return v;
      } catch {
        /* 다음 회차 */
      }
      await sleep(ms);
    }
    return v;
  };
  const str = (v) => (typeof v === "string" ? v : "");

  // 훅 노출은 폴링한다 — 같은 트리의 다른 세션이 방금 저장해 vite가 리로드 중이면 `__gpv` 대입이
  // 아직 안 끝나 한 번만 보고는 "dev 빌드 아님"으로 오진한다(스위트 50·51과 같은 이유).
  const hooks = await poll(
    () =>
      cdp.eval(
        `!!(window.__gpv && window.__gpv.terminals && window.__gpv.term && window.__gpvClipboard)`,
      ),
    (v) => v === true,
    16,
    250,
  );
  if (hooks !== true) {
    r.skip(
      "터미널 복사",
      "window.__gpv / __gpvClipboard 미노출(dev 빌드 아님) — 스킵",
    );
    return;
  }

  const uGet = (k) => cdp.eval(`window.__gpv.ui.getState()[${J(k)}]`);
  // cdp.try 는 성공 값을 `.r` 로 준다(`.value` 가 아니다 — 그렇게 읽으면 항상 undefined다).
  const clipboard = () =>
    cdp.try("term_paste").then((x) => (x.ok ? String(x.r ?? "") : "")).catch(() => "");
  const setFail = (stages) =>
    cdp.eval(`window.__gpvClipboard.fail(${J(stages)})`);
  // **라벨 span 만 읽는다.** 버튼의 textContent 는 라벨과 단축키 힌트가 붙어 나온다
  // ("복사Ctrl+Shift+C") — MenuItem 의 라벨 span 은 `min-w-0`(줄바꿈 금지 주석 참조).
  const menuLabels = () =>
    cdp.eval(
      `(()=>{ const m=${MENU}; return m ? Array.from(m.querySelectorAll('button')).map(b => ((b.querySelector('span.min-w-0') || b).textContent || '').trim()) : null; })()`,
    );
  const menuText = () =>
    cdp.eval(`(()=>{ const m=${MENU}; return m ? m.innerText : null; })()`);
  const clickMenu = (label) =>
    cdp.eval(
      `(()=>{ const m=${MENU}; const b = m && Array.from(m.querySelectorAll('button')).find(el => (((el.querySelector('span.min-w-0') || el).textContent) || '').trim() === ${J(label)}); if (b) { b.click(); return true; } return false; })()`,
    );
  const closeMenu = () =>
    cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
  const noMenu = () => cdp.eval(`!${MENU}`);
  /** **그 터미널의** host div에 contextmenu — pane(TerminalPane)·모아보기 셀 둘 다 이 경로다.
   *  "보이는 첫 .xterm"으로 고르면 안 된다: 모아보기는 사용자의 터미널을 **전부** 한 화면에
   *  띄우므로 첫 xterm이 남의 셀이고, 그 셀엔 선택이 없어 [복사] 항목이 없다고 오판한다
   *  (실측으로 여기서 한 번 죽었다). host는 attachTerminal이 셀 안으로 옮겨 둔 바로 그 노드다. */
  const rightClick = (paneId) =>
    cdp.eval(`(()=>{
      const inst = window.__gpv.term.get(${J(paneId)});
      const x = (inst && inst.host) || ${VIS_XTERM};
      if (!x || !x.isConnected) return false;
      const rc = x.getBoundingClientRect();
      x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:rc.left+40,clientY:rc.top+40}));
      return true;
    })()`);

  /** 메뉴를 연다 — **닫힘을 먼저 확인하고** 원하는 항목이 보일 때까지 최대 3회 다시 연다.
   *  항목을 클릭한 직후엔 그 메뉴가 아직 떠 있을 수 있고, 그 상태로 곧바로 우클릭하면 새 메뉴가
   *  이전 메뉴의 정리 경로(window click·onClose)에 함께 닫혀 라벨을 못 읽는다 — 스위트 14 #11a가
   *  기록한 그 함정이고, 여기서도 센티널 회차가 그렇게 한 번 통째로 어긋났다. */
  const openMenu = async (paneId, want) => {
    let labels = null;
    for (let i = 0; i < 3; i++) {
      await poll(noMenu, (v) => v === true, 10, 120);
      await rightClick(paneId);
      labels = await poll(
        menuLabels,
        (v) => Array.isArray(v) && v.includes(want),
        8,
        150,
      );
      if (Array.isArray(labels) && labels.includes(want)) break;
    }
    return labels;
  };

  /** 메뉴를 열고 그 항목을 **실제로 눌렀는지까지** 확인한다. 최대 3회 재시도.
   *
   *  `clickMenu` 의 반환을 버리면 안 된다 — 항목을 못 눌렀을 때 나타나는 상태("클립보드 불변,
   *  선택 유지, 토스트 없음")가 **"복사가 실패했지만 조용하지 않았다"는 성공 조건과 세 항목 중
   *  둘이 겹친다.** 실측으로 여기서 한 번 갈렸다: 토스트만 비어 실패했는데 원인은 제품이 아니라
   *  눌리지 않은 클릭이었다. 눌렀는지를 따로 들고 있어야 그 둘이 구분된다. */
  const openAndClick = async (paneId, want) => {
    for (let i = 0; i < 3; i++) {
      const labels = await openMenu(paneId, want);
      if (!Array.isArray(labels) || !labels.includes(want)) continue;
      if ((await clickMenu(want)) === true) return true;
    }
    return false;
  };

  /** 마커 한 줄을 버퍼에 써 넣고 그 줄만 선택한다 — 선택 문자열을 돌려준다.
   *  PTY로 `echo`를 보내지 않는 이유: 셸·프롬프트마다 에코 형태가 달라 단언이 흔들린다
   *  (원시 PTY 채널은 첫 출력이 3.4s까지 늦기도 한다). 복사 경로 검증에 셸은 변수일 뿐이다. */
  const writeAndSelect = (paneId) =>
    cdp.eval(`(async () => {
      const inst = window.__gpv.term.get(${J(paneId)});
      if (!inst) return { err: 'term 인스턴스 없음' };
      const t = inst.term;
      await new Promise((res) => t.write('\\r\\n' + ${J(MARK)} + '\\r\\n', res));
      const b = t.buffer.active;
      const row = b.baseY + b.cursorY - 1;
      t.selectLines(row, row);
      return { sel: t.getSelection(), has: t.hasSelection() };
    })()`);
  const hasSelection = (paneId) =>
    cdp.eval(
      `!!window.__gpv.term.get(${J(paneId)})?.term.hasSelection()`,
    );
  const clearSelection = (paneId) =>
    cdp.eval(
      `(()=>{ window.__gpv.term.get(${J(paneId)})?.term.clearSelection(); return true; })()`,
    );

  const origAggOpen = await uGet("aggregateOpen");
  const origSel = await uGet("selectedProjectId");
  const savedClip = await clipboard();
  let tabId = null;
  let aggChanged = false;

  try {
    // ── 셋업: 픽스처 프로젝트를 **선택**한다 ──
    // 워크스페이스는 선택된 프로젝트의 터미널 탭만 렌더한다 — 선택을 안 옮기면 탭은 스토어에
    // 생기지만 `TerminalPane`이 마운트되지 않아 xterm 인스턴스가 영영 안 붙는다(실측으로 여기서
    // 한 번 죽었다). 픽스처는 원시 invoke로 추가돼 UI 캐시에 없을 수 있어 쿼리를 먼저 갱신한다.
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => uGet("selectedProjectId"),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (!r.check("픽스처 프로젝트 선택(격리 실행)", stuck === fix.projectId, `selected=${String(stuck).slice(0, 8)}`)) {
      return;
    }
    // 모아보기가 열려 있으면 워크스페이스가 통째로 그리드로 바뀐다(App.tsx) — pane 메뉴 단계가
    // 갈 곳을 잃는다. 모아보기 단계는 뒤에서 직접 연다.
    if ((await uGet("aggregateOpen")) === true) {
      await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
      await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 250);
    }

    const opened = await cdp.eval(
      `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
    );
    tabId = opened?.tabId ?? null;
    const paneId = opened?.paneId ?? null;
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, ${J(tabId)})`,
    );
    // xterm 엔진은 동적 import라 첫 터미널에서 청크(~441kB)를 받아 온다 — 인스턴스 등록까지
    // 폴링한다. 화면에 실제로 붙었는지도 함께 본다(등록만 되고 attach가 안 되면 우클릭이 갈 곳이 없다).
    const ready = await poll(
      () =>
        cdp.eval(
          `!!window.__gpv.term.get(${J(paneId)}) && !!${VIS_XTERM}`,
        ),
      (v) => v === true,
      40,
      300,
    );
    if (
      !r.check(
        "픽스처 터미널 생성 · xterm 인스턴스 등록 · 화면 부착",
        ready === true && !!paneId,
        `pane=${String(paneId).slice(0, 12)} 보이는xterm=${await cdp.eval(`!!${VIS_XTERM}`).catch(() => "?")}`,
      )
    ) {
      return;
    }
    // 셸이 프롬프트를 다 뱉은 뒤에 마커를 넣는다 — 뒤늦은 출력이 마커 줄을 밀면 선택이 흔들린다.
    await sleep(1200);

    // ── ② xterm 옵션: 우클릭이 선택을 바꾸지 않는다 ──
    const rcsw = await cdp.eval(
      `window.__gpv.term.get(${J(paneId)}).term.options.rightClickSelectsWord`,
    );
    r.check(
      "우클릭이 선택을 바꾸지 않는다(rightClickSelectsWord=false)",
      rcsw === false,
      `값=${String(rcsw)} — mac 기본값은 true라 선택 밖 우클릭이 단어를 갈아치운다`,
    );

    // ── ③ 워크스페이스 pane 우클릭 → 복사 ──
    await setFail([]);
    const sel1 = await writeAndSelect(paneId);
    const selText = sel1?.sel ?? "";
    r.check(
      "마커 줄 선택됨(복사 대상 확보)",
      selText.includes(MARK),
      `선택=${J(selText).slice(0, 60)}`,
    );

    const paneLabels = await openMenu(paneId, "복사");
    r.check(
      "pane 우클릭 메뉴에 [복사]·[붙여넣기]",
      Array.isArray(paneLabels) &&
        paneLabels.includes("복사") &&
        paneLabels.includes("붙여넣기"),
      `항목=${J(paneLabels)}`,
    );

    const clicked1 = await clickMenu("복사");
    const clip1 = str(await poll(clipboard, (v) => str(v).includes(MARK), 12, 200));
    const cleared = await poll(() => hasSelection(paneId), (v) => v === false, 10, 150);
    r.check(
      "메뉴 [복사] → 클립보드에 선택 텍스트(한글 포함) · 선택 해제로 피드백",
      clicked1 === true && clip1.includes(MARK) && cleared === false,
      `클릭=${clicked1} 클립=${J(clip1).slice(0, 60)} 선택유지=${cleared}`,
    );

    // ── ④ 계층 폴백: 네이티브 플러그인이 죽어도 복사된다 ──
    // Linux에서 플러그인은 앱 시작 시 arboard를 1회만 만들고 실패하면 영구 Err다 — 그 환경을
    // 그대로 흉내 낸다. 브라우저 경로가 받아 내야 한다.
    await cdp.invoke("term_paste").catch(() => {});
    await setFail(["plugin"]);
    await writeAndSelect(paneId);
    const clickedFallback = await openAndClick(paneId, "복사");
    const clip2 = str(await poll(clipboard, (v) => str(v).includes(MARK), 14, 250));
    r.check(
      "네이티브 플러그인 강제 실패 → 브라우저 경로 폴백으로 복사 성공",
      clickedFallback === true && clip2.includes(MARK),
      `클릭=${clickedFallback} 클립=${J(clip2).slice(0, 60)}`,
    );

    // ── ⑤ 전 단계 실패: 클립보드 불변 · 사유 토스트 · 선택 유지 ──
    await setFail([]);
    await cdp.eval(`window.__gpv.ui.getState().toasts.slice().forEach(t => window.__gpv.ui.getState().dismissToast(t.id))`);
    // 센티널을 먼저 클립보드에 박아 "안 바뀌었다"의 기준을 만든다.
    await cdp.eval(
      `(async () => { const t = window.__gpv.term.get(${J(paneId)}).term;
        await new Promise((res) => t.write('\\r\\n' + ${J(SENTINEL)} + '\\r\\n', res));
        const b = t.buffer.active; t.selectLines(b.baseY + b.cursorY - 1, b.baseY + b.cursorY - 1); })()`,
    );
    const clickedSentinel = await openAndClick(paneId, "복사");
    const sentinelSet = str(
      await poll(clipboard, (v) => str(v).includes(SENTINEL), 12, 200),
    );

    await setFail(["plugin", "navigator", "exec"]);
    const sel3 = await writeAndSelect(paneId);
    const clicked = await openAndClick(paneId, "복사");
    const toast = await poll(
      () =>
        cdp.eval(
          `(window.__gpv.ui.getState().toasts.find(t => t.kind === 'error' && /복사에 실패/.test(t.message)) || {}).message || ''`,
        ),
      (v) => typeof v === "string" && v.length > 0,
      14,
      250,
    );
    const clip3 = str(await clipboard());
    const keptSel = await hasSelection(paneId);
    r.check(
      "모든 경로 실패 → 클립보드 불변 · 사유가 담긴 토스트 · 선택 유지(재시도 가능)",
      clicked === true &&
        clip3.includes(SENTINEL) &&
        !clip3.includes(MARK) &&
        /복사에 실패했습니다 — .+/.test(toast) &&
        keptSel === true &&
        (sel3?.sel ?? "").includes(MARK),
      `클릭=${clicked} 센티널클릭=${clickedSentinel} 클립=${J(clip3).slice(0, 40)} 센티널선행=${sentinelSet.includes(SENTINEL)} 토스트=${J(toast)} 선택유지=${keptSel}`,
    );
    await setFail([]);
    await closeMenu();

    // ── ⑥ 선택이 없을 때: 죽은 버튼 대신 안내 ──
    await clearSelection(paneId);
    const emptyLabels = await openMenu(paneId, "붙여넣기");
    const emptyText = (await menuText()) ?? "";
    r.check(
      "선택 없음 → [복사] 항목 없음 · 왜 없는지 안내",
      Array.isArray(emptyLabels) &&
        !emptyLabels.includes("복사") &&
        emptyLabels.includes("붙여넣기") &&
        /선택한 텍스트가 없습니다|Shift\+드래그/.test(emptyText),
      `항목=${J(emptyLabels)} 본문=${J(emptyText.replace(/\s+/g, " ")).slice(0, 80)}`,
    );
    await closeMenu();

    // ── ① 모아보기 셀 우클릭 (핵심 회귀) ──
    // 여기에 두 항목이 없어서 "이 PC에서는 복사가 안 된다"가 났다. 모아보기는 별도 창이 아니라
    // 메인 안 뷰로 연다 — 별도 창이면 PTY 소유권이 넘어가 이 창의 xterm이 멈춘 화면이 된다.
    if ((await uGet("aggregateWindowOpen")) === true) {
      r.skip("모아보기 셀 우클릭 복사", "모아보기가 별도 창에 나가 있음 — 스킵");
    } else {
      await cdp.eval(`window.__gpv.ui.getState().toggleAggregate()`);
      aggChanged = true;
      const aggOn = await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 250);
      // 셀의 xterm은 엔진 청크 로드 뒤 비동기로 붙는다 — 즉시 세면 0이다(스위트 14 #11c).
      // **그 터미널의 host가 실제로 붙어 있고 보이는지** 본다 — 보이는 아무 xterm이 아니라.
      // 칩으로 숨겨진 셀이면 host가 DOM에서 떨어져 있어 우클릭이 아무 핸들러에도 안 닿는다.
      //
      // 조상 클래스(`.closest('.absolute')`)로 재지 않는다. 그건 셀 래퍼가 **지금** 우연히 갖고
      // 있는 Tailwind 유틸리티일 뿐 "보이는 셀 안에 있다"는 뜻이 아니다 — 나중에 배치를 grid나
      // fixed로 바꾸면 가드가 **통과하면서 아무것도 안 걸러** 간헐이 조용히 돌아온다.
      // 붙어 있음(isConnected) + 실제로 레이아웃됨(width > 0)이 재려는 것 자체다.
      // 모아보기가 열려 있으면 워크스페이스는 언마운트라(App.tsx) host가 있을 곳은 셀뿐이다.
      const cellReady = await poll(
        () =>
          cdp.eval(
            `(()=>{ const h = window.__gpv.term.get(${J(paneId)})?.host;
              return !!h && h.isConnected && h.getBoundingClientRect().width > 0; })()`,
          ),
        (v) => v === true,
        20,
        250,
      );
      if (aggOn !== true || cellReady !== true) {
        r.check(
          "모아보기 진입 · 셀 렌더",
          false,
          `open=${aggOn} cell=${cellReady}`,
        );
      } else {
        await sleep(400);
        const sel4 = await writeAndSelect(paneId);
        const cellLabels = await openMenu(paneId, "복사");
        r.check(
          "모아보기 셀 우클릭 메뉴에 [복사]·[붙여넣기] (없었던 항목 — 태스크 65 §2 #1)",
          Array.isArray(cellLabels) &&
            cellLabels.includes("복사") &&
            cellLabels.includes("붙여넣기"),
          `항목=${J(cellLabels)}`,
        );
        await clickMenu("복사");
        const clip4 = str(await poll(clipboard, (v) => str(v).includes(MARK), 14, 250));
        r.check(
          "모아보기 셀 메뉴 [복사] → 클립보드에 그 셀의 선택 텍스트",
          clip4.includes(MARK) && (sel4?.sel ?? "").includes(MARK),
          `클립=${J(clip4).slice(0, 60)}`,
        );
        await closeMenu();
      }
    }
  } finally {
    await setFail([]).catch(() => {});
    await closeMenu().catch(() => {});
    if (aggChanged && origAggOpen !== true) {
      await cdp
        .eval(`window.__gpv.ui.getState().toggleAggregate()`)
        .catch(() => {});
      await poll(() => uGet("aggregateOpen"), (v) => v === false, 10, 200);
    }
    if (tabId) {
      await cdp
        .eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`)
        .catch(() => {});
    }
    if (origSel) {
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    }
    // 사용자의 클립보드를 되돌린다(best-effort) — 우리가 마커로 덮어 놨다.
    if (savedClip) {
      await cdp
        .eval(`navigator.clipboard.writeText(${J(savedClip)}).then(()=>true).catch(()=>false)`)
        .catch(() => false);
    }
  }
}
