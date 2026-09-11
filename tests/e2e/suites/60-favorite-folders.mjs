// 태스크 66 — 즐겨찾기 폴더 창(스크린샷·다운로드 빠르게 보기).
//
// 지키는 계약 열둘:
//   ① **게이트가 백엔드에 있다.** 등록되지 않은 폴더는 `fav_list` 가 거부한다 — 프론트가 안 보내는
//      것과 백엔드가 막는 것은 다르다. 그래서 UI 를 거치지 않고 **커맨드를 직접 invoke** 해서 잰다.
//      이게 이 스위트의 핵심이다: 이 커맨드들만 절대경로를 받으므로, 게이트가 무너지면 파일시스템
//      전체가 열린다.
//   ② 루트 **밖**(상위 폴더)도 거부된다. canonicalize 후 prefix 검사라 `..` 로 못 빠져나간다.
//   ③ `fav_list` 가 확장자로 종류를 가른다(image/video/dir/other) — 프론트의 아이콘·필터·라이트박스
//      순서가 전부 이 값에 달려 있다.
//   ④ 썸네일은 **128·192·320 셋만** 받는다. 열어 두면 캐시가 크기마다 한 벌씩 늘어난다.
//   ⑤ 타이틀바 [폴더] → 드롭다운 → 항목 클릭 → **별도 창**(`doc-<id>`)이 뜨고 그 폴더를 그린다.
//      id 는 경로에서 **결정적으로** 나온다(같은 폴더 재클릭 = 새 창이 아니라 포커스).
//   ⑥ 우클릭 → 경로 복사 → 클립보드에 **절대경로**.
//   ⑦ 갱신이 더 최신 파일을 앞에 끼워도 **선택은 그 파일에 남는다**(이름으로 붙든다). 인덱스로 들면
//      강조·Ctrl+C·Enter 가 말없이 옆 파일로 옮겨 간다 — 스크린샷 경로를 Claude 에 넘기는 그 동선이다.
//   ⑧ 같은 이름으로 다시 쓴 파일은 **썸네일이 바뀐다**(키 = 이름|mtime|크기, 칸이 새로 마운트된다).
//   ⑨ 라이트박스도 이름으로 붙든다 — 갱신 뒤에도 같은 파일, 그 파일이 지워지면 닫힌다.
//   ⑩ 썸네일 크기를 바꾼 뒤 늦게 온 옛 크기 응답은 버려진다(세대). 응답을 일부러 붙잡아 경합을 만든다.
//   ⑪ 툴바 "탐색기에서 이 폴더 열기"는 이 폴더 **자체**를 연다(`default`) — `reveal` 은 상위를 연다.
//   ⑫ 반대로 **아직 고르지 않은** 강조는 맨 앞(최신)을 따라간다 — 새 스크린샷을 찍고 창을 클릭하면
//      Ctrl+C 대상은 방금 찍은 것이다. ⑦ 의 "이름으로 붙들기"가 고르기 전부터 붙들면 안 된다.
//
// 픽스처는 이 스위트가 직접 만든다(공유 git 픽스처와 무관한 그냥 폴더다) — 끝나면 지우고
// `favoriteFolders` 설정도 되돌린다.
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name =
  "즐겨찾기 폴더 창 (백엔드 게이트 · 종류 분류 · 썸네일 크기 고정 · 창 라우팅 · 경로 복사 · 갱신 뒤 선택·썸네일·라이트박스 유지)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
/** 창 열거·닫기는 webviewWindow JS API 로 한다(스위트 13·50 과 같은 통로). */
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

/** 1×1 PNG — `fav_thumb` 이 실제로 디코딩할 수 있어야 하므로 유효한 파일이어야 한다. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** 같은 1×1 RGBA 인데 **픽셀이 다르다**(위는 반투명 빨강, 이건 불투명 파랑 — PIL 로 확인). 같은 이름으로
 *  덮어썼을 때 썸네일 JPEG 바이트가 달라져야 "썸네일이 바뀌었다"를 src 로 잴 수 있다. */
const PNG_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
  "base64",
);

/** `lib/floating.ts` 의 `folderWindowId` 와 **같은 계산**. 창 라벨을 미리 알아야 그 창에 붙을 수
 *  있고, 여기서 같은 값이 나온다는 것 자체가 "id 가 결정적"이라는 계약의 확인이다. */
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};
const folderWindowId = (p) => fnv(p) + fnv(p.split("").reverse().join(""));

export async function run({ cdp, report: r }) {
  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      try {
        if (ok(v)) return v;
      } catch {
        /* 다음 회차 */
      }
      await sleep(ms);
    }
    return v;
  };

  /** 창 라벨 목록. **실패를 빈 배열로 돌려주면 안 된다** — 그러면 "창이 없다"로 읽혀
   *  아래 싱글턴 단언이 결함이 있는데도 통과한다. 실패는 `ERR:` 로 표시해 그대로 드러낸다.
   *  (베어 스펙파이어 `import("@tauri-apps/api/webviewWindow")` 는 페이지 컨텍스트에서 해석되지
   *  않는다 — 반드시 `/node_modules/...` 경로로 준다.) */
  const labels = () =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String((e&&e.message)||e)]; } })()`,
      )
      .then((v) => (Array.isArray(v) ? v : ["ERR:배열이 아님"]));

  const hooks = await poll(
    () => cdp.eval(`!!(window.__gpv && window.__gpv.ui)`),
    (v) => v === true,
    16,
    250,
  );
  if (hooks !== true) {
    r.skip("즐겨찾기 폴더 창", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  // 새 커맨드가 없는 옛 바이너리면 여기서 갈린다 — "기능 실패"가 아니라 "앱이 옛것"이다.
  const probe = await cdp.try("fav_presets");
  if (!probe.ok && /not found|not allowed/i.test(probe.message || "")) {
    r.skip("즐겨찾기 폴더 창", "fav_* 커맨드 없음(재빌드 전 바이너리) — 스킵");
    return;
  }

  const root = join(tmpdir(), `gpv-fav-${Date.now()}`);
  const sub = join(root, "하위폴더");
  let origSettings = null;
  let win = null;
  let label = null; // finally 에서도 써야 한다(창을 라벨로 닫는다)

  try {
    mkdirSync(sub, { recursive: true });
    for (const n of ["a.png", "b.png", "c.png"]) writeFileSync(join(root, n), PNG_1X1);
    writeFileSync(join(root, "메모.txt"), "hello");
    writeFileSync(join(root, "clip.mp4"), "not really a video");

    origSettings = await cdp.invoke("get_settings");

    // ── ① 게이트: 등록 **전에는** 거부 ──
    const before = await cdp.try("fav_list", { path: root });
    r.check(
      "① 등록되지 않은 폴더는 fav_list 가 거부한다(백엔드 게이트)",
      !before.ok,
      before.ok ? "허용됨 — 게이트가 없다" : `code=${before.code} ${String(before.message).slice(0, 40)}`,
    );

    const set = await cdp.try("set_settings", {
      settings: {
        ...origSettings,
        favoriteFolders: [{ path: root, name: "e2e 즐겨찾기" }],
      },
    });
    if (!r.check("픽스처 폴더를 즐겨찾기에 등록", set.ok, set.message || "")) return;

    // ── ③ 등록 후 목록 · 종류 분류 ──
    const list = await cdp.try("fav_list", { path: root });
    const byName = Object.fromEntries((list.r ?? []).map((e) => [e.name, e]));
    r.check(
      "③ fav_list: 항목 6개 · 확장자로 종류를 가른다(image/video/dir/other)",
      list.ok &&
        (list.r ?? []).length === 6 &&
        byName["a.png"]?.kind === "image" &&
        byName["clip.mp4"]?.kind === "video" &&
        byName["메모.txt"]?.kind === "other" &&
        byName["하위폴더"]?.kind === "dir" &&
        byName["하위폴더"]?.isDir === true,
      `n=${(list.r ?? []).length} kinds=${J((list.r ?? []).map((e) => `${e.name}:${e.kind}`))}`,
    );

    // ── ② 루트 밖은 거부 ──
    const outside = await cdp.try("fav_list", { path: tmpdir() });
    r.check(
      "② 루트 **밖**(상위 폴더)은 거부된다 — canonicalize 후 prefix 검사",
      !outside.ok,
      outside.ok ? "허용됨 — 상위로 빠져나간다" : `code=${outside.code}`,
    );

    // ── ④ 썸네일: 허용 크기 셋만 ──
    const thumb = await cdp.try("fav_thumb", { path: join(root, "a.png"), edge: 192 });
    r.check(
      "④ fav_thumb(192) → data:image/jpeg 반환",
      thumb.ok && String(thumb.r ?? "").startsWith("data:image/jpeg;base64,"),
      thumb.ok ? String(thumb.r ?? "").slice(0, 32) : String(thumb.message).slice(0, 60),
    );
    const badEdge = await cdp.try("fav_thumb", { path: join(root, "a.png"), edge: 256 });
    r.check(
      "④ 허용 밖 크기(256)는 거부 — 캐시가 크기마다 한 벌씩 늘어나는 것을 막는다",
      !badEdge.ok,
      badEdge.ok ? "허용됨" : `code=${badEdge.code}`,
    );

    // ── ⑤ UI: 타이틀바 [폴더] → 드롭다운 → 창 ──
    // 설정 쿼리 캐시를 갱신해야 드롭다운이 방금 등록한 항목을 본다(원시 invoke 로 썼다).
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["settings"] })`)
      .catch(() => {});
    await sleep(400);

    const opened = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /즐겨찾기 폴더/.test(x.title||''));
      if (!b) return { err: '폴더 버튼 없음' };
      b.click();
      return { ok: true };
    })()`);
    const item = await poll(
      () =>
        cdp.eval(
          `(()=>{ const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'e2e 즐겨찾기'); return !!b; })()`,
        ),
      (v) => v === true,
      12,
      200,
    );
    r.check(
      "⑤ 타이틀바 [폴더] → 드롭다운에 등록한 즐겨찾기",
      opened?.ok === true && item === true,
      `버튼=${J(opened)} 항목=${item}`,
    );

    label = `doc-${folderWindowId(root)}`;
    await cdp.eval(
      `(()=>{ const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'e2e 즐겨찾기'); if (b) b.click(); return !!b; })()`,
    );

    win = await connectLabel(label, { port: cdp.cdpPort }).catch(() => null);
    if (
      !r.check(
        "⑤ 항목 클릭 → 폴더 창이 뜬다(라벨은 경로에서 결정적으로 나온다)",
        !!win,
        `label=${label}`,
      )
    ) {
      return;
    }

    const names = await poll(
      () =>
        win.eval(
          `Array.from(document.querySelectorAll('button,tr')).map(e => (e.textContent||'').trim()).join('\\n')`,
        ),
      (v) => typeof v === "string" && v.includes("a.png"),
      20,
      300,
    );
    r.check(
      "⑤ 그 창이 그 폴더를 그린다(항목이 보인다)",
      typeof names === "string" && names.includes("a.png") && names.includes("하위폴더"),
      `본문=${J(String(names).replace(/\s+/g, " ").slice(0, 80))}`,
    );

    // 같은 항목을 다시 눌러도 창은 하나 — Rust 의 싱글턴 분기(open_doc_window)가 걸린다.
    // **라벨을 직접 센다.** "페이지가 있으면 1" 같은 대리 지표는 창이 둘이어도 통과한다.
    const countLabel = async () => {
      const ls = await labels();
      // 열거 자체가 실패했으면 0 이 아니라 -1 — 단언이 그 자리에서 깨져야 한다.
      if (ls.some((l) => String(l).startsWith("ERR:"))) return -1;
      return ls.filter((l) => l === label).length;
    };
    const before2 = await countLabel();
    await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /즐겨찾기 폴더/.test(x.title||''));
      if (b) b.click(); return true; })()`);
    await sleep(300);
    await cdp.eval(
      `(()=>{ const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'e2e 즐겨찾기'); if (b) b.click(); return !!b; })()`,
    );
    await sleep(800);
    const after2 = await countLabel();
    r.check(
      "⑤ 같은 폴더 재클릭 → 창이 늘지 않는다(포커스만)",
      before2 === 1 && after2 === 1,
      `before=${before2} after=${after2}`,
    );

    // ── ⑥ 우클릭 → 경로 복사 ──
    const rightClicked = await win.eval(`(()=>{
      const cells = Array.from(document.querySelectorAll('button,tr'));
      const t = cells.find(e => (e.textContent||'').trim().startsWith('a.png'));
      if (!t) return false;
      const rc = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:rc.left+8,clientY:rc.top+8}));
      return true;
    })()`);
    const menuHas = await poll(
      () =>
        win.eval(
          `(()=>{ const m = document.querySelector('div.fixed.z-50.min-w-52'); return m ? Array.from(m.querySelectorAll('button')).map(b => ((b.querySelector('span.min-w-0')||b).textContent||'').trim()) : null; })()`,
        ),
      (v) => Array.isArray(v) && v.includes("경로 복사"),
      12,
      200,
    );
    r.check(
      "⑥ 항목 우클릭 → 경로 복사 · 터미널에 경로 붙여넣기 · 기본 앱 · 탐색기",
      rightClicked === true &&
        Array.isArray(menuHas) &&
        ["경로 복사", "터미널에 경로 붙여넣기", "기본 앱으로 열기", "탐색기에서 보기"].every((l) =>
          menuHas.includes(l),
        ),
      `항목=${J(menuHas)}`,
    );

    await win.eval(
      `(()=>{ const m = document.querySelector('div.fixed.z-50.min-w-52'); const b = m && Array.from(m.querySelectorAll('button')).find(el => (((el.querySelector('span.min-w-0')||el).textContent)||'').trim() === '경로 복사'); if (b) { b.click(); return true; } return false; })()`,
    );
    const clip = await poll(
      () => cdp.try("term_paste").then((x) => (x.ok ? String(x.r ?? "") : "")),
      (v) => typeof v === "string" && v.includes("a.png"),
      14,
      250,
    );
    r.check(
      "⑥ [경로 복사] → 클립보드에 그 파일의 절대경로",
      typeof clip === "string" && clip.includes("a.png") && clip.includes("gpv-fav-"),
      `클립=${J(String(clip).slice(0, 70))}`,
    );

    // ── ⑦~⑪ 갱신 뒤에도 같은 파일을 가리키는가 ──
    // 그리드 칸 = `button.flex-col[title]`(타이틀바 버튼은 flex-col 이 아니다), 강조 칸 = border-accent.
    const grid = () =>
      win.eval(`(()=>{
        const tiles = Array.from(document.querySelectorAll('button.flex-col[title]'));
        return {
          order: tiles.map((b) => b.title),
          hl: tiles.filter((b) => b.classList.contains('border-accent')).map((b) => b.title),
          src: Object.fromEntries(tiles.map((b) => [b.title, (b.querySelector('img') || {}).src || null])),
        };
      })()`);
    const tile = (n, ev) =>
      win.eval(`(()=>{
        const b = Array.from(document.querySelectorAll('button.flex-col[title]')).find((x) => x.title === ${J(n)});
        if (!b) return false;
        ${ev === "dblclick" ? "b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));" : "b.click();"}
        return true;
      })()`);
    /** 툴바 버튼을 title 앞머리로 누른다(새로고침·보기 모드). */
    const toolbar = (prefix) =>
      win.eval(
        `(()=>{ const b = Array.from(document.querySelectorAll('button')).find((x) => (x.title || '').startsWith(${J(prefix)})); if (b) b.click(); return !!b; })()`,
      );
    /** mtime 을 "지금 ± h 시간"으로 못 박는다 — 스위트 초입에 같은 ms 로 쓴 픽스처와 순서가 섞이지 않게. */
    const stamp = (p, h) => {
      const t = new Date(Date.now() + h * 3600e3);
      utimesSync(p, t, t);
    };

    // ── ⑦ 선택은 이름으로 붙든다 ──
    // b.png 를 고르고 → 더 최신(+1h) 이미지를 넣고 → 새로고침. 기본 정렬이 최신 먼저라 새 파일이 b.png
    // **앞**에 끼어 b.png 가 한 칸 밀린다 — 인덱스로 든 선택이면 강조가 그 자리의 다른 파일로 간다.
    const picked = await tile("b.png");
    const g7a = await poll(grid, (g) => g.hl.length === 1 && g.hl[0] === "b.png", 12, 200);
    const newer1 = join(root, "newer-1.png");
    writeFileSync(newer1, PNG_1X1);
    stamp(newer1, 1);
    await toolbar("새로고침");
    const g7 = await poll(grid, (g) => g.order.includes("newer-1.png"), 20, 250);
    // 새 파일이 정말 b.png 앞에 꼈는가 — 아니면 인덱스 선택도 우연히 통과한다(공허한 단언).
    const shifted = !!g7 && g7.order.indexOf("newer-1.png") < g7.order.indexOf("b.png");
    r.check(
      "⑦ 새로고침이 더 최신 파일을 앞에 끼워도 강조(= Ctrl+C·Enter 대상)는 고른 파일에 남는다",
      picked === true && g7a?.hl?.[0] === "b.png" && shifted && J(g7?.hl) === J(["b.png"]),
      `고름=${J(g7a?.hl)} 갱신뒤=${J(g7?.hl)} 순서=${J(g7?.order)}`,
    );

    // ── ⑧ 같은 이름으로 다시 쓴 파일은 썸네일이 바뀐다 ──
    // 이름만 키로 쓰면 asked 에 이미 있어 다시 요청하지 않고 map 의 옛 그림을 영영 쓴다. 두 PNG 는 바이트
    // 수가 같으므로(70) mtime 을 확실히 다르게 둔다 — 키 = 이름|mtime|크기.
    const g8a = await poll(
      grid,
      (g) => String(g.src["c.png"] || "").startsWith("data:image/jpeg"),
      40,
      250,
    );
    const src0 = g8a?.src?.["c.png"] || null;
    writeFileSync(join(root, "c.png"), PNG_BLUE);
    stamp(join(root, "c.png"), -48);
    await toolbar("새로고침");
    const g8 = await poll(grid, (g) => !!g.src["c.png"] && g.src["c.png"] !== src0, 40, 250);
    const src1 = g8?.src?.["c.png"] || null;
    r.check(
      "⑧ 같은 이름으로 다시 쓴 이미지 → 그리드 썸네일이 새 그림으로 바뀐다",
      !!src0 &&
        src0.startsWith("data:image/jpeg") &&
        !!src1 &&
        src1.startsWith("data:image/jpeg") &&
        src1 !== src0,
      `전=${src0 ? `${src0.length}자` : "없음"} 후=${src1 ? (src1 === src0 ? "그대로" : `${src1.length}자`) : "없음"}`,
    );

    // ── ⑨ 라이트박스도 이름으로 붙든다 ──
    // a.png 를 열고 → 가장 최신(+2h) 이미지를 넣고 → 새로고침: 여전히 a.png. 이어서 a.png 를 지우고 →
    // 새로고침: 닫힌다. 인덱스로 들면 앞은 옆 이미지로 바뀌고, 뒤는 개수가 그대로라 그 자리 이미지가 뜬다.
    const lb = () =>
      win.eval(`(()=>{
        const o = document.querySelector('div.fixed.inset-0.z-40');
        if (!o) return null;
        const s = o.querySelectorAll('span');
        return { name: (s[0] && s[0].textContent) || '', pos: (s[1] && s[1].textContent) || '' };
      })()`);
    const total = (v) => Number(String(v?.pos || "").split("/")[1]);
    const opened9 = await tile("a.png", "dblclick");
    const lb0 = await poll(lb, (v) => v?.name === "a.png", 20, 250);
    const newer2 = join(root, "newer-2.png");
    writeFileSync(newer2, PNG_1X1);
    stamp(newer2, 2);
    await toolbar("새로고침");
    const lb1 = await poll(lb, (v) => total(v) === total(lb0) + 1, 20, 250);
    let rmErr = null;
    try {
      rmSync(join(root, "a.png"));
    } catch (e) {
      rmErr = String(e?.message || e);
    }
    await toolbar("새로고침");
    const lb2 = await poll(lb, (v) => v === null, 20, 250);
    r.check(
      "⑨ 라이트박스: 더 최신 이미지가 앞에 껴도 같은 파일, 그 파일이 지워지면 닫힌다",
      opened9 === true &&
        lb0?.name === "a.png" &&
        lb1?.name === "a.png" &&
        total(lb1) === total(lb0) + 1 &&
        !rmErr &&
        lb2 === null,
      `열림=${J(lb0)} 끼운뒤=${J(lb1)} 지운뒤=${J(lb2)}${rmErr ? ` 삭제실패=${rmErr}` : ""}`,
    );
    // 옛 코드면 아직 열려 있다 — 다음 단계가 그리드를 만지기 전에 닫아 둔다.
    await win
      .eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      .catch(() => {});

    // ── ⑩ 크기를 바꾼 뒤 늦게 도착한 옛 크기 썸네일은 버려진다(세대) ──
    // 경합을 **만든다**: 128px 요청을 1.5초 붙잡은 채 S(128) → L(320). 320 이 먼저 그려지고 붙잡힌 128 이
    // 뒤늦게 온다 — 세대 검사가 없으면 그 128 이 320 칸을 덮는다(키에 크기가 없으니 같은 칸이다).
    // 스파이는 창의 `ipc.favThumb` 를 갈아 끼운다. `__TAURI_INTERNALS__.invoke` 는 non-writable 이라
    // (스위트 14 #2b) 창이 **실제로 로드한** ipc 모듈을 import 해 같은 객체를 만진다(vite 가 ?t=… 를 붙인다).
    const armed = await win
      .eval(`(async()=>{
        const url = performance.getEntriesByType('resource').map((e) => e.name)
          .find((n) => n.includes('/src/lib/ipc.ts')) || '/src/lib/ipc.ts';
        const m = await import(url);
        const st = (window.__favSpy = { m, thumb: m.ipc.favThumb, open: m.ipc.favOpen, held: 0, pending: 0 });
        m.ipc.favThumb = (path, edge) => {
          if (edge !== 128) return st.thumb(path, edge);
          st.held++;
          st.pending++;
          return new Promise((r) => setTimeout(r, 1500))
            .then(() => st.thumb(path, edge))
            .finally(() => { st.pending--; });
        };
        return url;
      })()`)
      .catch((e) => `ERR:${e.message}`);
    await toolbar("작은 썸네일");
    const held = await poll(() => win.eval(`window.__favSpy.held`), (v) => v > 0, 30, 100);
    await toolbar("큰 썸네일");
    // 붙잡힌 128 이 전부 풀릴 때까지(옛 코드는 여기서 칸을 덮는다) + 그 렌더가 끝날 때까지.
    const drained = await poll(() => win.eval(`window.__favSpy.pending`), (v) => v === 0, 40, 250);
    await sleep(500);
    // 기준 = 백엔드가 주는 320px 썸네일 그 자체(같은 캐시 키라 바이트가 같다). 화면 밖이라 아직 안
    // 받은 칸(src 없음)은 허용하되, 그려진 칸은 전부 320 이어야 하고 적어도 하나는 그려져 있어야 한다.
    const pngs = ((await grid().catch(() => null))?.order ?? []).filter((n) => n.endsWith(".png"));
    const ref = {};
    for (const n of pngs) {
      const t = await cdp.try("fav_thumb", { path: join(root, n), edge: 320 });
      ref[n] = t.ok ? t.r : null;
    }
    const g10 = await poll(
      grid,
      (g) =>
        pngs.some((n) => g.src[n] && g.src[n] === ref[n]) &&
        pngs.every((n) => !g.src[n] || g.src[n] === ref[n]),
      20,
      250,
    );
    const ok320 = pngs.filter((n) => g10?.src?.[n] && g10.src[n] === ref[n]);
    const wrong = pngs.filter((n) => g10?.src?.[n] && g10.src[n] !== ref[n]);
    r.check(
      "⑩ 크기를 S→L 로 바꾼 뒤 늦게 온 128px 응답이 320px 칸을 덮지 않는다(세대 검사)",
      held > 0 && drained === 0 && ok320.length > 0 && wrong.length === 0,
      `스파이=${armed} 붙잡은128=${held} 남음=${drained} 320=${J(ok320)} 다른크기=${J(wrong)}`,
    );
    await win
      .eval(`(()=>{ const s = window.__favSpy; if (s) s.m.ipc.favThumb = s.thumb; return true; })()`)
      .catch(() => {});

    // ── ⑪ 툴바 [탐색기에서 이 폴더 열기] → 이 폴더 자체(`default`) ──
    // 진짜로 부르면 사용자 화면에 탐색기가 뜬다 — ⑩ 의 스파이로 `ipc.favOpen` 을 **대신** 받아 인자만 적는다.
    // ⑩ 에서 스파이가 요청을 실제로 붙잡았어야(held>0) 이 창이 쓰는 그 ipc 객체라는 게 증명된다.
    // 아니면 누르지 않는다 — 스파이가 빗나간 채 누르면 진짜 탐색기가 뜬다.
    const opened11 = await win
      .eval(`(()=>{
        const s = window.__favSpy;
        if (!s || !(s.held > 0)) return { err: '스파이가 이 창의 ipc 에 걸렸는지 확인 안 됨 — 누르지 않는다' };
        const calls = [];
        s.m.ipc.favOpen = (path, how) => { calls.push({ path, how }); return Promise.resolve(); };
        try {
          const b = Array.from(document.querySelectorAll('button')).find((x) => x.title === '탐색기에서 이 폴더 열기');
          if (!b) return { err: '버튼 없음' };
          b.click();
          return { calls };
        } finally {
          s.m.ipc.favOpen = s.open;
        }
      })()`)
      .catch((e) => ({ err: e.message }));
    const call11 = opened11?.calls?.[0];
    r.check(
      "⑪ 툴바 [탐색기에서 이 폴더 열기] → fav_open(이 폴더, default) — reveal 은 상위 폴더를 연다",
      opened11?.calls?.length === 1 && call11?.how === "default" && call11?.path === root,
      J(opened11),
    );

    // ── ⑫ 고르지 않은 강조는 맨 앞(최신)을 따라간다 ──
    // 스크린샷 동선 그대로: 창을 열어만 두고 → 새 스크린샷 → 창 클릭(= 갱신). 강조가 첫 로드의 첫 파일을
    // 이름으로 붙들면 이전 스크린샷에 남는다. 루트는 하위폴더가 늘 0번(폴더 먼저)이라 이 경우를 가린다 —
    // 파일만 있는 하위폴더로 들어가 잰다. 들어갈 때 **dblclick 만** 쓴다(click 이면 고른 것이 된다).
    // 폴더가 바뀌면 선택은 처음부터다. ⑪ 이 루트를 전제하므로 이 단계는 반드시 그 뒤다.
    const s1 = join(sub, "s1.png");
    writeFileSync(s1, PNG_1X1);
    stamp(s1, -1);
    const entered = await tile("하위폴더", "dblclick");
    const g12a = await poll(grid, (g) => J(g.order) === J(["s1.png"]), 20, 250);
    const s2 = join(sub, "s2.png");
    writeFileSync(s2, PNG_1X1);
    stamp(s2, 3);
    await toolbar("새로고침");
    const g12 = await poll(grid, (g) => g.order.includes("s2.png"), 20, 250);
    r.check(
      "⑫ 아무것도 고르지 않은 채 갱신이 더 최신 파일을 앞에 끼우면 강조(= Ctrl+C·Enter 대상)는 그 최신 파일이다",
      entered === true &&
        J(g12a?.hl) === J(["s1.png"]) &&
        // s2 가 정말 앞에 꼈는가 — 아니면 붙든 선택도 우연히 통과한다(공허한 단언).
        J(g12?.order) === J(["s2.png", "s1.png"]) &&
        J(g12?.hl) === J(["s2.png"]),
      `들어감=${entered} 전=${J(g12a?.hl)} 갱신뒤=${J(g12?.hl)} 순서=${J(g12?.order)}`,
    );
  } finally {
    if (win) {
      win.close(); // CDP 소켓만 닫는다 — 창 자체는 아래에서 라벨로 닫는다
      await cdp
        .eval(
          `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${J(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
        )
        .catch(() => {});
    }
    if (origSettings) {
      await cdp.try("set_settings", { settings: origSettings });
    }
    if (existsSync(root)) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* 앱이 아직 쥐고 있으면 러너의 잔여 정리가 다음 회차에 가져간다 */
      }
    }
  }
}
