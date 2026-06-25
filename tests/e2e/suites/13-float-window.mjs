// 플로팅 터미널 창 (#3) — open_float_window 가 살아있는 PTY를 별도 OS 창(label `float-<paneId>`)으로
// 띄우는지 검증. 창 생성→존재 확인→close()→소멸까지 한 사이클. (창 열거/닫기는 webviewWindow JS API,
// dev 빌드에서 /node_modules 경로로 로드된다 — e2e는 dev 빌드 전용.)

export const name = "플로팅 창 (open_float_window)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

export async function run({ cdp, report: r, fix }) {
  const TID = "gpv-e2e-float";
  const label = `float-${TID}`;

  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${JSON.stringify(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );
  const closeFloat = () =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${JSON.stringify(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${JSON.stringify(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);

  try {
    // 살아있는 PTY 하나 — 플로팅 창이 term_attach로 이어받는다.
    const ch = await cdp.openChannel();
    const open = await cdp.try("term_open", {
      termId: TID,
      projectId: fix.projectId,
      cols: 80,
      rows: 24,
      onData: ch.ref,
    });
    if (!r.check("term_open: 플로팅용 PTY 생성", open.ok, open.code || "")) return;

    const baseline = await labels();
    r.check(
      "사전: 플로팅 창 없음(main만)",
      Array.isArray(baseline) && !baseline.includes(label),
      Array.isArray(baseline) ? baseline.join(",") : String(baseline),
    );

    const origin = await cdp.eval(`window.location.origin`);
    const created = await cdp.try("open_float_window", { paneId: TID, origin });
    r.check(
      "open_float_window: 호출 성공",
      created.ok,
      created.ok ? "" : `${created.code || ""} ${created.message || ""}`,
    );

    // 창 생성 폴링(최대 ~8s — 새 OS 창 + 웹뷰 초기화)
    let has = false;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const ls = await labels();
      if (Array.isArray(ls) && ls.includes(label)) {
        has = true;
        break;
      }
    }
    r.check("open_float_window: float-<paneId> OS 창 생성됨", has, label);

    // close() → 소멸 폴링
    if (has) {
      await closeFloat();
      let gone = false;
      for (let i = 0; i < 14; i++) {
        await sleep(500);
        const ls = await labels();
        if (Array.isArray(ls) && !ls.includes(label)) {
          gone = true;
          break;
        }
      }
      r.check("플로팅 창: close()로 정상 소멸", gone);
    }
  } finally {
    // 잔여 창/세션 정리 — 다음 실행·사용자 화면에 흔적 안 남기기.
    await closeFloat();
    await sleep(300);
    await cdp.try("term_close", { termId: TID });
  }
}
