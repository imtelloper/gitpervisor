// 프로젝트 메모 — get_notes, add_memo, update_memo, delete_memo (낙관적 백엔드 영속) +
// 메모장 목록 드래그 정렬(reorder_memos, 태스크 57). 드래그는 포인터 이벤트를 CDP eval로 합성한다.
export const name =
  "프로젝트 메모 (notes: add / update / delete / 드래그 정렬)";

const MEMO_ID = "gpv-e2e-memo-1";
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
