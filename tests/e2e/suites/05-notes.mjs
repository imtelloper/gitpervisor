// 프로젝트 메모 — get_notes, add_memo, update_memo, delete_memo (낙관적 백엔드 영속) +
// 메모장 목록 드래그 정렬(reorder_memos, 태스크 57). 드래그는 포인터 이벤트를 CDP eval로 합성한다.
export const name =
  "프로젝트 메모 (notes: add / update / delete / 드래그 정렬)";

const MEMO_ID = "gpv-e2e-memo-1";
// MD 모드 절 전용 — 제목·GFM 체크박스가 모두 들어간 본문이라 렌더 여부를 두 갈래로 본다.
const MD_ID = "gpv-e2e-memo-md";
const MD_TEXT = "# 제목\n\n- [ ] 할 일";
// ⑥ 전용 — 빈 본문 규칙으로 뜬 입력칸에서 첫 글자를 쳐도 렌더 뷰로 튕기지 않는지 본다.
const MD_EMPTY_ID = "gpv-e2e-memo-md-empty";
// 드래그 절 전용 — 추가 순서 A,B,C(배열 순서) → 표시는 그 역순 C,B,A
const DRAG_IDS = { a: "gpv-e2e-memo-a", b: "gpv-e2e-memo-b", c: "gpv-e2e-memo-c" };
const NEW_ID = "gpv-e2e-memo-d";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export async function run({ cdp, report: r, fix }) {
  try {
  // ── add_memo ──
  const memo = await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  r.check("add_memo: Memo 반환(빈 텍스트)", memo?.id === MEMO_ID && memo?.text === "", `id=${memo?.id}`);

  let notes = await cdp.invoke("get_notes");
  r.check("get_notes: 픽스처 메모 등록됨", (notes?.[fix.projectId] || []).some((m) => m.id === MEMO_ID));

  // ── update_memo ──
  const updated = await cdp.invoke("update_memo", { projectId: fix.projectId, memoId: MEMO_ID, text: "hello e2e" });
  r.check("update_memo: 텍스트 반영", updated?.text === "hello e2e", updated?.text);
  notes = await cdp.invoke("get_notes");
  const stored = (notes?.[fix.projectId] || []).find((m) => m.id === MEMO_ID);
  r.check("get_notes: 수정 텍스트 영속", stored?.text === "hello e2e");

  // ── delete_memo ──
  await cdp.invoke("delete_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  notes = await cdp.invoke("get_notes");
  r.check("delete_memo: 메모 제거됨", !(notes?.[fix.projectId] || []).some((m) => m.id === MEMO_ID));
  } finally {
    // 스위트가 도중에 throw 해도 메모를 남기지 않는다(영속 정리, 멱등).
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  }

  await reorderBlock({ cdp, r, fix });
  await mdModeBlock({ cdp, r, fix });
}

/**
 * 메모장 목록 드래그 정렬 — 배열 순서가 정본이고 표시는 그 역순이라는 규칙(태스크 57 §3.1)까지 함께 본다.
 * 목록 UI가 필요하므로 dev 노출 스토어(window.__gpv)로 메모장을 열고 포인터 이벤트를 합성한다.
 */
async function reorderBlock({ cdp, r, fix }) {
  const J = (v) => JSON.stringify(v);
  if (!(await cdp.eval(`!!window.__gpv`))) {
    r.skip("메모 드래그 정렬", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  const poll = async (fn, ok, tries = 30, ms = 200) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  // 목록 행(표시 순서)의 id·제목. 메모장이 닫혀 있으면 빈 문자열.
  const domIds = () =>
    cdp.eval(
      `[...document.querySelectorAll('[data-memo-id]')].map(el=>el.dataset.memoId).join(',')`,
    );
  const domTitles = () =>
    cdp.eval(
      `[...document.querySelectorAll('[data-memo-id]')].map(el=>el.querySelector('div')?.textContent).join(',')`,
    );
  // notes.json에 저장된 배열 순서(정본)의 본문.
  const storedTexts = async () =>
    ((await cdp.invoke("get_notes"))?.[fix.projectId] || [])
      .map((m) => m.text)
      .join(",");
  const setMemoOpen = (open) =>
    cdp.eval(`window.__gpv.ui.getState().setMemoOpen(${open})`);
  const refreshNotes = () =>
    cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  try {
    // ── 준비: A,B,C 순으로 추가(=배열 순서) 후 픽스처 프로젝트의 메모장을 연다 ──
    for (const [key, id] of Object.entries(DRAG_IDS)) {
      await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: id });
      await cdp.invoke("update_memo", {
        projectId: fix.projectId,
        memoId: id,
        text: key.toUpperCase(),
      });
    }
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await refreshNotes();
    await setMemoOpen(true);

    const shown = await poll(domTitles, (v) => v === "C,B,A");
    r.check("표시 순서: 배열의 역순(새 메모가 위)", shown === "C,B,A", shown);
    r.check("정본 배열은 추가 순서 그대로", (await storedTexts()) === "A,B,C");

    // ── C 행을 목록 맨 아래로 드래그 ──
    const dragged = await cdp.eval(`(()=>{
      const rows=[...document.querySelectorAll('[data-memo-id]')];
      const src=rows.find(el=>el.dataset.memoId===${J(DRAG_IDS.c)});
      const last=rows[rows.length-1];
      if(!src||!last) return false;
      const s=src.getBoundingClientRect(), l=last.getBoundingClientRect();
      const x=s.left+5;
      const ev=(y,buttons)=>({bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,
        button:0,buttons,pointerId:1057,pointerType:'mouse',isPrimary:true});
      src.dispatchEvent(new PointerEvent('pointerdown',ev(s.top+s.height/2,1)));
      window.dispatchEvent(new PointerEvent('pointermove',ev(s.top+s.height/2+8,1)));  // 임계 초과 → 드래그 시작
      window.dispatchEvent(new PointerEvent('pointermove',ev(l.bottom-1,1)));          // 마지막 행 중점 아래 = 꼬리 삽입
      window.dispatchEvent(new PointerEvent('pointerup',ev(l.bottom-1,0)));
      return true;
    })()`);
    r.check("드래그 포인터 시퀀스 디스패치", dragged === true);

    const afterDom = await poll(domIds, (v) => v === `${DRAG_IDS.b},${DRAG_IDS.a},${DRAG_IDS.c}`);
    r.check("표시 순서 변경됨(B,A,C)", afterDom === `${DRAG_IDS.b},${DRAG_IDS.a},${DRAG_IDS.c}`, afterDom);
    const afterStored = await poll(storedTexts, (v) => v === "C,A,B");
    r.check("정본 배열은 표시의 역순으로 영속(C,A,B)", afterStored === "C,A,B", afterStored);

    // ── 닫았다 다시 열어도 순서 유지 ──
    await setMemoOpen(false);
    await poll(domIds, (v) => v === "");
    await setMemoOpen(true);
    const reopened = await poll(domIds, (v) => v === `${DRAG_IDS.b},${DRAG_IDS.a},${DRAG_IDS.c}`);
    r.check("다시 열어도 순서 유지", reopened === `${DRAG_IDS.b},${DRAG_IDS.a},${DRAG_IDS.c}`, reopened);

    // ── 새 메모는 여전히 맨 위 ──
    await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: NEW_ID });
    await refreshNotes();
    const withNew = await poll(domIds, (v) => (v || "").split(",")[0] === NEW_ID);
    r.check("새 메모는 맨 위", (withNew || "").split(",")[0] === NEW_ID, withNew);
    await cdp.invoke("delete_memo", { projectId: fix.projectId, memoId: NEW_ID });
    await refreshNotes();
    await poll(domIds, (v) => !(v || "").includes(NEW_ID));

    // ── 임계(5px) 미달은 그대로 클릭 = 선택 ──
    const clicked = await cdp.eval(`(()=>{
      const el=[...document.querySelectorAll('[data-memo-id]')].find(e=>e.dataset.memoId===${J(DRAG_IDS.a)});
      if(!el) return false;
      const b=el.getBoundingClientRect(), x=b.left+5, y=b.top+b.height/2;
      const ev=(dy,buttons)=>({bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y+dy,
        button:0,buttons,pointerId:1058,pointerType:'mouse',isPrimary:true});
      el.dispatchEvent(new PointerEvent('pointerdown',ev(0,1)));
      window.dispatchEvent(new PointerEvent('pointermove',ev(3,1)));
      window.dispatchEvent(new PointerEvent('pointerup',ev(3,0)));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return true;
    })()`);
    r.check("3px 이동 포인터 시퀀스 디스패치", clicked === true);
    const selected = await poll(
      () =>
        cdp.eval(
          `document.querySelector('[data-memo-id=${J(DRAG_IDS.a)}]')?.className.includes('bg-selection') ?? null`,
        ),
      (v) => v === true,
      15,
      200,
    );
    r.check("임계 미달 = 클릭(그 메모가 선택됨)", selected === true, String(selected));
    const unchanged = await domIds();
    r.check(
      "임계 미달은 순서 불변",
      unchanged === `${DRAG_IDS.b},${DRAG_IDS.a},${DRAG_IDS.c}`,
      unchanged,
    );
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(false)`).catch(() => {});
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    for (const id of [...Object.values(DRAG_IDS), NEW_ID])
      await cdp.try("delete_memo", { projectId: fix.projectId, memoId: id });
    // 메모장을 열면 스코프별 "마지막 본 메모" 키가 생긴다 — 픽스처는 매 실행 새로 만들어지므로
    // 안 지우면 실행마다 죽은 키가 하나씩 쌓인다.
    await cdp
      .eval(`localStorage.removeItem(${J("gp:memo-active:" + fix.projectId)})`)
      .catch(() => {});
    await refreshNotes().catch(() => {});
  }
}

/**
 * 메모장 MD 모드 — 본문을 마크다운으로 렌더해서 보고, 클릭하면 편집으로 돌아온다.
 * 켜짐 여부는 localStorage("gp:memo-md") 하나로 스코프 공통이고, "지금 편집 중"은 영속하지 않는다.
 */
async function mdModeBlock({ cdp, r, fix }) {
  const J = (v) => JSON.stringify(v);
  if (!(await cdp.eval(`!!window.__gpv`))) {
    r.skip("메모장 MD 모드", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  const poll = async (fn, ok, tries = 30, ms = 200) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  // 단언은 **메모장 모달 안**으로 한정한다 — 커밋 폼 등 바깥 textarea를 잘못 집으면
  // "textarea 없음" 단언이 통째로 무의미해진다.
  const IN = `document.querySelector('[data-memo-id]')?.closest('.fixed')`;
  const MD_BTN = `${IN}?.querySelector('button[title^="Markdown 모드"]')`;
  const taValue = () =>
    cdp.eval(`${IN}?.querySelector('textarea')?.value ?? null`);
  const noTextarea = () => cdp.eval(`!${IN}?.querySelector('textarea')`);
  const renderedH1 = () =>
    cdp.eval(`${IN}?.querySelector('.md-body h1')?.textContent ?? null`);
  const setMemoOpen = (open) =>
    cdp.eval(`window.__gpv.ui.getState().setMemoOpen(${open})`);
  const refreshNotes = () =>
    cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);

  // 모드는 마운트 때 localStorage에서 읽으므로 **메모장을 열기 전에** 초기화한다.
  await cdp.eval(`localStorage.removeItem("gp:memo-md")`);
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  try {
    await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: MD_ID });
    await cdp.invoke("update_memo", {
      projectId: fix.projectId,
      memoId: MD_ID,
      text: MD_TEXT,
    });
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await refreshNotes();
    await setMemoOpen(true);

    const row = await poll(
      () => cdp.eval(`!!document.querySelector('[data-memo-id=${J(MD_ID)}]')`),
      (v) => v === true,
    );
    r.check("MD 절: 대상 메모가 목록에 뜸", row === true, String(row));
    await cdp.eval(`document.querySelector('[data-memo-id=${J(MD_ID)}]').click()`);

    // ① 기본은 지금까지와 같은 텍스트 모드
    const v1 = await poll(taValue, (v) => v === MD_TEXT);
    r.check("① 기본은 텍스트 모드 — textarea에 본문 그대로", v1 === MD_TEXT, J(v1));

    // ② MD 켜면 렌더된 본문
    await cdp.eval(`${MD_BTN}.click()`);
    const h1 = await poll(renderedH1, (v) => v === "제목");
    r.check("② MD 켬 — 제목이 h1으로 렌더됨", h1 === "제목", String(h1));
    const cb = await cdp.eval(
      `!!${IN}?.querySelector('.md-body input[type=checkbox]')`,
    );
    r.check("② MD 켬 — GFM 작업 목록이 체크박스로 렌더됨", cb === true, String(cb));
    r.check("② MD 켬 — textarea 사라짐", (await noTextarea()) === true);
    const ls2 = await cdp.eval(`localStorage.getItem("gp:memo-md")`);
    r.check("② MD 켬 — 설정 영속(gp:memo-md=1)", ls2 === "1", String(ls2));

    // ③ 렌더 본문을 클릭하면 편집으로
    await cdp.eval(`${IN}.querySelector('.md-body').click()`);
    const v3 = await poll(taValue, (v) => v === MD_TEXT);
    r.check("③ 렌더 본문 클릭 — textarea 복귀(값 동일)", v3 === MD_TEXT, J(v3));
    const focused = await poll(
      () =>
        cdp.eval(`document.activeElement === (${IN}?.querySelector('textarea'))`),
      (v) => v === true,
      15,
      100,
    );
    r.check("③ 렌더 본문 클릭 — 그 textarea로 포커스 이동", focused === true, String(focused));

    // ④ 포커스가 빠지면 다시 렌더.
    // blur()만으로는 부족하다 — e2e 창은 OS 포커스가 없어(document.hasFocus() === false)
    // Blink가 프로그램 blur의 blur/focusout 디스패치를 통째로 삼킨다(activeElement만 body로
    // 옮겨간다). React의 onBlur는 루트의 focusout을 듣기 때문에 위 드래그 절의 PointerEvent와
    // 같은 방식으로 이벤트를 합성해 준다 — 핸들러·상태 전이·DOM은 전부 진짜다.
    await cdp.eval(`(()=>{
      const ta=${IN}.querySelector('textarea');
      ta.blur();
      ta.dispatchEvent(new FocusEvent('focusout',{bubbles:true,composed:true,relatedTarget:null}));
    })()`);
    const h4 = await poll(renderedH1, (v) => v === "제목");
    r.check("④ 포커스 이탈 — 다시 렌더된 본문", h4 === "제목", String(h4));
    r.check("④ 포커스 이탈 — textarea 사라짐", (await noTextarea()) === true);

    // ⑥ MD 켜진 채 **빈** 메모를 고르면 입력칸이 보이고, 첫 글자를 쳐도 렌더 뷰로 튕기지 않는다.
    // 빈 본문 규칙으로 뜬 입력칸은 editing이 꺼져 있어, 타이핑을 편집으로 치지 않으면
    // 첫 글자가 들어가는 순간 "비지 않음 + 편집 아님"이 되어 렌더로 넘어갔다(리뷰에서 잡은 결함).
    await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: MD_EMPTY_ID });
    await refreshNotes();
    const row6 = await poll(
      () => cdp.eval(`!!document.querySelector('[data-memo-id=${J(MD_EMPTY_ID)}]')`),
      (v) => v === true,
    );
    r.check("⑥ 빈 메모가 목록에 뜸", row6 === true, String(row6));
    await cdp.eval(`document.querySelector('[data-memo-id=${J(MD_EMPTY_ID)}]').click()`);
    const v6a = await poll(taValue, (v) => v === "");
    r.check("⑥ MD 켠 채 빈 메모 선택 — 입력칸(빈 값)", v6a === "", J(v6a));
    // React가 onChange를 돌리는 진짜 입력 경로: 네이티브 value setter + input 이벤트
    // (value 프로퍼티에 바로 대입하면 React의 값 추적기가 변화를 못 본다).
    await cdp.eval(`(()=>{
      const ta=${IN}.querySelector('textarea');
      const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(ta,'a'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(300);
    const v6b = await taValue();
    r.check("⑥ 첫 글자 입력 뒤에도 입력칸이 남음(렌더로 튕기지 않음)", v6b === "a", J(v6b));
    // 다른 메모로 옮기면 편집 중이 풀려 렌더 뷰부터 본다 — ⑤가 기대하는 상태이기도 하다.
    await cdp.eval(`document.querySelector('[data-memo-id=${J(MD_ID)}]').click()`);
    const h6 = await poll(renderedH1, (v) => v === "제목");
    r.check("⑥ 다른 메모로 옮기면 다시 렌더 뷰", h6 === "제목", String(h6));

    // ⑤ MD 끄면 원래대로
    await cdp.eval(`${MD_BTN}.click()`);
    const v5 = await poll(taValue, (v) => v === MD_TEXT);
    r.check("⑤ MD 끔 — textarea 복귀", v5 === MD_TEXT, J(v5));
    const ls5 = await poll(
      () => cdp.eval(`localStorage.getItem("gp:memo-md") === null`),
      (v) => v === true,
    );
    r.check("⑤ MD 끔 — 설정 제거됨", ls5 === true, String(ls5));
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(false)`).catch(() => {});
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: MD_ID });
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: MD_EMPTY_ID });
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await cdp.eval(`localStorage.removeItem("gp:memo-md")`).catch(() => {});
    await cdp
      .eval(`localStorage.removeItem(${J("gp:memo-active:" + fix.projectId)})`)
      .catch(() => {});
    await refreshNotes().catch(() => {});
  }
}
