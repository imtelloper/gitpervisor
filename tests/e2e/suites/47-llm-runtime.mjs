// 태스크 59 — 로컬 LLM 런타임(llama-server) · 모델 다운로드 · 스트리밍 채팅 IPC · 설정 AI 페이지.
//
// **네트워크가 필요하다.** `E2E_NET=1` 이 아니면 전부 skip 한다(러너 기본 실행은 오프라인 가정).
// 모델(1.8~5.0GB)은 **절대 받지 않는다** — 채팅 검증은 러너가 주입한 소형 GGUF를 `custom` 경로로
// 쓴다(`E2E_LLM_GGUF=<절대경로>`). 없으면 채팅 검사(③④)만 건너뛰고 나머지는 그대로 돈다.
//
// 지키는 계약 여섯:
//   ① 런타임 다운로드가 진행률을 Channel 로 흘리고(percent 단조 증가) `.ok` 마커까지 남긴다.
//   ② 상태 커맨드가 런타임·모델·서버를 한 번에 돌려준다(설정 화면과 60·61이 공유하는 유일한 창구).
//   ③ `llm_chat` 이 토큰을 **델타로** 흘리고, 두 번째 호출은 **같은 포트**를 재사용한다
//      (재기동하면 모델 로드 20~60초를 매번 문다 — 이 재사용이 60의 배치를 성립시킨다).
//   ④ 진행 중 `llm_cancel` → 그 호출만 Cancelled 로 끝나고 **즉시 다음 호출이 된다**
//      (in-flight 슬롯이 안 비면 그 뒤 모든 AI 기능이 Busy 로 영구히 막힌다).
//   ⑤ 설정 모달에 AI 카테고리가 있고, `llmContext` 100 입력이 저장 시 2048 로 클램프된다.
//   ⑥ `llm_stop` 뒤 `llama-server` 프로세스가 남지 않는다(고아 0 — 이 앱의 OOM 이력).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "로컬 LLM 런타임 (다운로드 · 스트리밍 채팅 · 취소 · 설정 AI)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "");

/**
 * 진행 채널에서 걷어 온 원소를 JSON 객체 배열로. 채널에는 문자열이 아닌 것(스트림 종료 시 null)이
 * 섞여 올 수 있어 그대로 `JSON.parse` 하면 `null.phase` 로 스위트가 통째로 죽는다(실측).
 */
const parseMsgs = (arr) =>
  (arr ?? [])
    .filter((m) => typeof m === "string")
    .map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    })
    .filter((m) => m && typeof m === "object");

/** 진행률 Channel<String> 인자 — 수신 JSON 을 window 슬롯에 쌓는다(32-disk-usage 와 같은 방식). */
async function progressChannel(cdp, slot) {
  const rid = await cdp.eval(
    `(()=>{ window[${J(slot)}]=[]; return window.__TAURI_INTERNALS__.transformCallback((m)=>{ try{ window[${J(slot)}].push(m&&m.message); }catch(_){} }); })()`,
  );
  return {
    ref: `__CHANNEL__:${rid}`,
    drain: () =>
      cdp.eval(`(()=>{ const a=window[${J(slot)}]||[]; window[${J(slot)}]=[]; return a; })()`),
  };
}

/**
 * invoke 를 페이지에서 **기다리지 않고** 시작한다. 결과는 window 슬롯에 앉는다:
 * `{pending} | {ok:true,r} | {ok:false,code,message}`.
 *
 * 분 단위 호출(런타임 다운로드·첫 채팅)에 `cdp.invoke({timeoutMs})` 를 쓰면 안 된다 —
 * `Cdp.try` 가 그 값을 `eval` 로 넘기지 않아(`lib/cdp.mjs`) `Runtime.evaluate` 가 기본 60s 에서
 * 끊긴다. 다운로드는 계속 도는데 스위트만 거짓 실패하는 유형이다.
 */
async function startInvoke(cdp, slot, cmd, args) {
  await cdp.eval(`(()=>{ window[${J(slot)}]={pending:true};
    window.__TAURI_INTERNALS__.invoke(${J(cmd)}, ${J(args)})
      .then((r)=>{ window[${J(slot)}]={pending:false,ok:true,r}; })
      .catch((e)=>{ window[${J(slot)}]={pending:false,ok:false,code:(e&&e.code)||null,message:(e&&e.message)||String(e)}; });
    return true; })()`);
}

/** 취소 검사(④)가 진행 중에 끼어들어야 해서 채팅도 슬롯 방식으로 시작한다. */
const startChat = (cdp, slot, req, tokenRef, progRef) =>
  startInvoke(cdp, slot, "llm_chat", { req, onToken: tokenRef, onProgress: progRef });

/** 슬롯이 settle 할 때까지 폴링한다. `onTick` 은 매 폴링마다(진행 채널 drain 용). */
async function awaitSlot(cdp, slot, timeoutMs, onTick) {
  const t0 = Date.now();
  for (;;) {
    if (onTick) await onTick();
    const s = await cdp.eval(`window[${J(slot)}]`);
    if (s && !s.pending) return s;
    if (Date.now() - t0 > timeoutMs) return { pending: true, timedOut: true };
    await sleep(500);
  }
}

/** React 제어 입력에 값을 넣는다(29-settings-ux 와 같은 네이티브 setter 경로). */
const setInput = (cdp, sel, v) =>
  cdp.eval(`(() => { const i=document.querySelector(${J(sel)}); if(!i) return false;
    const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(i, ${J(String(v))}); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);

const clickByText = (cdp, text) =>
  cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${J(text)}); if(!b) return false; b.click(); return true; })()`);

export async function run({ cdp, report: r }) {
  if (process.env.E2E_NET !== "1") {
    r.skip("로컬 LLM 전체", "E2E_NET=1 이 아님 — 런타임 다운로드에 네트워크가 필요하다");
    return;
  }

  const orig = await cdp.invoke("get_settings");
  try {
    // ── ① 런타임 획득 ──
    let st = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 });
    r.check(
      "① llm_status 셰이프(runtime/models/server/customModelOk)",
      st && Array.isArray(st.models) && "runtime" in st && "server" in st && typeof st.customModelOk === "boolean",
      J({ runtime: st?.runtime, models: st?.models?.length }),
    );

    if (!st.runtimeSupported) {
      r.skip("① 런타임 다운로드", "이 플랫폼에 llama.cpp 공식 빌드가 없다(외부 URL 모드 전용)");
    } else if (st.runtime) {
      r.info(`런타임이 이미 설치돼 있다(${st.runtime}) — 다운로드는 건너뛰고 멱등만 확인한다`);
      const ch = await progressChannel(cdp, "__gpvLlmRt");
      st = await cdp.invoke("llm_runtime_ensure", { onProgress: ch.ref }, { timeoutMs: 60000 });
      const msgs = parseMsgs(await ch.drain());
      r.check(
        "① 멱등: 설치돼 있으면 즉시 done",
        st.runtime != null && msgs.some((m) => m.phase === "done") && !msgs.some((m) => m.phase === "download"),
        J(msgs.map((m) => m.phase)),
      );
    } else {
      const ch = await progressChannel(cdp, "__gpvLlmRt");
      const all = [];
      // 채널은 drain 으로만 비워지므로 진행 중 계속 걷어 온다(단조 증가 판정에 전량이 필요).
      await startInvoke(cdp, "__gpvLlmRtDone", "llm_runtime_ensure", { onProgress: ch.ref });
      const res = await awaitSlot(cdp, "__gpvLlmRtDone", 900000, async () => {
        all.push(...parseMsgs(await ch.drain()));
      });
      all.push(...(await ch.drain()).map((m) => JSON.parse(m)));
      r.check(
        "① llm_runtime_ensure 성공",
        res.ok === true,
        res.timedOut ? "15분 안에 끝나지 않았다" : `${res.code ?? ""} ${res.message ?? ""}`.trim(),
      );

      const pcts = all.filter((m) => m.phase === "download" && m.percent != null).map((m) => m.percent);
      r.check("① 진행 이벤트 수신(download %)", pcts.length > 0, `${pcts.length}건`);
      r.check(
        "① percent 단조 증가",
        pcts.every((v, i) => i === 0 || v >= pcts[i - 1]),
        `${pcts[0]}…${pcts[pcts.length - 1]}`,
      );
      r.check("① 마지막 phase=done", all.at(-1)?.phase === "done", J(all.at(-1)));

      st = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 });
      r.check("① 설치 마커(.ok) 반영 — status.runtime 채워짐", st.runtime != null, `${st.runtime}`);
      r.check("① runtimePath 가 실재 파일", !!st.runtimePath && existsSync(st.runtimePath), `${st.runtimePath}`);
    }

    // ── ②③④ 채팅 — 소형 GGUF 주입이 있을 때만 ──
    const gguf = process.env.E2E_LLM_GGUF;
    const haveModel = !!gguf && existsSync(gguf);
    if (!haveModel) {
      r.skip("③ 스트리밍 채팅 · 서버 재사용", "E2E_LLM_GGUF 미주입 — 카탈로그 모델(1.8GB+)은 받지 않는다");
      r.skip("④ 요청 취소 후 즉시 재요청", "E2E_LLM_GGUF 미주입");
    } else {
      await cdp.invoke("set_settings", {
        settings: { ...orig, llmProvider: "managed", llmModel: "custom", llmCustomModelPath: gguf },
      });
      const tok = await progressChannel(cdp, "__gpvLlmTok");
      const prog = await progressChannel(cdp, "__gpvLlmProg");

      // ③ 첫 호출 — 서버 기동 + 모델 로드 포함.
      await startChat(
        cdp,
        "__gpvLlmA",
        { messages: [{ role: "user", content: "Reply with the single word OK" }], maxTokens: 16, requestId: "e2e-a" },
        tok.ref,
        prog.ref,
      );
      const a = await awaitSlot(cdp, "__gpvLlmA", 300000);
      const tokensA = await tok.drain();
      r.check("③ 첫 호출 성공", a.ok === true, a.ok ? "" : `${a.code} ${a.message}`);
      r.check("③ 토큰이 델타로 1건 이상 도착", tokensA.length >= 1, `${tokensA.length}개`);
      r.check("③ ChatDone.text 비어 있지 않음", !!a.r?.text?.length, J(a.r?.text?.slice(0, 60)));
      r.check(
        "③ 델타 이어붙인 값 == ChatDone.text",
        tokensA.join("") === (a.r?.text ?? ""),
        `${tokensA.join("").length} vs ${a.r?.text?.length}`,
      );

      const s1 = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 });
      r.check("③ status.server.ready", s1?.server?.ready === true, J(s1?.server));

      // ③ 두 번째 호출 — **같은 포트**여야 한다(재기동이면 모델 로드를 또 문다).
      await startChat(
        cdp,
        "__gpvLlmB",
        { messages: [{ role: "user", content: "Reply with the single word OK" }], maxTokens: 16, requestId: "e2e-b" },
        tok.ref,
        prog.ref,
      );
      const b = await awaitSlot(cdp, "__gpvLlmB", 120000);
      await tok.drain();
      const s2 = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 });
      r.check("③ 두 번째 호출 성공", b.ok === true, b.ok ? "" : `${b.code} ${b.message}`);
      r.check("③ 서버 재사용(포트 동일)", s1?.server?.port === s2?.server?.port, `${s1?.server?.port} → ${s2?.server?.port}`);

      // ④ 취소 — 진행 중 llm_cancel → Cancelled, 그 직후 다음 호출이 Busy 없이 된다.
      await startChat(
        cdp,
        "__gpvLlmC",
        { messages: [{ role: "user", content: "Count slowly from 1 to 200, one number per line." }], maxTokens: 512, requestId: "e2e-c" },
        tok.ref,
        prog.ref,
      );
      await sleep(1200);
      await cdp.invoke("llm_cancel", { requestId: "e2e-c" }, { timeoutMs: 10000 });
      const c = await awaitSlot(cdp, "__gpvLlmC", 30000);
      await tok.drain();
      r.check("④ 취소된 호출은 Cancelled", c.ok === false && c.code === "CANCELLED", `${c.code} ${c.message}`);

      await startChat(
        cdp,
        "__gpvLlmD",
        { messages: [{ role: "user", content: "Reply with the single word OK" }], maxTokens: 16, requestId: "e2e-d" },
        tok.ref,
        prog.ref,
      );
      const d = await awaitSlot(cdp, "__gpvLlmD", 120000);
      await tok.drain();
      r.check("④ 취소 직후 다음 호출 성공(in-flight 슬롯 해제)", d.ok === true, d.ok ? "" : `${d.code} ${d.message}`);
    }

    // ── ⑤ 설정 모달 ──
    const src = readFileSync(`${REPO}/src/components/settings/settings-index.ts`, "utf8");
    const indexed = new Set([...src.matchAll(/key:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
    const llmKeys = Object.keys(orig).filter((k) => k.startsWith("llm"));
    const missing = llmKeys.filter((k) => !indexed.has(k));
    r.check(
      "⑤ SETTINGS_INDEX가 llm* 키 전부 커버(29 ⑤ 부분집합)",
      // 11 = provider·model·reportModel·customModelPath·externalUrl·externalModel·externalKey·gpuLayers·context·
      // language·backend. llmReportModel(태스크 70)이 들어올 때 10에서 안 올려 E2E_NET 회차에서만 빨갰다(태스크 72 §2.1).
      llmKeys.length === 11 && missing.length === 0,
      missing.length ? `누락: ${missing.join(",")}` : `${llmKeys.length}키`,
    );

    await cdp.eval(`window.__gpv.ui.getState().openSettings("ai")`);
    await sleep(500);
    const shell = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'AI');
      return { exists: !!b, active: !!b && b.className.includes('border-accent'), body: document.body.textContent.includes('런타임') };
    })()`);
    r.check("⑤ AI 카테고리 버튼 + 딥링크 활성", shell.exists && shell.active && shell.body, J(shell));

    // 고급 접기를 펴야 컨텍스트 입력이 DOM 에 생긴다.
    await cdp.eval(`(() => { const d=document.querySelector('details'); if(d) d.open = true; })()`);
    await sleep(200);
    const put = await setInput(cdp, 'input[type=number][min="2048"]', "100");
    r.check("⑤ 컨텍스트 입력 발견", put === true);
    await sleep(150);
    await clickByText(cdp, "저장");
    await sleep(700);
    const saved = await cdp.invoke("get_settings");
    r.check("⑤ llmContext 100 → 2048 클램프", saved.llmContext === 2048, `${saved.llmContext}`);
    await cdp.eval(`window.__gpv.ui.getState().setSettingsOpen(false)`);
    await sleep(200);

    // ── ⑥ 종료 후 고아 0 ──
    await cdp.invoke("llm_stop", {}, { timeoutMs: 10000 });
    await sleep(1500);
    const snap = await cdp.invoke(
      "sys_process_snapshot",
      { sortBy: "ram", limit: 400, groupByName: false },
      { timeoutMs: 15000 },
    );
    const leftover = (snap?.processes ?? []).filter((p) => /llama-server/i.test(p.name));
    r.check("⑥ llm_stop 후 llama-server 잔존 0", leftover.length === 0, `${leftover.length}개`);
    const s3 = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 });
    r.check("⑥ status.server = null", s3?.server == null, J(s3?.server));
  } finally {
    await cdp.invoke("set_settings", { settings: orig });
    await cdp.eval(`window.__gpv.ui.getState().setSettingsOpen(false)`).catch(() => {});
  }
}
