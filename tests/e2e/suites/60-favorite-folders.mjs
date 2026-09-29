// 태스크 66 — 즐겨찾기 폴더 창(스크린샷·다운로드 빠르게 보기).
//
// 지키는 계약 열넷:
//   ① **게이트가 백엔드에 있다.** 등록되지 않은 폴더는 `fav_list` 가 거부한다 — 프론트가 안 보내는
//      것과 백엔드가 막는 것은 다르다. 그래서 UI 를 거치지 않고 **커맨드를 직접 invoke** 해서 잰다.
//      이게 이 스위트의 핵심이다: 이 커맨드들만 절대경로를 받으므로, 게이트가 무너지면 파일시스템
//      전체가 열린다.
//   ② 루트 **밖**(상위 폴더)도 거부된다. canonicalize 후 prefix 검사라 `..` 로 못 빠져나간다.
//   ③ `fav_list` 가 확장자로 종류를 가른다(image/video/dir/other) — 프론트의 아이콘·필터·라이트박스
//      순서가 전부 이 값에 달려 있다.
//   ④ 썸네일 스킴(`gpvthumb`, commands/thumb_protocol.rs)의 게이트 — 맞는 토큰·허용 루트 안·128/192/320
//      이면 이미지가 뜨고, 토큰이 없거나 틀리면·루트 밖(`..` 로 빠져나가기 포함)이면·크기가 셋 밖이면 실패한다.
//      앱 창의 `<img>` 로 직접 잰다 — 인앱 브라우저의 외부 페이지도 이 스킴을 부를 수 있어 토큰이 그 벽이다.
//   ⑤ 타이틀바 [폴더] → 드롭다운 → 항목 클릭 → **별도 창**(`doc-<id>`)이 뜨고 그 폴더를 그린다.
//      id 는 경로에서 **결정적으로** 나온다(같은 폴더 재클릭 = 새 창이 아니라 포커스).
//   ⑥ 우클릭 → 경로 복사 → 클립보드에 **절대경로**.
//   ⑦ 갱신이 더 최신 파일을 앞에 끼워도 **선택은 그 파일에 남는다**(이름으로 붙든다). 인덱스로 들면
//      강조·Ctrl+C·Enter 가 말없이 옆 파일로 옮겨 간다 — 스크린샷 경로를 Claude 에 넘기는 그 동선이다.
//   ⑧ 같은 이름으로 다시 쓴 파일은 **썸네일이 바뀐다**(키 = 이름|mtime|크기, 칸이 새로 마운트돼 새 URL 을 받는다).
//   ⑨ 라이트박스도 이름으로 붙든다 — 갱신 뒤에도 같은 파일, 그 파일이 지워지면 닫힌다.
//   ⑩ 썸네일 크기를 S→L 로 바꾸면 그려진 칸이 전부 320px 썸네일이다(스킴 URL 의 e=320, 실제로 뜬 그림 폭 320).
//   ⑪ 툴바 "탐색기에서 이 폴더 열기"는 이 폴더 **자체**를 연다(`default`) — `reveal` 은 상위를 연다.
//   ⑫ 반대로 **아직 고르지 않은** 강조는 맨 앞(최신)을 따라간다 — 새 스크린샷을 찍고 창을 클릭하면
//      Ctrl+C 대상은 방금 찍은 것이다. ⑦ 의 "이름으로 붙들기"가 고르기 전부터 붙들면 안 된다.
//   ⑬ 타이틀바 호버 미리보기 — 패널로 **가는 길에** 스친 항목이 패널을 갈아 끼우지 않는다(멈추면 바뀐다).
//      이미지 더블클릭은 원본 라이트박스(드롭다운 위), 복사는 첫 클릭 한 번, Esc 는 라이트박스만 닫는다.
//   ⑭ 가상 그리드 — 수백 장 폴더에서 DOM 에 그린 칸은 전체보다 훨씬 적고(전체 높이는 유지), 끝까지 스크롤하면
//      마지막 칸이 보이고 썸네일이 뜨며, 키보드로 커서를 화면 밖까지 옮기면 스크롤이 따라간다.
//
// 픽스처는 이 스위트가 직접 만든다(공유 git 픽스처와 무관한 그냥 폴더다) — 끝나면 지우고
// `favoriteFolders` 설정도 되돌린다.
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

import { connectLabel, docWindowsBefore, newDocWindow } from "../lib/cdp.mjs";

export const name =
  "즐겨찾기 폴더 창 (백엔드 게이트 · 종류 분류 · 썸네일 크기 고정 · 창 라우팅 · 경로 복사 · 갱신 뒤 선택·썸네일·라이트박스 유지)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
/** 창 열거·닫기는 webviewWindow JS API 로 한다(스위트 13·50 과 같은 통로). */
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

/** 1×1 PNG — 썸네일 스킴이 실제로 디코딩할 수 있어야 하므로 유효한 파일이어야 한다. 썸네일은 edge 로
 *  키워지므로(종전 규칙) 뜬 그림의 폭이 곧 요청한 edge 다 — ⑩ 이 그것으로 크기를 잰다. */
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

  /** 썸네일 URL 의 `v` — 백엔드 `mtime_ms` 와 같은 값(ms 내림)·크기. */
  const stampOf = (p) => {
    const st = statSync(p);
    return `${Math.floor(st.mtimeMs)}-${st.size}`;
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

    // ── ④ 썸네일 스킴의 게이트 ──
    // 메인 창(앱 CSP 가 걸린 앱 페이지)에서 `new Image()` 로 직접 부른다 — 성공은 load, 거부(4xx)는 error.
    // 맞는 요청이 먼저 load 여야 뒤의 error 들이 "스킴이 통째로 죽어서"가 아니라 "거부해서"로 읽힌다.
    const tokenRes = await cdp.try("fav_thumb_token");
    const token = tokenRes.ok ? String(tokenRes.r) : "";
    const probe = (path, query) =>
      cdp.eval(`(async () => {
        const url = window.__TAURI_INTERNALS__.convertFileSrc(${J(path)}, "gpvthumb") + ${J(query)};
        return await new Promise((res) => {
          const img = new Image();
          const t = setTimeout(() => res({ r: "timeout", url }), 15000);
          img.onload = () => { clearTimeout(t); res({ r: "load", w: img.naturalWidth, url }); };
          img.onerror = () => { clearTimeout(t); res({ r: "error", url }); };
          img.src = url;
        });
      })()`);
    const aPng = join(root, "a.png");
    const q = (edge, t = token, p = aPng) => `?e=${edge}&t=${t}&v=${stampOf(p)}`;
    const okThumb = await probe(aPng, q(192));
    r.check(
      "④ 스킴: 맞는 토큰·루트 안·192 → 이미지가 뜬다(1×1 이 192px 로)",
      token.length >= 32 && okThumb?.r === "load" && okThumb.w === 192,
      `토큰=${token.length}자 ${J(okThumb)}`,
    );
    const noTok = await probe(aPng, `?e=192&v=${stampOf(aPng)}`);
    const badTok = await probe(aPng, q(192, token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")));
    r.check(
      "④ 스킴: 토큰이 없거나 한 글자라도 틀리면 실패",
      noTok?.r === "error" && badTok?.r === "error",
      `없음=${noTok?.r} 틀림=${badTok?.r}`,
    );
    const badEdge = await probe(aPng, q(256));
    r.check(
      "④ 스킴: 허용 밖 크기(256)는 실패 — 캐시가 크기마다 한 벌씩 늘어나는 것을 막는다",
      badEdge?.r === "error",
      J(badEdge),
    );
    {
      const outsidePng = join(tmpdir(), `gpv-fav-outside-${Date.now()}.png`);
      writeFileSync(outsidePng, PNG_1X1);
      // path.join 은 `..` 를 접어 버린다 — 원시 문자열로 조립해 백엔드가 그대로 받게 한다.
      const climb = [root, "..", basename(outsidePng)].join(sep);
      const out1 = await probe(outsidePng, q(192, token, outsidePng));
      const out2 = await probe(climb, q(192, token, outsidePng));
      rmSync(outsidePng, { force: true });
      r.check(
        "④ 스킴: 허용 루트 밖 파일은 맞는 토큰이어도 실패 — 절대경로로도, 루트에서 `..` 로 올라가서도",
        out1?.r === "error" && out2?.r === "error",
        `절대=${out1?.r} 올라가기=${out2?.r}`,
      );
    }

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

    // **라벨을 미리 조립할 수 없다**(태스크 73) — 프리워밍 풀에서 나온 창은 `float-pool-N` 이다.
    // 결정적인 것은 라벨이 아니라 **창 대상의 키**(`gp:doc-windows` 의 `folderWindowId(root)`)이고,
    // 싱글턴은 그 키로 걸린다. 그래서 창은 "새로 보이게 된 문서 창"으로 찾고, 결정적 id 는
    // localStorage 기록으로 따로 단언한다.
    const beforeDocs = await docWindowsBefore(cdp);
    await cdp.eval(
      `(()=>{ const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'e2e 즐겨찾기'); if (b) b.click(); return !!b; })()`,
    );
    label = (await newDocWindow(cdp, beforeDocs))?.label ?? null;
    const folderKey = folderWindowId(root);
    const folderRecord = await cdp.eval(
      `(()=>{ try{ return JSON.parse(localStorage.getItem('gp:doc-windows')||'{}')[${J(folderKey)}] || null; }catch(e){ return null; } })()`,
    );
    win = label ? await connectLabel(label, { port: cdp.cdpPort }).catch(() => null) : null;
    if (
      !r.check(
        "⑤ 항목 클릭 → 폴더 창이 뜬다(창 id 는 경로에서 결정적으로 나온다)",
        !!win && !!folderRecord && folderRecord.folder === root,
        `label=${label} id=${folderKey} 기록=${J(folderRecord)}`,
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
    // **라벨 개수로 세면 안 된다**: Tauri 라벨은 유일해서 `filter(l => l === label).length` 는
    // 언제나 0/1 이고, 창이 하나 더 떠도(새 라벨) 1 이 나온다. 이 호출로 **새로 보이게 된
    // 문서 창**의 수를 센다(태스크 73).
    const countLabel = async () => {
      const ls = await labels();
      // 열거 자체가 실패했으면 0 이 아니라 -1 — 단언이 그 자리에서 깨져야 한다.
      if (ls.some((l) => String(l).startsWith("ERR:"))) return -1;
      const now = await docWindowsBefore(cdp);
      return now.visible.filter((l) => !beforeDocs.visible.includes(l)).length;
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

    // ── ⑥-b `fav_delete`: 허용 루트 밖은 거부 · 안은 **휴지통으로** 간다 ──
    //
    // 이 커맨드는 **사용자 파일을 지운다.** 크기와 무관하게 덮어야 하는 종류이고(CLAUDE.md
    // "파일을 쓰거나 지우는 경로"), 특히 두 가지가 회귀하면 조용히 위험해진다:
    //  · 허용 루트 게이트가 느슨해지면 즐겨찾기 밖 아무 파일이나 지울 수 있다.
    //  · 휴지통이 아니라 영구 삭제로 바뀌면 오발 한 번이 되돌릴 수 없게 된다(미리보기 패널의
    //    삭제는 **확인창이 없다** — 되돌릴 수 있다는 전제로 그렇게 설계했다).
    // 휴지통 안까지는 여기서 못 본다(OS 셸 API가 필요하다). **디스크에서 사라졌고 커맨드가
    // 성공했다**까지만 재고, 영구/휴지통 구분은 수동 검증에 맡긴다 — 못 재는 것을 잰 척하지 않는다.
    {
      const victim = join(root, "지울파일.txt");
      writeFileSync(victim, "delete me");
      const outside = join(tmpdir(), `gpv-fav-outside-${Date.now()}.txt`);
      writeFileSync(outside, "must survive");

      const denied = await cdp.try("fav_delete", { path: outside });
      r.check(
        "⑥-b fav_delete: 허용 루트 **밖** 파일은 거부한다",
        !denied.ok && existsSync(outside),
        denied.ok ? "허용됨 — 게이트가 없다" : `code=${denied.code} 파일생존=${existsSync(outside)}`,
      );
      rmSync(outside, { force: true });

      const del = await cdp.try("fav_delete", { path: victim });
      r.check(
        "⑥-b fav_delete: 허용 루트 **안** 파일은 지워진다",
        del.ok && !existsSync(victim),
        `ok=${del.ok} 남음=${existsSync(victim)} ${del.message || ""}`,
      );
      const after = await cdp.try("fav_list", { path: root });
      r.check(
        "⑥-b 삭제 후 목록에서도 사라진다",
        after.ok && !(after.r ?? []).some((e) => e.name === "지울파일.txt"),
        `항목=${(after.r ?? []).map((e) => e.name).join(",")}`,
      );
    }

    // ── ⑦~⑪ 갱신 뒤에도 같은 파일을 가리키는가 ──
    // 그리드 칸 = `button.flex-col[title]`(타이틀바 버튼은 flex-col 이 아니다), 강조 칸 = border-accent.
    const grid = () =>
      win.eval(`(()=>{
        const tiles = Array.from(document.querySelectorAll('button.flex-col[title]'));
        const img = (b) => b.querySelector('img');
        return {
          order: tiles.map((b) => b.title),
          hl: tiles.filter((b) => b.classList.contains('border-accent')).map((b) => b.title),
          src: Object.fromEntries(tiles.map((b) => [b.title, (img(b) || {}).src || null])),
          // 뜬 그림의 폭(아직 안 떴거나 실패면 0) — src 만 보면 "요청은 했다"까지만 잰다.
          w: Object.fromEntries(tiles.map((b) => [b.title, img(b) && img(b).complete ? img(b).naturalWidth : 0])),
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
    // 스킴 URL 에 스탬프(v=mtime-크기)가 있다 — 다시 쓴 파일은 칸이 새로 마운트돼 **새 URL** 로 받는다. 같은 URL 이면
    // 브라우저가 immutable 캐시에서 옛 그림을 그대로 쓴다(백엔드 캐시 키가 스탬프로 갈리는 것은 Rust 테스트
    // `thumb_cache_key_changes_with_stamp_and_edge` 가 잰다).
    const isThumb = (u) => /^(http:\/\/gpvthumb\.localhost\/|gpvthumb:\/\/localhost\/)/.test(String(u || ""));
    const g8a = await poll(grid, (g) => isThumb(g.src["c.png"]) && g.w["c.png"] > 0, 40, 250);
    const src0 = g8a?.src?.["c.png"] || null;
    writeFileSync(join(root, "c.png"), PNG_BLUE);
    stamp(join(root, "c.png"), -48);
    const v1 = stampOf(join(root, "c.png"));
    await toolbar("새로고침");
    const g8 = await poll(
      grid,
      (g) => !!g.src["c.png"] && g.src["c.png"] !== src0 && g.w["c.png"] > 0,
      40,
      250,
    );
    const src1 = g8?.src?.["c.png"] || null;
    r.check(
      "⑧ 썸네일은 스킴 URL 로 뜬다 · 같은 이름으로 다시 쓴 이미지 → 새 스탬프의 URL 로 다시 받아 뜬다",
      isThumb(src0) && isThumb(src1) && src1 !== src0 && String(src1).includes(`v=${v1}`) && g8?.w?.["c.png"] > 0,
      `전=${String(src0).slice(-40)} 후=${String(src1).slice(-40)} 새스탬프=${v1}`,
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

    // ── ⑩ 크기를 S→L 로 바꾸면 그려진 칸이 전부 320px 썸네일이다 ──
    // 1×1 PNG 는 edge 로 키워지므로 뜬 그림의 폭이 곧 요청한 크기다. S(128)에서 128 을 먼저 확인해야 L 의 320 이
    // "원래 320 이었다"가 아니라 "바꿔서 320 이 됐다"로 읽힌다.
    const pngsIn = (g) => (g?.order ?? []).filter((n) => n.endsWith(".png"));
    const allAt = (g, w) => {
      const drawn = pngsIn(g).filter((n) => g.w[n] > 0);
      return drawn.length > 0 && drawn.every((n) => g.w[n] === w && String(g.src[n]).includes(`e=${w}&`));
    };
    await toolbar("작은 썸네일");
    const g10s = await poll(grid, (g) => allAt(g, 128), 40, 250);
    await toolbar("큰 썸네일");
    const g10 = await poll(grid, (g) => allAt(g, 320), 40, 250);
    const widths = (g) => J(Object.fromEntries(pngsIn(g).map((n) => [n, g?.w?.[n]])));
    r.check(
      "⑩ 썸네일 크기 S→L: 그려진 칸이 전부 128 이었다가 전부 320 이 된다(URL e=·실제 폭)",
      allAt(g10s, 128) && allAt(g10, 320),
      `S=${widths(g10s)} L=${widths(g10)}`,
    );

    // ── ⑪ 툴바 [탐색기에서 이 폴더 열기] → 이 폴더 자체(`default`) ──
    // 진짜로 부르면 사용자 화면에 탐색기가 뜬다 — 창의 `ipc.favOpen` 을 **대신** 받아 인자만 적는다.
    // `__TAURI_INTERNALS__.invoke` 는 non-writable 이라(스위트 14 #2b) 창이 **실제로 로드한** ipc 모듈을 import 해
    // 같은 객체를 만진다(vite 가 ?t=… 를 붙인다). 먼저 [새로고침]이 그 객체의 `favList` 를 부르는지 봐서 이 창이 쓰는
    // 그 ipc 라는 것을 증명한다 — 아니면 누르지 않는다(스파이가 빗나간 채 누르면 진짜 탐색기가 뜬다).
    const opened11 = await win
      .eval(`(async()=>{
        const url = performance.getEntriesByType('resource').map((e) => e.name)
          .find((n) => n.includes('/src/lib/ipc.ts')) || '/src/lib/ipc.ts';
        const m = await import(url);
        const list = m.ipc.favList;
        let listed = 0;
        m.ipc.favList = (...a) => { listed++; return list(...a); };
        try {
          const rb = Array.from(document.querySelectorAll('button')).find((x) => (x.title || '').startsWith('새로고침'));
          if (rb) rb.click();
          await new Promise((r) => setTimeout(r, 300));
        } finally {
          m.ipc.favList = list;
        }
        if (!listed) return { err: '스파이가 이 창의 ipc 에 걸렸는지 확인 안 됨 — 누르지 않는다', url };
        const open = m.ipc.favOpen;
        const calls = [];
        m.ipc.favOpen = (path, how) => { calls.push({ path, how }); return Promise.resolve(); };
        try {
          const b = Array.from(document.querySelectorAll('button')).find((x) => x.title === '탐색기에서 이 폴더 열기');
          if (!b) return { err: '버튼 없음' };
          b.click();
          return { calls };
        } finally {
          m.ipc.favOpen = open;
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

    // ── ⑭ 가상 그리드: 수백 장 폴더 ──
    // 600장(1×1 PNG)을 mtime 이 1초씩 오래되게 쓴다 — 기본 정렬(최신 먼저)에서 f000 이 맨 앞, f599 가 맨 끝이다.
    // ⑩ 이후라 보기는 L(320) 이다. 창은 ⑫ 에서 하위폴더에 있으므로 Backspace 로 루트에 올라와 들어간다.
    {
      const many = join(root, "많음");
      mkdirSync(many, { recursive: true });
      const N14 = 600;
      const now14 = Date.now();
      const name14 = (i) => `f${String(i).padStart(3, "0")}.png`;
      for (let i = 0; i < N14; i++) {
        const f = join(many, name14(i));
        writeFileSync(f, PNG_1X1);
        const t = new Date(now14 - 3600e3 - i * 1000);
        utimesSync(f, t, t);
      }
      const key14 = (k) =>
        win.eval(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(k)}, bubbles: true })); return true; })()`);
      await key14("Backspace");
      const atRoot = await poll(grid, (g) => g.order.includes("많음"), 20, 250);
      const entered14 = atRoot ? await tile("많음", "dblclick") : false;
      const inMany = await poll(grid, (g) => g.order[0] === name14(0), 40, 250);
      /** 스크롤 영역·칸 수·보이는 칸 — 칸 = `button.flex-col[title]`. */
      const view14 = () =>
        win.eval(`(() => {
          const tiles = Array.from(document.querySelectorAll('button.flex-col[title]'));
          const sc = tiles[0] && tiles[0].closest('.overflow-auto');
          if (!sc) return null;
          const R = sc.getBoundingClientRect();
          const box = (b) => { const r = b.getBoundingClientRect(); return { top: r.top - R.top, bottom: r.bottom - R.top }; };
          const inView = (b) => { const r = box(b); return r.top >= -1 && r.bottom <= R.height + 1; };
          const img = (b) => b.querySelector('img');
          const hl = tiles.find((b) => b.classList.contains('border-accent'));
          return {
            dom: tiles.length, top: sc.scrollTop, h: sc.clientHeight, sh: sc.scrollHeight,
            names: tiles.map((b) => b.title),
            hl: hl ? { name: hl.title, inView: inView(hl) } : null,
            last: (() => { const b = tiles.find((x) => x.title === ${J(name14(N14 - 1))}); if (!b) return null;
              const i = img(b); return { inView: inView(b), w: i && i.complete ? i.naturalWidth : 0, src: i ? i.src : null }; })(),
          };
        })()`);
      const v0 = await view14();
      r.check(
        "⑭ 600장 폴더: DOM 에 그린 칸은 전체보다 훨씬 적다(보이는 행만) · 전체 높이는 600장 몫이다",
        entered14 === true && !!inMany && !!v0 && v0.dom > 0 && v0.dom < 150 && v0.sh > 10 * v0.h,
        `들어감=${entered14} 칸=${v0?.dom}/${N14} 높이=${v0?.sh}/${v0?.h}`,
      );

      await win.eval(`(() => { const t = document.querySelector('button.flex-col[title]'); const sc = t && t.closest('.overflow-auto'); if (sc) sc.scrollTop = sc.scrollHeight; return !!sc; })()`);
      const vEnd = await poll(view14, (v) => v?.last?.inView === true && v.last.w > 0, 40, 250);
      r.check(
        "⑭ 끝까지 스크롤 → 마지막 칸(f599)이 화면 안에 그려지고 썸네일이 뜬다",
        vEnd?.last?.inView === true && vEnd.last.w > 0 && isThumb(vEnd.last.src),
        `마지막=${J(vEnd?.last)} 칸=${vEnd?.dom} scrollTop=${vEnd?.top}`,
      );

      // 맨 위로 돌아가 첫 칸을 고른 뒤 → 40칸 이동. 화면에는 한두 행(3열)만 보이므로 f040 은 화면 밖이다 —
      // 따라가는 스크롤이 없으면 그 칸은 DOM 에조차 없다(가상 그리드).
      await win.eval(`(() => { const t = document.querySelector('button.flex-col[title]'); const sc = t && t.closest('.overflow-auto'); if (sc) sc.scrollTop = 0; return true; })()`);
      await poll(view14, (v) => v?.names?.includes(name14(0)), 20, 150);
      const picked14 = await tile(name14(0));
      const vPick = await poll(view14, (v) => v?.hl?.name === name14(0), 20, 150);
      for (let i = 0; i < 40; i++) await key14("ArrowRight");
      const vKey = await poll(view14, (v) => v?.hl?.name === name14(40) && v.hl.inView, 20, 250);
      r.check(
        "⑭ 키보드로 커서를 화면 밖(40칸 뒤)까지 옮기면 스크롤이 따라가 그 칸이 화면 안에 있다",
        picked14 === true && vPick?.hl?.name === name14(0) && vKey?.hl?.name === name14(40) && vKey.hl.inView && vKey.top > 0,
        `고름=${J(vPick?.hl)} 이동뒤=${J(vKey?.hl)} scrollTop=${vKey?.top}`,
      );
    }

    // ── ⑬ 타이틀바 미리보기: 패널로 가는 길에 스친 항목은 패널을 갈아 끼우지 않는다 ──
    // 2026-09-17 실사례: [스크린샷] 호버 → 패널로 대각선 이동 중 [다운로드] 줄을 스침 → 패널에 들어간 **뒤에**
    // 전환 예약이 발화해 다운로드로 바뀌었다. 합성 이벤트(dispatchEvent)로는 movementX·히트 테스트가 없어
    // 이 결함이 안 보인다 — **CDP 실제 마우스**로 움직인다. 둘째 즐겨찾기는 ⑫ 가 이미지를 넣어 둔 하위폴더다.
    const set2 = await cdp.try("set_settings", {
      settings: {
        ...origSettings,
        favoriteFolders: [
          { path: root, name: "e2e 즐겨찾기" },
          { path: sub, name: "e2e 둘째" },
        ],
      },
    });
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["settings"] })`)
      .catch(() => {});
    const mouse = (type, x, y, extra = {}) =>
      cdp._send("Input.dispatchMouseEvent", { type, x, y, button: "none", buttons: 0, ...extra });
    const escKey = async () => {
      const k = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await cdp._send("Input.dispatchKeyEvent", { ...k, type: "rawKeyDown" });
      await cdp._send("Input.dispatchKeyEvent", { ...k, type: "keyUp" });
    };
    /** 두 항목의 화면 좌표 + 지금 패널 헤더(= 미리보기 중인 경로). 드롭다운이 닫혀 있으면 a·b 가 null. */
    const ddState = () =>
      cdp.eval(`(()=>{
        const btn = (t) => Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === t);
        const box = (b) => { if (!b) return null; const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, y: (r.top + r.bottom) / 2 }; };
        const a = btn('e2e 즐겨찾기');
        const dd = a && a.closest('.min-w-56');
        const panel = dd && dd.querySelector(':scope > .right-full');
        const head = panel && panel.querySelector('span');
        return { a: box(a), b: box(btn('e2e 둘째')), peek: head ? head.textContent : null };
      })()`);

    await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /즐겨찾기 폴더/.test(x.title||''));
      if (b) b.click(); return !!b; })()`);
    const dd = await poll(ddState, (v) => !!v?.a && !!v?.b, 20, 250);
    if (!r.check("⑬ 준비: 즐겨찾기 둘 등록 · 드롭다운에 두 항목", set2.ok && !!dd?.a && !!dd?.b, J(dd))) return;

    await mouse("mouseMoved", dd.a.r - 30, dd.a.y);
    const onA = await poll(ddState, (v) => v?.peek === root, 20, 150);
    // 둘째 줄에 들어가 **왼쪽으로 움직이며** 400ms 머문다(예약 박자 160ms 의 두 배 넘게) → 패널 안으로.
    const x0 = dd.b.r - 20;
    await mouse("mouseMoved", x0, dd.b.y);
    for (let i = 1; i <= 10; i++) {
      await sleep(40);
      await mouse("mouseMoved", x0 - i * 8, dd.b.y);
    }
    await mouse("mouseMoved", dd.b.l - 40, dd.b.y);
    await sleep(600);
    const aimed = await ddState();
    r.check(
      "⑬ 첫 항목 미리보기 중 둘째 줄을 **왼쪽으로 지나** 패널에 들어가면 패널은 첫 항목 그대로다",
      onA?.peek === root && aimed?.peek === root,
      `호버=${onA?.peek} 지난뒤=${aimed?.peek}`,
    );

    // 반증 대조 — 전환 자체가 죽은 게 아니다: 둘째 줄에 들어가 **멈추면** 바뀐다.
    await mouse("mouseMoved", dd.b.r - 20, dd.b.y);
    const rested = await poll(ddState, (v) => v?.peek === sub, 20, 150);
    r.check(
      "⑬ 대조: 둘째 줄 위에서 멈추면 패널이 둘째로 바뀐다",
      rested?.peek === sub,
      `멈춘뒤=${rested?.peek}`,
    );

    // ── ⑬-b 이미지 더블클릭 → 크게 보기(라이트박스) · 첫 클릭만 복사 · Esc 는 라이트박스만 닫는다 ──
    const tileBox = await poll(
      () =>
        cdp.eval(`(()=>{
          const t = Array.from(document.querySelectorAll('.right-full button[title]'))
            .find(b => (b.getAttribute('title')||'').startsWith('s2.png\\n'));
          if (!t) return null; const r = t.getBoundingClientRect();
          return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
        })()`),
      (v) => !!v,
      20,
      200,
    );
    const copyToasts = () =>
      cdp.eval(
        `window.__gpv.ui.getState().toasts.filter(t => /경로를 복사했습니다|복사에 실패했습니다/.test(t.message)).length`,
      );
    const toastsBefore = await copyToasts();
    if (tileBox) {
      await mouse("mouseMoved", tileBox.x, tileBox.y);
      const btn = { button: "left" };
      await mouse("mousePressed", tileBox.x, tileBox.y, { ...btn, buttons: 1, clickCount: 1 });
      await mouse("mouseReleased", tileBox.x, tileBox.y, { ...btn, clickCount: 1 });
      await mouse("mousePressed", tileBox.x, tileBox.y, { ...btn, buttons: 1, clickCount: 2 });
      await mouse("mouseReleased", tileBox.x, tileBox.y, { ...btn, clickCount: 2 });
    }
    const lbox = await poll(
      () =>
        cdp.eval(`(()=>{
          const img = document.querySelector('img[alt="s2.png"]');
          if (!img || !(img.getAttribute('src')||'').startsWith('data:image')) return null;
          const r = img.getBoundingClientRect();
          // 드롭다운(z-50) **위에** 그려졌는가 — 그 자리를 실제로 누르면 이미지가 맞는다.
          const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return { onTop: top === img, w: r.width };
        })()`),
      (v) => !!v,
      30,
      200,
    );
    await sleep(500); // 복사 토스트는 클립보드 쓰기 뒤에 온다
    const toastsAfter = await copyToasts();
    const afterOpen = await ddState();
    r.check(
      "⑬-b 이미지 더블클릭 → 원본 라이트박스가 드롭다운 위에 뜬다 · 드롭다운은 열린 채 · 복사 토스트는 한 번만",
      !!tileBox &&
        lbox?.onTop === true &&
        lbox.w > 0 &&
        !!afterOpen?.a &&
        toastsAfter - toastsBefore === 1,
      `칸=${J(tileBox)} 라이트박스=${J(lbox)} 드롭다운=${!!afterOpen?.a} 복사토스트 +${toastsAfter - toastsBefore}`,
    );

    await escKey();
    const lbGone = await poll(
      () => cdp.eval(`!document.querySelector('img[alt="s2.png"]')`),
      (v) => v === true,
      20,
      150,
    );
    const afterEsc = await ddState();
    r.check(
      "⑬-b Esc → 라이트박스만 닫히고 드롭다운·미리보기는 남는다",
      lbGone === true && !!afterEsc?.a && afterEsc?.peek === sub,
      `라이트박스닫힘=${lbGone} 드롭다운=${!!afterEsc?.a} 미리보기=${afterEsc?.peek}`,
    );
    await escKey(); // 드롭다운 닫기(정리)
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
