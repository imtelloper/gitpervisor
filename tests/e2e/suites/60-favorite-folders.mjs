// 태스크 66 — 즐겨찾기 폴더 창(스크린샷·다운로드 빠르게 보기).
//
// 지키는 계약 여섯:
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
//
// 픽스처는 이 스위트가 직접 만든다(공유 git 픽스처와 무관한 그냥 폴더다) — 끝나면 지우고
// `favoriteFolders` 설정도 되돌린다.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name =
  "즐겨찾기 폴더 창 (백엔드 게이트 · 종류 분류 · 썸네일 크기 고정 · 창 라우팅 · 경로 복사)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
/** 창 열거·닫기는 webviewWindow JS API 로 한다(스위트 13·50 과 같은 통로). */
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

/** 1×1 PNG — `fav_thumb` 이 실제로 디코딩할 수 있어야 하므로 유효한 파일이어야 한다. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
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
