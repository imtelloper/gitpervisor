// 할 일 패널(DOCS/memo-todo-category-image-design.md §5·§9) — IPC 왕복(add/update/done/undo/delete) +
// 순수 함수(__gpvTodoDay: 자정 경계는 실제 시계로 못 재니 합성 데이터로) + 전역 메모 팝오버 "할 일" 탭 DOM
// (추가/체크/수정/삭제·배지) + 수정 input 의 Esc 가 팝오버를 닫지 않음 + 메모 탭 타이핑 직후 탭 전환 유실 회귀.
export const name = "할 일 (todos: IPC / 날짜 계산 / 팝오버 탭 / Esc / 탭 전환 flush)";

const IPC_ID = "gpv-e2e-todo-ipc";
const MEMO_ID = "gpv-e2e-todo-memo";
const GLOBAL = "__global__";
const LS_KEYS = ["gp:memo-tab", "gp:memo-md", `gp:memo-active:${GLOBAL}`];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const J = (v) => JSON.stringify(v);

async function poll(fn, ok, tries = 30, ms = 200) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn().catch(() => null);
    if (ok(v)) return v;
    await sleep(ms);
  }
  return v;
}

export async function run({ cdp, report: r }) {
  await ipcBlock({ cdp, r });
  if (!(await cdp.eval(`!!window.__gpv && !!window.__gpvTodoDay`))) {
    r.skip("할 일 날짜 계산·팝오버 DOM", "window.__gpv / __gpvTodoDay 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  await dayMathBlock({ cdp, r });
  await domBlock({ cdp, r });
}

async function ipcBlock({ cdp, r }) {
  try {
    const added = await cdp.invoke("add_todo", { todoId: IPC_ID, text: "ipc 할 일" });
    r.check("add_todo: Todo 반환(미완료)", added?.id === IPC_ID && added?.text === "ipc 할 일" && !added?.doneAt, J(added));
    const listed = (await cdp.invoke("get_todos")).find((t) => t.id === IPC_ID);
    r.check("get_todos: 추가 항목 영속", listed?.text === "ipc 할 일", J(listed));

    const upd = await cdp.invoke("update_todo_text", { todoId: IPC_ID, text: "ipc 수정" });
    r.check("update_todo_text: 글자 반영", upd?.text === "ipc 수정", J(upd));

    const done = await cdp.invoke("set_todo_done", { todoId: IPC_ID, done: true });
    r.check("set_todo_done(true): doneAt 생김", typeof done?.doneAt === "string" && !Number.isNaN(Date.parse(done.doneAt)), J(done));
    const again = await cdp.invoke("set_todo_done", { todoId: IPC_ID, done: true });
    r.check("set_todo_done(true) 두 번: 처음 완료 시각 유지", again?.doneAt === done?.doneAt, `${again?.doneAt} vs ${done?.doneAt}`);
    const undone = await cdp.invoke("set_todo_done", { todoId: IPC_ID, done: false });
    r.check("set_todo_done(false): doneAt 사라짐", undone && !("doneAt" in undone), J(undone));

    await cdp.invoke("delete_todo", { todoId: IPC_ID });
    const gone = !(await cdp.invoke("get_todos")).some((t) => t.id === IPC_ID);
    r.check("delete_todo: 항목 제거됨", gone);
  } finally {
    await cdp.try("delete_todo", { todoId: IPC_ID });
  }
}

/** 순수 함수 — 페이지의 시간대로 계산해야 의미가 있으니 한 번의 eval 안에서 데이터를 만들고 답만 받는다. */
async function dayMathBlock({ cdp, r }) {
  const res = await cdp.eval(`(()=>{
    const T = window.__gpvTodoDay;
    const now = new Date();
    const today = T.localDayKey(now);
    const yesterday = T.shiftDayKey(today, -1);
    const [y, m, d] = today.split('-').map(Number);
    const at = (dd, h, mi, s) => new Date(y, m - 1, d + dd, h, mi, s).toISOString();
    const todos = [
      { id: 'A', text: 'a', createdAt: at(-1, 12, 0, 0) },                               // 어제 만든 미완료
      { id: 'B', text: 'b', createdAt: at(-1, 9, 0, 0), doneAt: at(-1, 23, 59, 30) },     // 어제 자정 직전 완료
      { id: 'D', text: 'd', createdAt: at(-1, 9, 0, 0), doneAt: at(0, 8, 0, 0) },
      { id: 'E', text: 'e', createdAt: at(0, 0, 0, 1), doneAt: at(0, 1, 0, 0) },
      { id: 'C', text: 'c', createdAt: at(-1, 9, 0, 0), doneAt: at(0, 0, 0, 30) },        // 오늘 자정 직후 완료
      { id: 'F', text: 'f', createdAt: at(0, 10, 0, 0) },                                // 오늘 만든 미완료
    ];
    const ids = (xs) => xs.map((t) => t.id).join(',');
    const t0 = T.todosForDay(todos, today, today);
    const t1 = T.todosForDay(todos, yesterday, today);
    const tf = T.todosForDay(todos, T.shiftDayKey(today, 1), today);
    // 독립 구현(Intl)과 대조 — 같은 getFullYear/getDate 로 기대값을 만들면 단언이 항상 참이다.
    const intlKey = (iso) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    const edges = ['2026-03-01T14:59:59Z', '2026-03-01T15:00:00Z', '2026-03-01T23:59:59Z', '2026-03-02T00:00:01Z'];
    return {
      tz: now.getTimezoneOffset(),
      todayOpen: ids(t0.open), todayDone: ids(t0.done),
      yOpen: ids(t1.open), yDone: ids(t1.done),
      futureEmpty: tf.open.length === 0 && tf.done.length === 0,
      daysA: T.todoDaysOpen(todos[0], today),
      daysF: T.todoDaysOpen(todos[5], today),
      daysMonth: T.todoDaysOpen({ id: 'M', text: 'm', createdAt: new Date(2026, 2, 1, 0, 30).toISOString() }, '2026-04-01'),
      daysFuture: T.todoDaysOpen({ id: 'N', text: 'n', createdAt: at(1, 12, 0, 0) }, today),
      edges: edges.map((iso) => [T.localDayKey(new Date(iso)), intlKey(iso)]),
      shifts: [T.shiftDayKey('2026-03-01', -1), T.shiftDayKey('2024-03-01', -1), T.shiftDayKey('2026-12-31', 1), T.shiftDayKey('2026-11-24', 0)],
    };
  })()`);

  r.check("오늘 open: 미완료 전부 배열 순서(어제 만든 A 포함)", res.todayOpen === "A,F", res.todayOpen);
  r.check("오늘 done: 오늘 완료만, 완료 시각 오름차순(C 00:00:30 → E → D)", res.todayDone === "C,E,D", res.todayDone);
  r.check("어제 보기 open: 비어 있음", res.yOpen === "", res.yOpen);
  r.check("어제 done: 자정 직전 완료 B 만", res.yDone === "B", res.yDone);
  r.check("미래 날짜: 빈 결과", res.futureEmpty === true);
  r.check("todoDaysOpen: 어제 만든 항목 = 1", res.daysA === 1, String(res.daysA));
  r.check("todoDaysOpen: 오늘 만든 항목 = 0", res.daysF === 0, String(res.daysF));
  r.check("todoDaysOpen: 03-01 → 04-01 = 31(DST 무관)", res.daysMonth === 31, String(res.daysMonth));
  r.check("todoDaysOpen: 만든 날이 미래면 0", res.daysFuture === 0, String(res.daysFuture));
  r.check(
    "localDayKey: 자정 근처 UTC 시각이 로컬 날짜로(Intl 과 일치)",
    res.edges.every(([a, b]) => a === b),
    J(res.edges),
  );
  if (res.tz === -540)
    r.check(
      "localDayKey(KST): 14:59:59Z=03-01, 15:00Z·23:59:59Z=03-02",
      J(res.edges.map(([a]) => a)) === J(["2026-03-01", "2026-03-02", "2026-03-02", "2026-03-02"]),
      J(res.edges),
    );
  else r.skip("localDayKey(KST) 고정 기대값", `시간대 오프셋 ${res.tz}분 — KST 아님`);
  r.check(
    "shiftDayKey: 월말·윤년·연말·0",
    J(res.shifts) === J(["2026-02-28", "2024-02-29", "2027-01-01", "2026-11-24"]),
    J(res.shifts),
  );
}

async function domBlock({ cdp, r }) {
  const btnExists = await cdp.eval(`!!document.querySelector('[data-global-memo-button]')`);
  if (!btnExists) {
    r.skip("할 일 팝오버 DOM", "타이틀바 메모장 버튼([data-global-memo-button])이 없음 — 스킵");
    return;
  }
  const popoverOpen = () => cdp.eval(`!!document.querySelector('[data-memo-tab]')`);
  const clickMemoButton = () => cdp.eval(`document.querySelector('[data-global-memo-button]').click()`);
  const closePopover = async () => {
    if (await popoverOpen()) await clickMemoButton();
    await poll(popoverOpen, (v) => v === false, 15, 100);
  };
  const refreshTodos = () => cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["todos"] })`);
  const refreshNotes = () => cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);
  const getTodos = () => cdp.invoke("get_todos");
  const ROW = (id) => `document.querySelector('[data-todo-id=${J(id)}]')`;
  // React 가 onChange 를 돌리는 진짜 입력 경로(05 스위트와 같다): 네이티브 value setter + input 이벤트.
  const setValue = (el, value) => `(()=>{ const el=${el}; if(!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${J(value)});
    el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`;
  const key = (el, k, extra = "") =>
    `(()=>{ const el=${el}; if(!el) return false;
      el.dispatchEvent(new KeyboardEvent('keydown',{key:${J(k)},bubbles:true,cancelable:true${extra}})); return true; })()`;
  const ADD = `document.querySelector('[data-todo-add]')`;
  const EDIT = (id) => `${ROW(id)}?.querySelector('input:not([type=checkbox])')`;

  const created = [];
  const saved = await cdp.eval(`(${J(LS_KEYS)}).map((k)=>localStorage.getItem(k))`);
  try {
    await closePopover();
    await refreshTodos();

    // ── 할 일 탭으로 열기 + 탭 기억 ──
    await cdp.eval(`localStorage.setItem("gp:memo-tab","memo")`);
    await clickMemoButton();
    await poll(popoverOpen, (v) => v === true);
    await cdp.eval(`document.querySelector('[data-memo-tab="todo"]').click()`);
    const addShown = await poll(() => cdp.eval(`!!${ADD}`), (v) => v === true);
    r.check("할 일 탭: 추가 입력칸이 뜸", addShown === true, String(addShown));
    r.check("탭 기억: gp:memo-tab=todo", (await cdp.eval(`localStorage.getItem("gp:memo-tab")`)) === "todo");

    // ── 추가: Enter → 추가 + 입력칸 비움. 빈 문자열·조합 중 Enter 는 무시 ──
    const before = (await getTodos()).length;
    await cdp.eval(setValue(ADD, "   "));
    await cdp.eval(key(ADD, "Enter"));
    await cdp.eval(setValue(ADD, "조합중"));
    await cdp.eval(key(ADD, "Enter", ",isComposing:true"));
    await sleep(400);
    r.check("빈 문자열·조합 중 Enter 는 추가하지 않음", (await getTodos()).length === before);

    const TEXT1 = "e2e 할 일 하나";
    const TEXT2 = "e2e 할 일 둘";
    for (const text of [TEXT1, TEXT2]) {
      await cdp.eval(setValue(ADD, text));
      await cdp.eval(key(ADD, "Enter"));
      const t = await poll(async () => (await getTodos()).find((x) => x.text === text), (v) => !!v);
      if (t) created.push(t.id);
      r.check(`추가 영속: "${text}"`, !!t, J(t));
    }
    const [id1, id2] = created;
    r.check("추가 뒤 입력칸 비움", (await cdp.eval(`${ADD}?.value`)) === "");
    const rows = await poll(
      () => cdp.eval(`!!${ROW(id1 ?? "")} && !!${ROW(id2 ?? "")}`),
      (v) => v === true,
    );
    r.check("추가한 두 행이 DOM 에 뜸", rows === true, String(rows));

    // ── 배지: 미완료 개수와 같다 ──
    const badgeOk = async () => {
      const open = (await getTodos()).filter((t) => !t.doneAt).length;
      const shown = await cdp.eval(`document.querySelector('[data-todo-badge]')?.textContent ?? null`);
      return { open, shown, ok: open === 0 ? shown === null : shown === String(open) };
    };
    let b = await poll(badgeOk, (v) => v?.ok);
    r.check("배지 = 미완료 개수", b?.ok === true, J(b));

    // ── 체크 → 완료(완료 구획으로) / 해제 ──
    await cdp.eval(`${ROW(id1)}.querySelector('input[type=checkbox]').click()`);
    const doneAt = await poll(async () => (await getTodos()).find((t) => t.id === id1)?.doneAt, (v) => !!v);
    r.check("체크 → doneAt 영속", !!doneAt, String(doneAt));
    r.check("체크박스 checked", (await cdp.eval(`${ROW(id1)}?.querySelector('input[type=checkbox]')?.checked`)) === true);
    b = await poll(badgeOk, (v) => v?.ok);
    r.check("완료 뒤 배지도 줄어듦", b?.ok === true, J(b));
    await cdp.eval(`${ROW(id1)}.querySelector('input[type=checkbox]').click()`);
    const undone = await poll(async () => (await getTodos()).find((t) => t.id === id1), (v) => v && !v.doneAt);
    r.check("체크 해제 → doneAt 사라짐", !!undone && !undone.doneAt, J(undone));

    // ── 글자 클릭 → 수정 input, Enter 저장 ──
    await cdp.eval(`${ROW(id1)}.querySelector('span').click()`);
    await poll(() => cdp.eval(`!!${EDIT(id1)}`), (v) => v === true);
    await cdp.eval(setValue(EDIT(id1), "e2e 수정됨"));
    await cdp.eval(key(EDIT(id1), "Enter"));
    const edited = await poll(async () => (await getTodos()).find((t) => t.id === id1)?.text, (v) => v === "e2e 수정됨");
    r.check("수정 Enter → 글자 영속", edited === "e2e 수정됨", String(edited));

    // ── 수정 input 의 Esc: 취소만 하고 팝오버는 닫지 않는다 ──
    await cdp.eval(`${ROW(id1)}.querySelector('span').click()`);
    await poll(() => cdp.eval(`!!${EDIT(id1)}`), (v) => v === true);
    await cdp.eval(setValue(EDIT(id1), "저장되면 안 됨"));
    await cdp.eval(key(EDIT(id1), "Escape"));
    const editGone = await poll(() => cdp.eval(`!${EDIT(id1)}`), (v) => v === true, 15, 100);
    r.check("수정 Esc → input 닫힘(취소)", editGone === true);
    await sleep(300);
    r.check("수정 Esc → 팝오버는 열린 채", (await popoverOpen()) === true);
    r.check(
      "수정 Esc → 글자 그대로",
      (await getTodos()).find((t) => t.id === id1)?.text === "e2e 수정됨",
    );

    // ── 비우고 Enter → 삭제 ──
    await cdp.eval(`${ROW(id1)}.querySelector('span').click()`);
    await poll(() => cdp.eval(`!!${EDIT(id1)}`), (v) => v === true);
    await cdp.eval(setValue(EDIT(id1), "  "));
    await cdp.eval(key(EDIT(id1), "Enter"));
    const del1 = await poll(async () => !(await getTodos()).some((t) => t.id === id1), (v) => v === true);
    r.check("비우고 Enter → 삭제", del1 === true);

    // ── hover 삭제 버튼 ──
    await cdp.eval(`${ROW(id2)}.querySelector('button').click()`);
    const del2 = await poll(async () => !(await getTodos()).some((t) => t.id === id2), (v) => v === true);
    r.check("삭제 버튼 → 삭제", del2 === true);
    const rowGone = await poll(() => cdp.eval(`!${ROW(id2)}`), (v) => v === true, 15, 100);
    r.check("삭제한 행이 DOM 에서 사라짐", rowGone === true);

    // 대조군: 같은 Esc 가 빈 추가 입력칸에서는 팝오버를 닫는다 — 위 "열린 채" 단언이 Esc 자체가 안 먹어서
    // 참이 된 게 아님을 보인다.
    await cdp.eval(setValue(ADD, ""));
    await cdp.eval(key(ADD, "Escape"));
    const closed = await poll(popoverOpen, (v) => v === false, 15, 100);
    r.check("대조: 빈 추가 입력칸의 Esc 는 팝오버를 닫음", closed === false);

    await tabFlushBlock({ cdp, r, popoverOpen, clickMemoButton, closePopover, refreshNotes });
  } finally {
    await closePopover().catch(() => {});
    for (const id of created) await cdp.try("delete_todo", { todoId: id });
    await cdp.try("delete_memo", { projectId: GLOBAL, memoId: MEMO_ID });
    await cdp
      .eval(`(${J(LS_KEYS)}).forEach((k,i)=>{ const v=(${J(saved)})[i]; if(v===null) localStorage.removeItem(k); else localStorage.setItem(k,v); })`)
      .catch(() => {});
    await refreshTodos().catch(() => {});
    await refreshNotes().catch(() => {});
  }
}

/** 메모 탭에서 친 직후(디바운스 500ms 안) "할 일" 탭으로 바꿔도 본문이 저장돼야 한다(§5 — 탭 전환 전 flush). */
async function tabFlushBlock({ cdp, r, popoverOpen, clickMemoButton, closePopover, refreshNotes }) {
  const TEXT = "탭 전환 직전 입력";
  await closePopover();
  await cdp.invoke("add_memo", { projectId: GLOBAL, memoId: MEMO_ID });
  await refreshNotes();
  await cdp.eval(`localStorage.setItem("gp:memo-tab","memo");
    localStorage.removeItem("gp:memo-md");
    localStorage.setItem(${J(`gp:memo-active:${GLOBAL}`)}, ${J(MEMO_ID)});`);
  await clickMemoButton();
  await poll(popoverOpen, (v) => v === true);
  const IN = `document.querySelector('[data-memo-tab]')?.closest('.fixed')`;
  // 편집기(CodeMirror)가 그 빈 메모를 싣고 뜰 때까지 기다린다 — dev 훅 __gpvMemoEditor(MemoEditor.tsx).
  const mounted = await poll(
    () => cdp.eval(`${IN}?.querySelector('.cm-content') ? (window.__gpvMemoEditor?.doc() ?? null) : null`),
    (v) => v === "",
  );
  if (mounted !== "") {
    r.check("탭 전환 flush: 빈 메모를 실은 편집기가 뜸", false, J(mounted));
    return;
  }
  // 같은 eval 안에서 입력과 탭 전환 — 디바운스(500ms)도, 입력을 draft 로 옮기는 렌더도 먼저 돌지 못한다.
  // (flush 가 draft 가 아니라 편집기 문서에서 본문을 읽어야 통과한다.)
  await cdp.eval(`(()=>{ window.__gpvMemoEditor.type(${J(TEXT)});
    document.querySelector('[data-memo-tab="todo"]').click(); })()`);
  const stored = await poll(
    async () => ((await cdp.invoke("get_notes"))?.[GLOBAL] || []).find((m) => m.id === MEMO_ID)?.text,
    (v) => v === TEXT,
    15,
    200,
  );
  r.check("메모 타이핑 직후 할 일 탭 전환 → get_notes 에 본문 남음", stored === TEXT, String(stored));
}
