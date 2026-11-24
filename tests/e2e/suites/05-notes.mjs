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
  await sortCategoryBlock({ cdp, r, fix });
  await otherWindowEditBlock({ cdp, r, fix });
  await imageBlock({ cdp, r, fix });
}

// 이미지 절 전용.
const IMAGE_MEMO_ID = "gpv-e2e-memo-image";
const IMAGE_MEMO_TEXT = "image memo\n";

/**
 * 메모 이미지 — 붙여넣은 그림이 AVIF 로 앱 데이터에 저장되고, 본문에는 토큰만 남으며, 핸들을 끌면 토큰의 표시 폭이
 * 바뀐다(DOCS/memo-todo-category-image-design.md §7). 저장된 파일은 지우는 커맨드가 없다 — 앱 시작 때의 정리가
 * 거두고, e2e 샤드는 데이터 폴더가 회차마다 새 임시 폴더라 쌓이지 않는다.
 */
async function imageBlock({ cdp, r, fix }) {
  const J = (v) => JSON.stringify(v);
  if (!(await cdp.eval(`!!window.__gpv`))) {
    r.skip("메모 이미지", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
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
  const IN = `document.querySelector('[data-memo-id]')?.closest('.fixed')`;
  const MD_BTN = `${IN}?.querySelector('button[title^="Markdown 모드"]')`;
  const editorDoc = () =>
    cdp.eval(`${IN}?.querySelector('.cm-editor') ? (window.__gpvMemoEditor?.doc() ?? null) : null`);
  const refreshNotes = () =>
    cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);
  const storedText = async () =>
    ((await cdp.invoke("get_notes"))?.[fix.projectId] || []).find((m) => m.id === IMAGE_MEMO_ID)?.text ?? null;
  const TOKEN = /!\[\]\(memo-img\/([0-9a-f-]{36})\.avif(?:#w=(\d+))?\)/;
  // 스크린샷 꼴 PNG 를 페이지 안에서 만들어 붙여넣기 이벤트에 싣는다. withText 면 글자도 같이 싣는다.
  const pasteImage = (withText) =>
    cdp.eval(`(async()=>{
      const c=document.createElement('canvas'); c.width=640; c.height=360;
      const x=c.getContext('2d'); x.fillStyle='#1e1f22'; x.fillRect(0,0,640,360);
      x.fillStyle='#3574f0'; x.fillRect(40,40,200,120);
      const blob=await new Promise(res=>c.toBlob(res,'image/png'));
      const dt=new DataTransfer(); dt.items.add(new File([blob],'shot.png',{type:'image/png'}));
      ${withText ? "dt.setData('text/plain','copied text');" : ""}
      ${IN}.querySelector('.cm-content').dispatchEvent(
        new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      return blob.size;
    })()`);

  await cdp.eval(`localStorage.removeItem("gp:memo-md"); localStorage.removeItem("gp:memo-sort")`);
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  try {
    // 커맨드의 id 검사 — id 가 그대로 파일 경로가 된다.
    const invokeErr = (id) =>
      cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('note_image_get',{id:${J(id)}}).then(()=>'ok', e=>e?.code ?? String(e))`,
      );
    r.check("note_image_get: 없는 id 는 NOT_FOUND", (await invokeErr("00000000-0000-4000-8000-000000000000")) === "NOT_FOUND");
    const traversal = await invokeErr("../notes");
    r.check("note_image_get: 경로 꼴 id 는 거절(읽지 않음)", traversal !== "ok" && traversal !== "NOT_FOUND", String(traversal));

    await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: IMAGE_MEMO_ID });
    await cdp.invoke("update_memo", { projectId: fix.projectId, memoId: IMAGE_MEMO_ID, text: IMAGE_MEMO_TEXT });
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await refreshNotes();
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(true)`);
    await poll(
      () => cdp.eval(`!!document.querySelector('[data-memo-id=${J(IMAGE_MEMO_ID)}]')`),
      (v) => v === true,
    );
    await cdp.eval(`document.querySelector('[data-memo-id=${J(IMAGE_MEMO_ID)}]').click()`);
    const opened = await poll(editorDoc, (v) => v === IMAGE_MEMO_TEXT);
    r.check("이미지 절: 대상 메모가 편집기에 뜸", opened === IMAGE_MEMO_TEXT, J(opened));

    // 글자가 같이 실린 붙여넣기(Excel 셀·Word 글이 그렇다)는 글자로 붙는다.
    await pasteImage(true);
    const asText = await poll(editorDoc, (v) => !!v?.includes("copied text"), 15);
    r.check(
      "글자+이미지 붙여넣기 — 글자로 붙고 이미지 토큰은 없음",
      !!asText?.includes("copied text") && !TOKEN.test(asText ?? ""),
      J(asText),
    );

    const pngBytes = await pasteImage(false);
    const withToken = await poll(editorDoc, (v) => TOKEN.test(v ?? ""), 15);
    const imageId = TOKEN.exec(withToken ?? "")?.[1] ?? null;
    r.check("이미지 붙여넣기 — 본문에 토큰이 들어감", !!imageId, J(withToken));
    if (!imageId) return;
    const W = `document.querySelector('[data-memo-image=${J(imageId)}]')`;
    // 인코딩은 Worker 에서 돈다 — 첫 호출은 WASM 로드까지 걸린다.
    const state = await poll(() => cdp.eval(`${W}?.dataset.state ?? null`), (v) => v === "ready" || v === "missing", 150, 200);
    r.check("변환·저장 뒤 위젯이 그림으로 바뀜", state === "ready", String(state));
    const file = await cdp.eval(
      `window.__TAURI_INTERNALS__.invoke('note_image_get',{id:${J(imageId)}}).then(b=>{const u=new Uint8Array(b);return {len:u.length,head:String.fromCharCode(...u.slice(4,12))}}, e=>({err:e?.code ?? String(e)}))`,
    );
    r.check("저장된 파일이 AVIF", file?.head === "ftypavif" && file?.len > 0, `${J(file)} (원본 PNG ${pngBytes}B)`);
    const saved = await poll(storedText, (v) => TOKEN.exec(v ?? "")?.[1] === imageId, 20, 150);
    r.check("토큰이 든 본문이 저장됨", TOKEN.exec(saved ?? "")?.[1] === imageId, J(saved));

    // 핸들을 왼쪽으로 100px — 끄는 동안은 DOM 폭만, 놓을 때 토큰의 #w= 가 바뀐다.
    const before = await cdp.eval(`Math.round(${W}.querySelector('img').getBoundingClientRect().width)`);
    await cdp.eval(`(()=>{
      const h=${W}.querySelector('.cm-memo-image-handle'); const b=h.getBoundingClientRect();
      const x=b.left+b.width/2, y=b.top+b.height/2;
      const ev=(cx,buttons)=>({bubbles:true,cancelable:true,composed:true,clientX:cx,clientY:y,
        button:0,buttons,pointerId:1060,pointerType:'mouse',isPrimary:true});
      h.dispatchEvent(new PointerEvent('pointerdown',ev(x,1)));
      window.dispatchEvent(new PointerEvent('pointermove',ev(x-100,1)));
      window.dispatchEvent(new PointerEvent('pointerup',ev(x-100,0)));
    })()`);
    const resized = await poll(editorDoc, (v) => !!TOKEN.exec(v ?? "")?.[2], 15);
    const width = Number(TOKEN.exec(resized ?? "")?.[2] ?? 0);
    r.check("핸들 드래그 — 토큰의 표시 폭이 끈 만큼 줄어듦", width === before - 100, `${before} → ${width}`);
    const shown = await cdp.eval(
      `(()=>{const w=${W}; return w ? {state:w.dataset.state, cw:Math.round(w.querySelector('img').getBoundingClientRect().width)} : null})()`,
    );
    r.check("폭이 바뀌어도 같은 그림이 그대로(다시 불러오지 않음)", shown?.state === "ready" && shown?.cw === width, J(shown));
    const savedW = await poll(storedText, (v) => TOKEN.exec(v ?? "")?.[2] === String(width), 20, 150);
    r.check("바뀐 폭이 저장됨", TOKEN.exec(savedW ?? "")?.[2] === String(width), J(savedW));

    // MD 보기에서도 같은 그림이 같은 폭으로 보인다.
    await cdp.eval(`${MD_BTN}.click()`);
    const md = await poll(
      () =>
        cdp.eval(
          `(()=>{const i=${IN}?.querySelector('.md-body img'); return i&&i.complete&&i.naturalWidth ? {blob:i.src.startsWith('blob:'), w:Math.round(i.getBoundingClientRect().width)} : null})()`,
        ),
      (v) => !!v,
      40,
    );
    r.check("MD 보기 — 그림이 보이고 폭이 같음", md?.blob === true && md?.w === width, J(md));
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(false)`).catch(() => {});
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: IMAGE_MEMO_ID });
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await cdp
      .eval(
        `localStorage.removeItem("gp:memo-md"); localStorage.removeItem(${J("gp:memo-active:" + fix.projectId)})`,
      )
      .catch(() => {});
    await refreshNotes().catch(() => {});
  }
}

// 정렬·카테고리 절 전용 — 추가 순서 X,Y,Z. 본문(=제목)은 가나다순이 추가 순서와 다르게 고른다.
const SORT_IDS = { x: "gpv-e2e-memo-sort-x", y: "gpv-e2e-memo-sort-y", z: "gpv-e2e-memo-sort-z" };
const SORT_TEXTS = { x: "bbb", y: "aaa", z: "ccc" };
// 다른 창이 채운 메모 절 전용.
const OTHER_WIN_ID = "gpv-e2e-memo-other-window";

/**
 * 정렬은 **표시만** 바꾸고 정본 배열(수동 순서)은 그대로다. 카테고리는 메모에 붙은 이름에서 도출되고,
 * 활성 메모는 필터 밖으로 나가도 유지된다(DOCS/memo-todo-category-image-design.md §4).
 */
async function sortCategoryBlock({ cdp, r, fix }) {
  const J = (v) => JSON.stringify(v);
  if (!(await cdp.eval(`!!window.__gpv`))) {
    r.skip("메모 정렬·카테고리", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
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
  const IN = `document.querySelector('[data-memo-id]')?.closest('.fixed')`;
  const domTitles = () =>
    cdp.eval(
      `[...document.querySelectorAll('[data-memo-id]')].map(el=>el.querySelector('div')?.textContent).join(',')`,
    );
  const domIds = () =>
    cdp.eval(
      `[...document.querySelectorAll('[data-memo-id]')].map(el=>el.dataset.memoId).join(',')`,
    );
  const stored = async () => (await cdp.invoke("get_notes"))?.[fix.projectId] || [];
  const storedTexts = async () => (await stored()).map((m) => m.text).join(",");
  const setMemoOpen = (open) =>
    cdp.eval(`window.__gpv.ui.getState().setMemoOpen(${open})`);
  const refreshNotes = () =>
    cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);
  // <select> 는 값을 넣고 change 를 쏘면 React onChange 가 돈다(input 과 달리 값 추적기가 없다).
  const setSelect = (attr, value) =>
    cdp.eval(`(()=>{
      const el=${IN}?.querySelector('[${attr}]');
      if(!el) return null;
      el.value=${J(value)};
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return el.value;
    })()`);
  const SORT_LS = "gp:memo-sort";
  const FILTER_LS = "gp:memo-category:" + fix.projectId;

  // 전부 마운트 때 localStorage 에서 읽는다 — 메모장을 열기 전에 비운다(MD 모드가 켜져 있으면 편집기가 안 뜬다).
  await cdp.eval(
    `localStorage.removeItem(${J(SORT_LS)}); localStorage.removeItem(${J(FILTER_LS)}); localStorage.removeItem("gp:memo-md")`,
  );
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  let addedInFilter = null;
  try {
    for (const key of ["x", "y", "z"]) {
      await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: SORT_IDS[key] });
      await cdp.invoke("update_memo", {
        projectId: fix.projectId,
        memoId: SORT_IDS[key],
        text: SORT_TEXTS[key],
      });
    }
    // X 를 마지막에 한 번 더 저장 — 수정일은 X 가 가장 최근, 그다음 Z, Y.
    await sleep(30);
    await cdp.invoke("update_memo", {
      projectId: fix.projectId,
      memoId: SORT_IDS.x,
      text: SORT_TEXTS.x,
    });
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await refreshNotes();
    await setMemoOpen(true);

    // ── 정렬 ──
    const manual = await poll(domTitles, (v) => v === "ccc,aaa,bbb");
    r.check("정렬 기본값은 수동 순서(배열의 역순)", manual === "ccc,aaa,bbb", manual);

    await setSelect("data-memo-sort", "title");
    const byTitle = await poll(domTitles, (v) => v === "aaa,bbb,ccc");
    r.check("제목순 — 표시가 가나다순으로", byTitle === "aaa,bbb,ccc", byTitle);
    r.check("제목순 — 정본 배열은 그대로", (await storedTexts()) === "bbb,aaa,ccc");

    await setSelect("data-memo-sort", "updated");
    const byUpdated = await poll(domTitles, (v) => v === "bbb,ccc,aaa");
    r.check("수정일순 — 방금 고친 메모가 위", byUpdated === "bbb,ccc,aaa", byUpdated);
    const sortLs = await cdp.eval(`localStorage.getItem(${J(SORT_LS)})`);
    r.check("정렬 설정 영속(gp:memo-sort)", sortLs === "updated", String(sortLs));

    // 수동 순서가 아니면 드래그가 꺼져 있다 — 켜져 있으면 정렬된 표시 순서가 정본을 덮는다.
    await cdp.eval(`(()=>{
      const rows=[...document.querySelectorAll('[data-memo-id]')];
      const src=rows[0], last=rows[rows.length-1];
      const s=src.getBoundingClientRect(), l=last.getBoundingClientRect();
      const ev=(y,buttons)=>({bubbles:true,cancelable:true,composed:true,clientX:s.left+5,clientY:y,
        button:0,buttons,pointerId:1059,pointerType:'mouse',isPrimary:true});
      src.dispatchEvent(new PointerEvent('pointerdown',ev(s.top+s.height/2,1)));
      window.dispatchEvent(new PointerEvent('pointermove',ev(s.top+s.height/2+8,1)));
      window.dispatchEvent(new PointerEvent('pointermove',ev(l.bottom-1,1)));
      window.dispatchEvent(new PointerEvent('pointerup',ev(l.bottom-1,0)));
    })()`);
    await sleep(600);
    r.check("정렬 중 드래그는 정본을 건드리지 않음", (await storedTexts()) === "bbb,aaa,ccc");

    await setSelect("data-memo-sort", "manual");
    const backManual = await poll(domTitles, (v) => v === "ccc,aaa,bbb");
    r.check("수동으로 되돌리면 원래 순서", backManual === "ccc,aaa,bbb", backManual);

    // ── 메모를 바꾼 직후의 편집기 ──
    // 편집기(CodeMirror)는 본문을 마운트 때 한 번만 읽는다. 앞 메모의 본문을 싣고 뜨면 한 글자만 쳐도
    // 그 본문이 이 메모를 덮는다 — 조용히 남의 메모를 지우는 결함이라 저장된 값으로 확인한다.
    const editorDoc = () =>
      cdp.eval(`${IN}?.querySelector('.cm-editor') ? (window.__gpvMemoEditor?.doc() ?? null) : null`);
    const storedText = async (id) => (await stored()).find((m) => m.id === id)?.text ?? null;
    await cdp.eval(`document.querySelector('[data-memo-id=${J(SORT_IDS.x)}]').click()`);
    await poll(editorDoc, (v) => v === SORT_TEXTS.x);
    await cdp.eval(`document.querySelector('[data-memo-id=${J(SORT_IDS.z)}]').click()`);
    const switched = await poll(editorDoc, (v) => v === SORT_TEXTS.z);
    r.check("메모 전환 직후 편집기 문서가 그 메모의 본문", switched === SORT_TEXTS.z, J(switched));
    await cdp.eval(`window.__gpvMemoEditor.type('!')`);
    const typedInto = await poll(() => storedText(SORT_IDS.z), (v) => v === SORT_TEXTS.z + "!", 20, 150);
    r.check("전환 뒤 친 글자가 그 메모에 저장됨", typedInto === SORT_TEXTS.z + "!", J(typedInto));
    r.check("앞 메모의 본문은 그대로", (await storedText(SORT_IDS.x)) === SORT_TEXTS.x);
    // 흔적을 남기지 않게 되돌린다(이 창이 손대지 않은 본문이라 편집기도 따라온다).
    await cdp.invoke("update_memo", { projectId: fix.projectId, memoId: SORT_IDS.z, text: SORT_TEXTS.z });
    await refreshNotes();
    await poll(editorDoc, (v) => v === SORT_TEXTS.z);

    // ── 카테고리 ──
    const yBefore = (await stored()).find((m) => m.id === SORT_IDS.y);
    await sleep(30);
    const y0 = await cdp.invoke("set_memo_category", {
      projectId: fix.projectId,
      memoId: SORT_IDS.y,
      category: "  work  ",
    });
    r.check("set_memo_category: 이름은 다듬어 저장", y0?.category === "work", J(y0?.category));
    r.check(
      "set_memo_category: updatedAt 은 그대로(분류만 옮겼다)",
      !!yBefore?.updatedAt && y0?.updatedAt === yBefore.updatedAt,
      `${yBefore?.updatedAt} → ${y0?.updatedAt}`,
    );
    await refreshNotes();
    const filterShown = await poll(
      () => cdp.eval(`!!${IN}?.querySelector('[data-memo-filter] option[value="c:work"]')`),
      (v) => v === true,
    );
    r.check("카테고리가 생기면 필터에 나타남", filterShown === true, String(filterShown));

    // Y 를 활성으로 두고 그 카테고리로 거른다 → Y 만 남는다.
    await cdp.eval(`document.querySelector('[data-memo-id=${J(SORT_IDS.y)}]').click()`);
    await setSelect("data-memo-filter", "c:work");
    const onlyY = await poll(domIds, (v) => v === SORT_IDS.y);
    r.check("카테고리 필터 — 그 분류의 메모만", onlyY === SORT_IDS.y, onlyY);
    const filterLs = await cdp.eval(`localStorage.getItem(${J(FILTER_LS)})`);
    r.check("필터 선택은 스코프별로 영속", filterLs === "c:work", String(filterLs));

    // 필터가 걸린 채 만든 메모는 그 카테고리로 들어간다(미분류로 만들면 만든 즉시 목록에서 사라진다).
    const known = new Set((await stored()).map((m) => m.id));
    await cdp.eval(`${IN}.querySelector('[data-memo-add]').click()`);
    const added = await poll(
      async () => (await stored()).find((m) => !known.has(m.id)) ?? null,
      (v) => !!v,
    );
    addedInFilter = added?.id ?? null;
    r.check("필터 중 새 메모 — 그 카테고리로 생성", added?.category === "work", J(added?.category));
    const addedRow = await poll(
      () => cdp.eval(`!!document.querySelector('[data-memo-id=${J(addedInFilter)}]')`),
      (v) => v === true,
    );
    r.check("필터 중 새 메모 — 목록에 남아 있음", addedRow === true, String(addedRow));
    if (addedInFilter) {
      await cdp.invoke("delete_memo", { projectId: fix.projectId, memoId: addedInFilter });
      await refreshNotes();
    }

    // 활성 메모의 카테고리를 메뉴에서 "없음"으로 — 필터에서 빠져도 활성으로 남는다.
    await cdp.eval(`document.querySelector('[data-memo-id=${J(SORT_IDS.y)}]').click()`);
    await cdp.eval(`${IN}.querySelector('[data-memo-category-chip]').click()`);
    const menuOpen = await poll(
      () => cdp.eval(`!!${IN}?.querySelector('[data-memo-category-menu]')`),
      (v) => v === true,
    );
    r.check("카테고리 칩 — 메뉴가 열림", menuOpen === true, String(menuOpen));
    await cdp.eval(`${IN}.querySelector('[data-memo-category-menu] button').click()`); // 첫 항목 = 없음
    const cleared = await poll(
      async () => (await stored()).find((m) => m.id === SORT_IDS.y)?.category ?? null,
      (v) => v === null,
    );
    r.check("메뉴에서 없음 — 카테고리 해제 영속", cleared === null, J(cleared));
    const stillActive = await poll(
      () =>
        cdp.eval(
          `document.querySelector('[data-memo-id=${J(SORT_IDS.y)}]')?.className.includes('bg-selection') ?? null`,
        ),
      (v) => v === true,
    );
    r.check("필터에서 빠진 활성 메모가 그대로 활성", stillActive === true, String(stillActive));
    // 마지막 메모가 빠져 카테고리가 사라졌다 → 필터는 전체로 돌아간다.
    const allBack = await poll(domIds, (v) => (v || "").split(",").length === 3);
    r.check("사라진 카테고리의 필터는 전체로", (allBack || "").split(",").length === 3, allBack);

    // ── 이름 바꾸기·해제(일괄) ──
    for (const id of [SORT_IDS.x, SORT_IDS.z])
      await cdp.invoke("set_memo_category", { projectId: fix.projectId, memoId: id, category: "work" });
    await cdp.invoke("rename_memo_category", { projectId: fix.projectId, from: "work", to: "job" });
    const renamed = (await stored()).filter((m) => m.category === "job").map((m) => m.id).sort();
    r.check(
      "rename_memo_category: 그 이름의 메모 전부가 새 이름으로",
      J(renamed) === J([SORT_IDS.x, SORT_IDS.z].sort()),
      J(renamed),
    );
    await cdp.invoke("rename_memo_category", { projectId: fix.projectId, from: "job", to: null });
    const afterRemove = await stored();
    r.check(
      "rename_memo_category(to=null): 분류만 사라지고 메모는 남음",
      afterRemove.length === 3 && afterRemove.every((m) => !m.category),
      J(afterRemove.map((m) => m.category ?? null)),
    );
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(false)`).catch(() => {});
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    for (const id of [...Object.values(SORT_IDS), addedInFilter].filter(Boolean))
      await cdp.try("delete_memo", { projectId: fix.projectId, memoId: id });
    await cdp
      .eval(
        `localStorage.removeItem(${J(SORT_LS)}); localStorage.removeItem(${J(FILTER_LS)}); localStorage.removeItem(${J("gp:memo-active:" + fix.projectId)})`,
      )
      .catch(() => {});
    await refreshNotes().catch(() => {});
  }
}

/**
 * 이 창이 빈 채로 열어 둔 메모를 **다른 창이 채운** 경우 — 닫을 때의 "빈 메모 정리"가 그 내용을 지우면 안 된다.
 * 다른 창의 저장은 notes://changed → 재조회로 이 창의 캐시에 닿는다. 여기서는 그 결과(캐시가 바뀜)를
 * IPC 저장 + 재조회로 만든다 — 같은 창에서 보낸 저장의 신호는 자기 것이라 무시되므로 재조회를 직접 건다.
 */
async function otherWindowEditBlock({ cdp, r, fix }) {
  const J = (v) => JSON.stringify(v);
  if (!(await cdp.eval(`!!window.__gpv`))) {
    r.skip("다른 창이 채운 메모", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
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
  const IN = `document.querySelector('[data-memo-id]')?.closest('.fixed')`;
  const taValue = () =>
    cdp.eval(`${IN}?.querySelector('.cm-editor') ? (window.__gpvMemoEditor?.doc() ?? null) : null`);
  const refreshNotes = () =>
    cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["notes"] })`);
  const storedMemo = async () =>
    ((await cdp.invoke("get_notes"))?.[fix.projectId] || []).find((m) => m.id === OTHER_WIN_ID) ?? null;

  await cdp.eval(`localStorage.removeItem("gp:memo-md"); localStorage.removeItem("gp:memo-sort")`);
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  try {
    await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: OTHER_WIN_ID });
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await refreshNotes();
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(true)`);
    const row = await poll(
      () => cdp.eval(`!!document.querySelector('[data-memo-id=${J(OTHER_WIN_ID)}]')`),
      (v) => v === true,
    );
    r.check("빈 메모가 목록에 뜸", row === true, String(row));
    await cdp.eval(`document.querySelector('[data-memo-id=${J(OTHER_WIN_ID)}]').click()`);
    const empty = await poll(taValue, (v) => v === "");
    r.check("빈 메모를 열어 둠(입력칸 비어 있음)", empty === "", J(empty));

    // "다른 창"이 그 메모를 채운다.
    await cdp.invoke("update_memo", {
      projectId: fix.projectId,
      memoId: OTHER_WIN_ID,
      text: "written elsewhere",
    });
    await refreshNotes();
    const adopted = await poll(taValue, (v) => v === "written elsewhere");
    r.check(
      "손대지 않은 본문은 바깥 변경을 따라감",
      adopted === "written elsewhere",
      J(adopted),
    );

    // 진짜 닫기 경로(X 버튼 → flush)로 닫는다 — 스토어로 닫으면 flush 를 건너뛰어 이 절이 비어 버린다.
    await cdp.eval(`${IN}.querySelector('button[title^="닫기"]').click()`);
    await poll(
      () => cdp.eval(`!document.querySelector('[data-memo-id]')`),
      (v) => v === true,
    );
    await sleep(300);
    const kept = await storedMemo();
    r.check(
      "닫을 때의 빈 메모 정리가 다른 창의 내용을 지우지 않음",
      kept?.text === "written elsewhere",
      J(kept?.text ?? null),
    );
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setMemoOpen(false)`).catch(() => {});
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: OTHER_WIN_ID });
    await cdp
      .eval(`localStorage.removeItem(${J("gp:memo-active:" + fix.projectId)})`)
      .catch(() => {});
    await refreshNotes().catch(() => {});
  }
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

  // 표시 순서 단언은 수동 순서 + 필터 전체가 전제다 — 둘 다 마운트 때 localStorage 에서 읽는다.
  await cdp.eval(
    `localStorage.removeItem("gp:memo-sort"); localStorage.removeItem(${J("gp:memo-category:" + fix.projectId)})`,
  );
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
  // 편집기는 CodeMirror 다. 화면의 글자(textContent)는 줄바꿈을 잃고 위젯이 가린 `[ ]` 도 빠져서
  // 본문 비교에 못 쓴다 — dev 훅(MemoEditor.tsx 의 __gpvMemoEditor)으로 문서를 직접 읽는다. 편집기가 없으면 null.
  const taValue = () =>
    cdp.eval(`${IN}?.querySelector('.cm-editor') ? (window.__gpvMemoEditor?.doc() ?? null) : null`);
  const noTextarea = () => cdp.eval(`!${IN}?.querySelector('.cm-editor')`);
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
    r.check("① 기본은 텍스트 모드 — 편집기에 본문 그대로", v1 === MD_TEXT, J(v1));
    // 줄 머리 `[ ]` 는 체크박스 위젯으로 보이지만 본문 글자는 그대로다. 누르면 그 세 글자만 바뀐다.
    const TASK = `${IN}?.querySelector('.cm-content input.cm-memo-task')`;
    r.check("① 줄 머리 [ ] 가 체크박스 위젯으로 보임", (await cdp.eval(`!!${TASK}`)) === true);
    await cdp.eval(`${TASK}.click()`);
    const checkedText = MD_TEXT.replace("[ ]", "[x]");
    const v1x = await poll(taValue, (v) => v === checkedText, 15);
    r.check("① 체크박스 클릭 — 본문의 [ ] 가 [x] 로", v1x === checkedText, J(v1x));
    await cdp.eval(`${TASK}.click()`);
    const v1o = await poll(taValue, (v) => v === MD_TEXT, 15);
    r.check("① 다시 클릭 — [ ] 로 되돌아옴", v1o === MD_TEXT, J(v1o));

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
    r.check("③ 렌더 본문 클릭 — 편집기 복귀(값 동일)", v3 === MD_TEXT, J(v3));
    const focused = await poll(
      () =>
        cdp.eval(`document.activeElement === (${IN}?.querySelector('.cm-content'))`),
      (v) => v === true,
      15,
      100,
    );
    r.check("③ 렌더 본문 클릭 — 그 편집기로 포커스 이동", focused === true, String(focused));
    // 편집기가 뜨자마자 렌더 뷰로 되돌아가면 안 된다 — StrictMode 가 버리는 첫 편집기의 focusout 을
    // "포커스가 떠났다"로 받으면 그렇게 된다(MemoEditor 의 onBlur 주석).
    await sleep(400);
    r.check("③ 편집기가 그대로 떠 있음", (await taValue()) === MD_TEXT);

    // ④ 포커스가 빠지면 다시 렌더.
    // blur()만으로는 부족하다 — e2e 창은 OS 포커스가 없어(document.hasFocus() === false)
    // Blink가 프로그램 blur의 blur/focusout 디스패치를 통째로 삼킨다(activeElement만 body로
    // 옮겨간다). React의 onBlur는 루트의 focusout을 듣기 때문에 위 드래그 절의 PointerEvent와
    // 같은 방식으로 이벤트를 합성해 준다 — 핸들러·상태 전이·DOM은 전부 진짜다.
    await cdp.eval(`(()=>{
      const ta=${IN}.querySelector('.cm-content');
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
    // 사용자가 친 것과 같은 길로 넣는다: 편집기 트랜잭션(userEvent input.type) → onChange → draft.
    // e2e 창에는 OS 포커스가 없어 키 입력을 흘려보낼 수 없다.
    await cdp.eval(`window.__gpvMemoEditor.type('a')`);
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
    r.check("⑤ MD 끔 — 편집기 복귀", v5 === MD_TEXT, J(v5));
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
