// 플로팅 터미널 창 (#3) — open_float_window 가 살아있는 PTY를 별도 OS 창으로 띄우는지 검증.
// 창 생성→존재 확인→close()→소멸까지 한 사이클. (창 열거/닫기는 webviewWindow JS API,
// dev 빌드에서 /node_modules 경로로 로드된다 — e2e는 dev 빌드 전용.)
//
// 라벨은 `float-<paneId>`가 **아닐 수 있다** — 프리워밍 풀(lib.rs FLOAT_POOL)이 비어 있을 때만
// 그 이름으로 직접 만들고, 풀에 대기 창이 있으면 숨겨져 있던 `float-pool-N`을 claim해 show 한다.
// 그래서 창 식별은 라벨 상수가 아니라 "새로 **보이게 된** float-* 창"으로 한다(아래 openFloat).
//
// redock(되돌리기) 케이스: 플로팅 창의 버튼은 이 러너의 CDP(메인 페이지 1개)로 누를 수 없으므로,
// FloatingTerminal.tsx가 하는 것과 같은 두 단계를 메인에서 직접 재현한다 —
// float_redock_begin 등록 → 창 close → `terminals://cmd` emit. 그 뒤 PTY 생존과 메인 탭 편입을 본다.

export const name = "플로팅 창 (open_float_window)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";
const EVT_API = "/node_modules/@tauri-apps/api/event.js";
const LABEL_EXPR = "window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label";

/**
 * 한 페이지에 붙는 **최소** CDP 클라이언트 — eval 하나뿐이다.
 * 러너의 `cdp`는 라벨 `main` 페이지 하나라(lib/cdp.mjs connect) 플로팅 창의 DOM을 못 본다.
 * lib/cdp.mjs에 export를 늘리는 대신(다른 작업이 편집 중인 파일) 여기서 필요한 만큼만 갖는다.
 * 연결 실패는 throw 없이 null — 풀 창이 방금 닫혔을 수 있다.
 */
async function attachPage(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const ok = await new Promise((res) => {
    ws.onopen = () => res(true);
    ws.onerror = () => res(false);
  });
  if (!ok) return null;
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const fn = pending.get(msg.id);
    if (fn) {
      pending.delete(msg.id);
      fn(msg);
    }
  };
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++seq;
      const timer = setTimeout(() => {
        pending.delete(mid);
        rej(new Error(`CDP ${method} 응답 시간 초과`));
      }, 20000);
      pending.set(mid, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  await send("Runtime.enable");
  return {
    eval: async (expression) => {
      const res = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const d = res.result?.exceptionDetails;
      if (d) throw new Error(`page eval 예외: ${d.exception?.description || d.text || ""}`);
      return res.result?.result?.value;
    },
    close: () => {
      try {
        ws.close();
      } catch (_) {
        /* noop */
      }
    },
  };
}

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  const TID = "gpv-e2e-float"; // 기존 케이스 — 생성·소멸
  const TID_R = "gpv-e2e-redock"; // redock — 창이 죽어도 PTY 생존
  const TID_N = "gpv-e2e-noredock"; // 회귀 가드 — 미등록이면 기존대로 PTY 종료
  const TID_H = "gpv-e2e-float-hist"; // 히스토리 마스터 토글·토스트 호스트
  const TID_S = "gpv-e2e-float-size"; // PTY 크기 자가 복구
  const opened = new Set(); // finally 정리용(실패로 빠져나가도 창을 남기지 않는다)
  let redockTabId = null;

  const arr = (v) => (Array.isArray(v) ? v : []);
  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );
  // 보이는 플로팅 창만 — 풀의 대기 창은 숨김(visible(false))이라 여기 안 잡힌다(실측 확인).
  const visibleFloats = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${J(WIN_API)}); const out=[];
         for(const w of await m.getAllWebviewWindows())
           if(w.label.startsWith("float-") && await w.isVisible()) out.push(w.label);
         return out; }catch(e){ return []; } })()`,
    );
  const closeLabel = (label) =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${J(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);
  const gone = async (label) => {
    for (let i = 0; i < 14; i++) {
      await sleep(500);
      const ls = await labels();
      if (Array.isArray(ls) && !ls.includes(label)) return true;
    }
    return false;
  };

  /**
   * 플로팅 창을 열고 그 창의 라벨을 알아낸다. claim 직후 풀이 **다음 숨김 창을 보충**하므로
   * "새로 생긴 라벨"만 보면 보충 창을 잡는다. 그래서 후보를 두 가지로 좁힌다:
   *   (a) `float-<paneId>` — 풀이 비어 직접 생성된 창
   *   (b) 호출 전에 **이미 있던** 라벨이 새로 보이게 된 것 — claim된 풀 창
   * 보충 창은 "새 라벨 + 숨김"이라 둘 중 어디에도 걸리지 않는다.
   */
  const openFloat = async (termId) => {
    const beforeAll = arr(await labels());
    const beforeVis = arr(await visibleFloats());
    const origin = await cdp.eval(`window.location.origin`);
    const res = await cdp.try("open_float_window", { paneId: termId, origin });
    if (!res.ok) return { res, label: null };
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const fresh = arr(await visibleFloats()).filter((l) => !beforeVis.includes(l));
      const label =
        fresh.find((l) => l === `float-${termId}`) ?? fresh.find((l) => beforeAll.includes(l));
      if (label) {
        opened.add(label);
        return { res, label };
      }
    }
    return { res, label: null };
  };

  const openPty = async (termId) => {
    const ch = await cdp.openChannel();
    return cdp.try("term_open", {
      termId,
      projectId: fix.projectId,
      cols: 80,
      rows: 24,
      onData: ch.ref,
    });
  };

  const poll = async (fn, ok, tries = 20, ms = 300) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  /** 라벨이 label인 플로팅 페이지에 두 번째 CDP를 붙인다. 풀 보충 창도 float-* 라벨이라
   *  **정확히 일치**하는 것만 채택하고 나머지 연결은 즉시 닫는다(cdp.mjs connect와 같은 규칙). */
  const attachFloat = async (label) => {
    for (let i = 0; i < 20; i++) {
      const list = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((res) => res.json())
        .catch(() => []);
      for (const p of (Array.isArray(list) ? list : []).filter((t) => t.type === "page")) {
        const c = await attachPage(p).catch(() => null);
        if (!c) continue;
        if ((await c.eval(LABEL_EXPR).catch(() => null)) === label) return c;
        c.close();
      }
      await sleep(500);
    }
    return null;
  };

  try {
    // ── 기존 케이스: 살아있는 PTY 하나 → 플로팅 창이 term_attach로 이어받는다 ──
    const open = await openPty(TID);
    if (!r.check("term_open: 플로팅용 PTY 생성", open.ok, open.code || "")) return;

    const baseline = await labels();
    r.check(
      "사전: 이 pane의 플로팅 창 없음",
      Array.isArray(baseline) && !baseline.includes(`float-${TID}`),
      arr(baseline).join(","),
    );

    const first = await openFloat(TID);
    r.check(
      "open_float_window: 호출 성공",
      first.res.ok,
      first.res.ok ? "" : `${first.res.code || ""} ${first.res.message || ""}`,
    );
    r.check("open_float_window: 플로팅 OS 창이 떴다", !!first.label, first.label || "미발견");

    if (first.label) {
      await closeLabel(first.label);
      const dead = await gone(first.label);
      opened.delete(first.label);
      r.check("플로팅 창: close()로 정상 소멸", dead, first.label);
    }

    // ── redock: float_redock_begin 등록 → 창 close → PTY 생존 → 메인 탭으로 편입 ──
    const openR = await openPty(TID_R);
    if (!r.check("term_open: redock용 PTY 생성", openR.ok, openR.code || "")) return;

    const fl = await openFloat(TID_R);
    r.check("redock: 플로팅 창이 떴다", !!fl.label, fl.label || "미발견");

    if (fl.label) {
      const begin = await cdp.try("float_redock_begin", { termIds: [TID_R] });
      r.check(
        "float_redock_begin: 우회 등록 성공",
        begin.ok,
        begin.ok ? "" : `${begin.code || ""} ${begin.message || ""}`,
      );

      await closeLabel(fl.label);
      const dead = await gone(fl.label);
      opened.delete(fl.label);
      r.check("redock: 창은 닫힌다", dead, fl.label);

      // Destroyed 훅이 close_unless_redocking으로 들어간 뒤를 본다 — 등록된 id면 PTY를 살려 둔다.
      await sleep(1500);
      const alive = await cdp.try("term_project", { termId: TID_R });
      r.check(
        "redock: 창이 닫혀도 PTY 생존(Destroyed 우회)",
        alive.ok && alive.r != null,
        `term_project=${J(alive.r ?? null)}`,
      );

      // FloatingTerminal의 4단계(sendTerminalsCmd)와 같은 경로 — 메인 창이 자기 리스너로 받아
      // openTerminal(projectId, { paneId })로 살아있는 pane을 담은 새 탭을 만든다.
      const emitted = await cdp
        .eval(
          `(async()=>{ try{ const m=await import(${J(EVT_API)});
             await m.emitTo("main","terminals://cmd",{op:"openTerminal",projectId:${J(fix.projectId)},paneId:${J(TID_R)}});
             return true; }catch(e){ return 'ERR:'+String(e.message||e); } })()`,
        )
        .catch((e) => `ERR:${e.message}`);
      r.check("redock: terminals://cmd emit 성공", emitted === true, String(emitted));

      const hasStore = await cdp.eval(`typeof window.__gpv?.terminals?.getState === "function"`);
      if (!hasStore) {
        r.skip("redock: 메인 스토어에 pane 편입", "window.__gpv 미노출(dev 빌드 아님)");
      } else {
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          redockTabId = await cdp.eval(
            `(()=>{ const t=window.__gpv.terminals.getState().terminals||[];
               const f=t.find(x=>JSON.stringify(x.layout).includes(${J(TID_R)})); return f?f.id:null; })()`,
          );
          if (redockTabId) break;
        }
        r.check(
          "redock: 메인 스토어에 그 pane을 담은 탭 생성",
          !!redockTabId,
          redockTabId || "탭 없음",
        );

        // 정리이자 검증 — 되돌아온 탭을 닫으면 PTY도 함께 죽어야 한다(고아 셸 방지).
        if (redockTabId) {
          await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(redockTabId)})`);
          let closed = false;
          for (let i = 0; i < 8; i++) {
            await sleep(500);
            const p = await cdp.try("term_project", { termId: TID_R });
            if (p.ok && p.r == null) {
              closed = true;
              break;
            }
          }
          redockTabId = null;
          r.check("redock 정리: 탭을 닫으면 PTY도 종료", closed);
        }
      }
    }

    // ── 히스토리 마스터 토글 + 토스트 호스트(태스크 25) ──
    const openH = await openPty(TID_H);
    if (r.check("term_open: 히스토리용 PTY 생성", openH.ok, openH.code || "")) {
      const fh = await openFloat(TID_H);
      const fcdp = fh.label ? await attachFloat(fh.label) : null;
      if (!fcdp)
        r.skip(
          "플로팅 창 히스토리 마스터 토글",
          fh.label ? "플로팅 페이지 CDP 연결 실패" : "창 미발견",
        );
      else {
        const openCols = () =>
          fcdp.eval(`document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length`);
        const clickMaster = () =>
          fcdp.eval(`(()=>{ const b=[...document.querySelectorAll('header button')].find(x=>/히스토리/.test(x.textContent||''));
            if(b){ b.click(); return true; } return false; })()`);
        try {
          // 시드 완료(attach 뒤 로컬 스토어에 탭 1개) → 창 안에서 분할 → pane 2개. 메인 스토어는 불변.
          const seeded = await poll(
            () => fcdp.eval(`window.__gpv.terminals.getState().terminals.length`),
            (n) => n === 1,
          );
          r.check("플로팅 창: 로컬 스토어 시드", seeded === 1, `tabs=${seeded}`);
          // **분리한 창에서도 Shift/Alt+Enter 가 같은 바이트로 나가야 한다.** 이 창의 xterm 은
          // 살아 있는 PTY 에 `term_attach` 로 붙어 ConPTY 시작 프리앰블(`\x1b[?9001h`)을 다시 못
          // 본다 — 감지에만 기대면 Windows 에서 win32Input 이 false 로 남아 `\x1b\r` 폴백을 타고,
          // Claude Code 에서 줄바꿈이 안 된다(태스크 32 의 경로가 분리 창에서만 새던 구멍).
          const fWin32 = await poll(
            () =>
              fcdp.eval(`(()=>{ const s=window.__gpv.terminals.getState(); const t=s.terminals[0];
                const i = t && window.__gpv.term.get(t.activePaneId); return i ? i.win32Input : null; })()`),
            (v) => v !== null,
          );
          const fIsWin = await fcdp.eval(`/Windows/i.test(navigator.userAgent)`);
          r.check(
            "플로팅 창(attach)도 win32-input-mode 로 친다 — Shift/Alt+Enter 가 메인과 같은 바이트",
            fWin32 === fIsWin,
            `win32Input=${fWin32} isWindows=${fIsWin}`,
          );
          const mainTabs = await cdp.eval(`window.__gpv.terminals.getState().terminals.length`);
          await fcdp.eval(`(()=>{ const s=window.__gpv.terminals.getState(); const t=s.terminals[0];
            s.splitPane(t.id, t.activePaneId, "row", false); })()`);
          const panes = await poll(
            () => fcdp.eval(`document.querySelectorAll('.xterm').length`),
            (n) => n >= 2,
          );
          r.check("플로팅 창: 분할로 pane 2개", panes >= 2, `xterm=${panes}`);
          r.check(
            "분할이 메인 스토어를 건드리지 않음(창별 독립)",
            (await cdp.eval(`window.__gpv.terminals.getState().terminals.length`)) === mainTabs,
          );

          r.check("사전: 프롬프트 컬럼 0개", (await openCols()) === 0);
          r.check("타이틀바에 히스토리 버튼 존재·클릭", await clickMaster());
          const openedCols = await poll(openCols, (n) => n === panes); // `opened`(Set)와 이름 충돌 금지
          r.check("마스터 켬 → 이 창의 모든 pane에 컬럼", openedCols === panes, `${openedCols}/${panes}`);
          // 상태는 세션 단위 영속 — 같은 origin localStorage를 메인 페이지에서 읽어 확인(promptHistory PANEL_KEY).
          const persisted = await cdp.eval(
            `(()=>{ try { return !!JSON.parse(localStorage.getItem('gp:prompt-panel-open')||'{}')[${J(TID_H)}]; } catch { return false; } })()`,
          );
          r.check("열림 상태 localStorage 영속(메인에서 관측)", persisted === true);

          await clickMaster();
          const closed = await poll(openCols, (n) => n === 0);
          r.check("마스터 끔 → 컬럼 0개", closed === 0, `cols=${closed}`);

          // 토스트 호스트 — 항목 클릭은 클립보드를 건드리므로 pushToast로 호스트 존재만 확인.
          await fcdp.eval(`window.__gpv.ui.getState().pushToast("success","e2e-float-toast")`);
          const toast = await poll(
            () => fcdp.eval(`document.body.textContent.includes('e2e-float-toast')`),
            (v) => v === true,
            10,
            200,
          );
          r.check("플로팅 창에 토스트 렌더(호스트 존재)", toast === true);
          await fcdp
            .eval(
              `(()=>{ const u=window.__gpv.ui.getState(); u.toasts.forEach(t=>u.dismissToast(t.id)); })()`,
            )
            .catch(() => {});
        } finally {
          // 컬럼이 열린 채 창을 닫으면 gp:prompt-panel-open에 e2e id가 남는다 — 끄고 닫는다(best-effort).
          await fcdp
            .eval(
              `(()=>{ const n=document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length;
                if(n){ const b=[...document.querySelectorAll('header button')].find(x=>/히스토리/.test(x.textContent||'')); b&&b.click(); } })()`,
            )
            .catch(() => {});
          fcdp.close();
          if (fh.label) {
            await closeLabel(fh.label);
            opened.delete(fh.label);
          }
        }
      }
    }

    // ── 회귀 가드: 등록 없이 닫으면 기존 동작 그대로 PTY가 죽는다 ──
    // (redock 케이스 뒤에 둔다 — redock_skip에 잔여가 남았다면 여기서 PTY가 살아남아 실패한다.)
    const openN = await openPty(TID_N);
    if (!r.check("term_open: 회귀 가드용 PTY 생성", openN.ok, openN.code || "")) return;

    const fn = await openFloat(TID_N);
    r.check("회귀 가드: 플로팅 창이 떴다", !!fn.label, fn.label || "미발견");

    if (fn.label) {
      await closeLabel(fn.label);
      const dead = await gone(fn.label);
      opened.delete(fn.label);
      r.check("회귀 가드: 창은 닫힌다", dead, fn.label);

      let killed = false;
      let last = null;
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        last = await cdp.try("term_project", { termId: TID_N });
        if (last.ok && last.r == null) {
          killed = true;
          break;
        }
      }
      r.check(
        "회귀 가드: 미등록 창을 닫으면 PTY 종료(우회는 1회성)",
        killed,
        `term_project=${J(last?.r ?? null)}`,
      );
    }
    // ── PTY 크기 자가 복구 (2026-09-23 실사례) ──
    //
    // 분리 창의 PTY 크기는 `fit()`이 xterm 크기를 **바꿀 때만** 갱신된다(onResize → term_resize).
    // 그 한 번을 놓치면 되돌릴 경로가 없어 PTY가 옛 크기에 박제된다 — 실제로 창은 950×1028인데
    // PTY는 분리 시점 900×600(37행) 그대로라 Claude Code TUI가 창 위쪽 37행에만 그려진 채 하루를
    // 갔다. 놓치는 경로는 여럿이라(가려진 창의 ResizeObserver 지연·최소화 중 크기 변경·절전 복귀)
    // 원인을 하나씩 막는 대신 코어가 **마지막 크기를 한 번 더 보낸다**(lib/terminal.ts).
    //
    // 관측은 **셸에게 직접 묻는다** — IPC 호출을 세는 것으로는 PTY가 실제로 그 크기가 됐음을
    // 증명하지 못한다(스위트 14 #2b와 같은 이유). 축소가 실제로 먹었다는 전제를 먼저 단언해
    // "복구됐다"가 공허해지지 않게 한다.
    const openS = await openPty(TID_S);
    if (r.check("term_open: 크기 복구용 PTY 생성", openS.ok, openS.code || "")) {
      const fsz = await openFloat(TID_S);
      const fcdp = fsz.label ? await attachFloat(fsz.label) : null;
      if (!fcdp)
        r.skip(
          "분리 창 PTY 크기 자가 복구",
          fsz.label ? "플로팅 페이지 CDP 연결 실패" : "창 미발견",
        );
      else {
        try {
          const probe = await fcdp.eval(
            `(async()=>{
              const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
              let inst = null;
              for (let i = 0; i < 40 && !inst; i++) {
                inst = window.__gpv?.term?.get(${J(TID_S)}) ?? null;
                if (!inst) await new Promise((r) => setTimeout(r, 250));
              }
              if (!inst) return { skip: "이 창에 xterm 인스턴스가 아직 없다" };
              const read = () => { const b = inst.term.buffer.active; let s = "";
                for (let i = Math.max(0, b.length - 60); i < b.length; i++)
                  s += (b.getLine(i)?.translateToString(true) ?? "") + "\\n";
                return s; };
              // 정규식을 조립하지 않는다(스위트 14 #2b 주석) — 태그 뒤 숫자는 손으로 판다.
              const grab = (tag) => { const s = read(), key = tag + ":"; let out = null, i = -1;
                while ((i = s.indexOf(key, i + 1)) >= 0) {
                  const rest = s.slice(i + key.length), e = rest.indexOf(":");
                  if (e > 0) { const p = rest.slice(0, e).split("x");
                    const w = Number(p[0]), h = Number(p[1]);
                    if (w > 0 && h > 0) out = { w, h }; } }
                return out; };
              const ask = async (tag) => {
                try {
                  await inv("term_write", { termId: inst.id,
                    data: 'Write-Host "' + tag + ':$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height):"\\r' });
                } catch (e) { return null; }
                for (let i = 0; i < 36; i++) { const v = grab(tag); if (v) return v;
                  await new Promise((r) => setTimeout(r, 250)); }
                return null;
              };
              const before = await ask("GPVF0");
              if (!before) return { skip: "셸이 크기를 보고하지 않는다(비-PowerShell 또는 미준비)" };
              // 크기 변화를 놓친 상태를 그대로 만든다 — PTY만 줄이고 xterm 은 그대로 둔다.
              await inv("term_resize", { termId: inst.id, cols: 40, rows: 10 });
              const stale = await ask("GPVF1");
              // 복구 지점: 창이 다시 보이는 순간(사용자가 창을 클릭·복원하는 그 동작).
              window.dispatchEvent(new Event("focus"));
              let after = await ask("GPVF2");
              for (let i = 0; i < 6 && (after?.w !== inst.term.cols || after?.h !== inst.term.rows); i++) {
                await new Promise((r) => setTimeout(r, 500));
                after = await ask("GPVF2" + i); // 태그를 바꾼다 — 같은 태그면 grab 이 옛 답을 집는다
              }
              return { want: { w: inst.term.cols, h: inst.term.rows }, before, stale, after };
            })()`,
          );
          if (probe?.skip) r.skip("분리 창 PTY 크기 자가 복구", probe.skip);
          else {
            r.check(
              "전제: PTY 축소가 실제로 먹는다(40x10)",
              probe?.stale?.w === 40 && probe?.stale?.h === 10,
              `40x10 기대 · 실제 ${J(probe?.stale ?? null)}`,
            );
            r.check(
              "창이 다시 보이면 PTY 크기가 그 창 xterm 크기로 돌아온다",
              probe?.after?.w === probe?.want?.w && probe?.after?.h === probe?.want?.h,
              `xterm ${J(probe?.want)} · 분리 직후 ${J(probe?.before)} → 축소 ${J(probe?.stale)} → 복구 ${J(probe?.after)}`,
            );
          }
        } finally {
          fcdp.close();
        }
      }
    }
  } finally {
    // 잔여 창/탭/세션 정리 — 다음 실행·사용자 화면에 흔적 안 남기기(이미 정리됐어도 무해).
    for (const label of opened) await closeLabel(label);
    if (redockTabId)
      await cdp
        .eval(`window.__gpv?.terminals?.getState().closeTab(${J(redockTabId)})`)
        .catch(() => {});
    await sleep(300);
    for (const id of [TID, TID_R, TID_N, TID_H, TID_S]) await cdp.try("term_close", { termId: id });
  }
}
