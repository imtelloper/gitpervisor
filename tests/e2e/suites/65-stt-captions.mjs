// 태스크 72 P1 — 음성 인식 자막: 엔진 획득 → 실제 전사 → 문서 → 취소 잔존 0.
//
// **네트워크가 필요하다.** `E2E_NET=1` 이 아니면 전부 skip(47과 같은 게이트). 엔진(b5130 CPU, ~8.5MB)과 Silero VAD(0.9MB)는
// 실제로 받는다 — 카탈로그 모델(57~547MB)은 받지 않고, 러너가 주입한 ggml-tiny(`E2E_STT_MODEL=<절대경로>`, 77MB,
// sha256 고정)를 엔진 옆 `llm/models/`에 넣어 디버그 빌드 전용 모델 id `e2e-tiny`로 부른다(stt/acquire.rs E2E_MODEL).
// 없으면 전사 검사만 건너뛴다. 음성 픽스처는 whisper.cpp `samples/jfk.wav`(MIT, 11초) — `E2E_STT_WAV`로 주거나
// b5130 태그에서 받는다(sha256 고정).
//
// 지키는 계약:
//   ① `stt_runtime_ensure`가 진행을 Channel로 흘리고 관리형 엔진·VAD가 설치된다(멱등).
//   ② 스토어 `transcribe` → 진행 이벤트(추출 → 인식, 단조 증가) → 문서: "country" 포함 · cue 시각 단조·길이 이내 ·
//      단어 시각 dtw · 감지 언어 en · 다시 읽어도 같은 문서 · 완료 토스트 · 임시 WAV·JSON 삭제.
//   ②b 오디오 트랙 고르기(P3): 사인파 + jfk 두 트랙에서 둘째(audioStream 1) → "country" · 문서 source.audioStream 1 ·
//      없는 트랙 번호는 거절.
//   ③ 전사는 앱 전체에서 하나(두 번째는 BUSY).
//   ④ 인식 중 취소 → 취소 토스트 · 문서를 쓰지 않음 · whisper-cli·ffmpeg 잔존 0(`sys_process_snapshot`) · 임시 파일 삭제.
//   ⑤ 시작 직후(엔진 확인·ffprobe 중) 취소도 먹는다 — 잡 등록 전 틈에서 버려지지 않는다.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "음성 인식 자막 (엔진 획득 · 실제 전사 · 취소 잔존 0)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const EVENT_API = "/node_modules/@tauri-apps/api/event.js";

const TINY_SHA = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const JFK_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/samples/jfk.wav";
const JFK_SHA = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
const SRC = "e2e-stt.mp4";
const LONG = "e2e-stt-long.mp4";
const TRK = "e2e-stt-tracks.mp4";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** 진행 채널 원소 → JSON 객체(47 parseMsgs와 같은 방어 — 스트림 끝의 null 등). */
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

async function progressChannel(cdp, slot) {
  const rid = await cdp.eval(
    `(()=>{ window[${J(slot)}]=[]; return window.__TAURI_INTERNALS__.transformCallback((m)=>{ try{ window[${J(slot)}].push(m&&m.message); }catch(_){} }); })()`,
  );
  return {
    ref: `__CHANNEL__:${rid}`,
    drain: () => cdp.eval(`(()=>{ const a=window[${J(slot)}]||[]; window[${J(slot)}]=[]; return a; })()`),
  };
}

/** 분 단위 호출을 페이지에서 기다리지 않고 시작한다(47 startInvoke — eval 기본 60s 시한 회피). */
async function startInvoke(cdp, slot, cmd, args) {
  await cdp.eval(`(()=>{ window[${J(slot)}]={pending:true};
    window.__TAURI_INTERNALS__.invoke(${J(cmd)}, ${J(args)})
      .then((r)=>{ window[${J(slot)}]={pending:false,ok:true,r}; })
      .catch((e)=>{ window[${J(slot)}]={pending:false,ok:false,code:(e&&e.code)||null,message:(e&&e.message)||String(e)}; });
    return true; })()`);
}

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

/** 키 정렬 JSON — 문서 비교가 필드 순서에 흔들리지 않게. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${J(k)}:${canon(v[k])}`)
      .join(",")}}`;
  return J(v);
}

/** 이름이 맞는 프로세스(pid·exe) — 개별 모드, 작은 프로세스까지 보이게 넉넉한 상한. */
async function procs(cdp, re) {
  const snap = await cdp.invoke("sys_process_snapshot", { sortBy: "ram", limit: 5000, groupByName: false }, { timeoutMs: 20000 });
  return (snap?.processes ?? []).filter((p) => re.test(p.name));
}

export async function run({ cdp, report: r, fix }) {
  if (process.env.E2E_NET !== "1") {
    r.skip("음성 인식 자막 전체", "E2E_NET=1 이 아님 — 엔진 다운로드에 네트워크가 필요하다");
    return;
  }
  const hooks = await cdp.eval(`!!(window.__gpv && window.__gpv.captionDoc && window.__gpv.caption)`);
  if (!hooks) {
    r.skip("음성 인식 자막 전체", "window.__gpv.captionDoc/caption 미노출(dev 빌드 아님)");
    return;
  }
  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found || !tool.r?.probeFound) {
    r.skip("음성 인식 자막 전체", "ffmpeg/ffprobe 미발견");
    return;
  }

  // ── ① 엔진 획득 ──
  let st = await cdp.invoke("stt_status", {}, { timeoutMs: 15000 });
  r.check(
    "① stt_status 셰이프(runtime/models/vadInstalled)",
    st && typeof st.runtime?.state === "string" && Array.isArray(st.models) && typeof st.vadInstalled === "boolean",
    J({ runtime: st?.runtime, models: st?.models?.map((m) => m.id) }),
  );
  if (st.runtime.state === "unsupported") {
    r.skip("음성 인식 자막(엔진)", "이 플랫폼은 관리형 whisper-cli가 없다(macOS — brew 발견 전용)");
    return;
  }
  const already = st.runtime.state === "found" && st.runtime.source === "managed" && st.vadInstalled;
  const ch = await progressChannel(cdp, "__gpvSttRt");
  const all = [];
  await startInvoke(cdp, "__gpvSttRtDone", "stt_runtime_ensure", { onProgress: ch.ref });
  const res = await awaitSlot(cdp, "__gpvSttRtDone", 600000, async () => {
    all.push(...parseMsgs(await ch.drain()));
  });
  all.push(...parseMsgs(await ch.drain()));
  r.check(
    "① stt_runtime_ensure 성공",
    res.ok === true,
    res.timedOut ? "10분 안에 끝나지 않았다" : `${res.code ?? ""} ${res.message ?? ""}`.trim(),
  );
  // VAD와 엔진이 같은 이름(stt-runtime)으로 차례로 받는다 — 퍼센트는 다운로드 한 번(연속한 download 묶음) 안에서만 단조.
  let pcts = 0;
  let monotonic = true;
  let prev = null;
  for (const m of all) {
    if (m.phase !== "download" || m.percent == null) {
      prev = null;
      continue;
    }
    pcts++;
    if (prev != null && m.percent < prev) monotonic = false;
    prev = m.percent;
  }
  if (already) {
    r.check("① 멱등: 이미 설치돼 있으면 받지 않고 done", !all.some((m) => m.phase === "download") && all.some((m) => m.phase === "done"), J(all.map((m) => m.phase)));
  } else {
    r.check("① 진행 이벤트(download %) 수신 · 다운로드마다 단조 증가", pcts > 0 && monotonic, `${pcts}건 · ${all.map((m) => m.phase[0] + (m.percent ?? "")).join(" ").slice(0, 160)}`);
    r.check("① 마지막 phase=done(이름 stt-runtime)", all.at(-1)?.phase === "done" && all.at(-1)?.name === "stt-runtime", J(all.at(-1)));
  }
  st = await cdp.invoke("stt_status", {}, { timeoutMs: 15000 });
  const exe = st.runtime.state === "found" ? st.runtime.path : null;
  r.check(
    "① 관리형 엔진 설치됨(실행 파일 실재) + VAD",
    st.runtime.state === "found" && st.runtime.source === "managed" && !!exe && existsSync(exe) && st.vadInstalled,
    J(st.runtime) + ` vad=${st.vadInstalled}`,
  );
  if (!exe || st.runtime.source !== "managed") return;

  // ── 모델 주입 · 픽스처 ──
  const tiny = process.env.E2E_STT_MODEL;
  if (!tiny || !existsSync(tiny)) {
    r.skip("②~④ 실제 전사·취소", "E2E_STT_MODEL(ggml-tiny.bin) 미주입 — 카탈로그 모델(57MB+)은 받지 않는다");
    return;
  }
  if (!r.check("모델 주입: E2E_STT_MODEL sha256 = 공식 ggml-tiny.bin", sha256(readFileSync(tiny)) === TINY_SHA, tiny)) return;
  // exe = <앱 로컬 데이터>/llm/whisper-b5130/whisper-cli(.exe) — 모델·임시 파일 자리는 거기서 푼다(acquire.rs·transcribe.rs).
  const llmRoot = dirname(dirname(exe));
  const base = dirname(llmRoot);
  const modelDst = join(llmRoot, "models", "ggml-tiny.bin");
  const injected = !existsSync(modelDst);
  if (injected) copyFileSync(tiny, modelDst);

  const pid = fix.projectId;
  const created = [SRC, LONG, TRK];
  try {
    let wav = process.env.E2E_STT_WAV;
    if (!wav || !existsSync(wav)) {
      const res = await fetch(JFK_URL);
      if (!res.ok) throw new Error(`jfk.wav 다운로드 실패 HTTP ${res.status}`);
      wav = join(fix.root, "jfk.wav");
      writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
    }
    if (!r.check("픽스처 jfk.wav sha256 고정값", sha256(readFileSync(wav)) === JFK_SHA, wav)) return;
    const ff = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
    ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-i", wav,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(fix.repo, SRC),
    ]);
    // 취소용 — jfk를 30번 이어 붙인 5분 30초(tiny로도 인식에 수 초 이상 걸리게).
    ff([
      "-f", "lavfi", "-i", "testsrc=size=160x120:rate=5", "-stream_loop", "29", "-i", wav,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(fix.repo, LONG),
    ]);

    // 진행 이벤트를 페이지에 모은다(스토어는 마지막 값만 든다).
    await cdp.eval(`(async()=>{ const m=await import(${J(EVENT_API)});
      window.__gpvSttProg=[]; if (window.__gpvSttUnlisten) window.__gpvSttUnlisten();
      window.__gpvSttUnlisten = await m.listen('stt://progress', (e)=>window.__gpvSttProg.push(e.payload)); return true; })()`);

    const key = (rel) => `${pid}\n${rel}`;
    const entry = (rel) => `(window.__gpv.captionDoc.getState().entries[${J(key(rel))}] || null)`;
    const start = (rel) =>
      cdp.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] });
        void window.__gpv.captionDoc.getState().transcribe(${J(pid)}, ${J(rel)}, { modelId: 'e2e-tiny', language: 'auto', prompt: null });
        return true; })()`);
    const tempFiles = (jobId) => {
      const stem = join(base, "stt", `gpv-stt-${jobId.replace(/-/g, "")}`);
      return [`${stem}.wav`, `${stem}.json`].filter((p) => existsSync(p));
    };

    // ── ② 전사 ──
    const t0 = Date.now();
    await start(SRC);
    let jobId = null;
    let e = null;
    for (let i = 0; i < 600; i++) {
      e = await cdp.eval(`(()=>{ const e=${entry(SRC)}; return e && { job: e.job, doc: !!e.doc, err: e.jobError }; })()`);
      if (e?.job?.id) jobId = e.job.id;
      if (jobId && e && !e.job) break;
      await sleep(200);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.check("② 스토어 transcribe → 잡 끝남(오류 없음)", !!jobId && !e?.job && e?.doc && !e?.err, `${secs}s job=${jobId} err=${e?.err}`)) return;
    const doc = await cdp.eval(`${entry(SRC)}.doc`);
    const words = doc.tokens.filter((t) => t.kind === "word").map((t) => t.text).join(" ");
    r.check('② 인식 결과에 "country"', /country/i.test(words), words.slice(0, 160));
    const cues = await cdp.eval(`window.__gpv.caption.captionSourceCues(${entry(SRC)}.doc)`);
    const dur = doc.source.durationMs;
    r.check(
      "② cue 시각 단조 · 길이 이내 · 비어 있지 않음",
      cues.length > 0 &&
        cues.every((c, i) => c.startMs < c.endMs && c.endMs <= dur && (i === 0 || c.startMs >= cues[i - 1].endMs)),
      J(cues.map((c) => [c.startMs, c.endMs])) + ` dur=${dur}`,
    );
    r.check(
      "② 엔진 기록: 단어 시각 dtw · 감지 언어 en · 모델 e2e-tiny · VAD",
      doc.engine.wordTiming === "dtw" && doc.engine.detectedLanguage === "en" && doc.engine.modelId === "e2e-tiny" && doc.engine.vad === true,
      J(doc.engine),
    );
    const prog = (await cdp.eval(`window.__gpvSttProg`)).filter((p) => p.jobId === jobId);
    const pp = prog.map((p) => p.percent);
    r.check(
      "② 진행 이벤트: 추출 → 인식 단계, 퍼센트 단조 증가, 끝은 95% 이상",
      prog.some((p) => p.phase === "extract") && prog.some((p) => p.phase === "transcribe") && pp.every((v, i) => i === 0 || v >= pp[i - 1]) && pp.at(-1) >= 95,
      prog.map((p) => `${p.phase[0]}${p.percent}`).join(" "),
    );
    const reloaded = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    r.check("② 다시 읽은 문서 = 스토어 문서(stale 아님)", !!reloaded && canon(reloaded.doc) === canon(doc) && reloaded.stale === false, `rev=${reloaded?.doc.rev}`);
    const toast = await cdp.eval(`window.__gpv.ui.getState().toasts.map(t=>t.kind+':'+t.message).join(' | ')`);
    r.check("② 완료 토스트(이 창이 시작한 잡)", /success:자막을 만들었습니다 — e2e-stt\.mp4/.test(toast), toast);
    r.check("② 임시 WAV·JSON 삭제됨", tempFiles(jobId).length === 0, tempFiles(jobId).join(", ") || "(없음)");
    r.info(`jfk 11초 · ggml-tiny 전사 ${secs}s`);

    // ── ②b 오디오 트랙 고르기(P3) — 첫 트랙은 사인파, 말은 둘째 트랙에만. 둘째를 고르면 "country"가 나와야 한다
    //     (`-map 0:a:<n>`을 무시하고 첫 트랙을 뽑으면 말이 없다). 없는 트랙 번호는 거절.
    ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-i", wav,
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(fix.repo, TRK),
    ]);
    await cdp.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] });
      void window.__gpv.captionDoc.getState().transcribe(${J(pid)}, ${J(TRK)}, { modelId: 'e2e-tiny', language: 'auto', prompt: null, audioStream: 1 });
      return true; })()`);
    let trkJob = null;
    let te = null;
    for (let i = 0; i < 600; i++) {
      te = await cdp.eval(`(()=>{ const e=${entry(TRK)}; return e && { job: e.job, err: e.jobError, doc: e.doc }; })()`);
      if (te?.job?.id) trkJob = te.job.id;
      if (trkJob && te && !te.job) break;
      await sleep(200);
    }
    const trkWords = (te?.doc?.tokens ?? []).filter((t) => t.kind === "word").map((t) => t.text).join(" ");
    r.check(
      '②b 둘째 오디오 트랙(audioStream 1) 전사 → "country" · 문서 source.audioStream = 1',
      !!trkJob && !te?.job && !te?.err && te?.doc?.source.audioStream === 1 && /country/i.test(trkWords),
      `err=${te?.err} audioStream=${te?.doc?.source.audioStream} words=${trkWords.slice(0, 120)}`,
    );
    const noTrack = await cdp.try(
      "stt_transcribe",
      { req: { jobId: crypto.randomUUID(), projectId: pid, relPath: TRK, modelId: "e2e-tiny", language: "auto", prompt: null, audioStream: 2 } },
      { timeoutMs: 20000 },
    );
    const trkAfter = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: TRK });
    r.check(
      "②b 없는 트랙(3번) → 거절 · 문서 그대로",
      !noTrack.ok && /오디오 트랙 3번이 없습니다/.test(noTrack.message || "") && trkAfter?.doc.rev === te?.doc?.rev,
      `${noTrack.code} ${noTrack.message ?? ""} rev ${te?.doc?.rev} → ${trkAfter?.doc.rev}`,
    );

    // ── ③④ 취소 ──
    const ffBefore = new Set((await procs(cdp, /^ffmpeg/i)).map((p) => p.pid));
    await start(LONG);
    let cancelJob = null;
    let phase = null;
    for (let i = 0; i < 300; i++) {
      const j = await cdp.eval(`${entry(LONG)}?.job ?? null`);
      if (j) {
        cancelJob = j.id;
        phase = j.phase;
        if (j.phase === "transcribe") break;
      } else if (cancelJob) break; // 인식 단계를 보기 전에 끝났다
      await sleep(100);
    }
    // 인식 중인 whisper-cli가 실제로 보여야 아래 "잔존 0"이 빈말이 아니다. 인식 단계 진행(10%)은 spawn 직전에
    // 나가고 스냅샷은 500ms 스로틀이라 몇 번 본다.
    let running = 0;
    for (let i = 0; i < 8 && phase === "transcribe" && running === 0; i++) {
      running = (await procs(cdp, /whisper-cli/i)).length;
      if (!running) await sleep(600);
    }
    const busy = await cdp.try(
      "stt_transcribe",
      { req: { jobId: crypto.randomUUID(), projectId: pid, relPath: SRC, modelId: "e2e-tiny", language: "auto", prompt: null } },
      { timeoutMs: 20000 },
    );
    r.check("③ 전사 중 두 번째 전사 → BUSY", !busy.ok && busy.code === "BUSY", `${busy.code} ${busy.message ?? ""}`);
    await cdp.eval(`(()=>{ window.__gpv.captionDoc.getState().cancelTranscribe(${J(key(LONG))}); return true; })()`);
    let after = null;
    for (let i = 0; i < 100; i++) {
      after = await cdp.eval(`(()=>{ const e=${entry(LONG)}; return e && { job: !!e.job, doc: !!e.doc, err: e.jobError }; })()`);
      if (after && !after.job) break;
      await sleep(200);
    }
    r.check(
      "④ 인식 단계에서 취소(whisper-cli 실행 중 관측) → 잡 끝남 · 오류 아님 · 문서 안 씀",
      phase === "transcribe" && running > 0 && after && !after.job && !after.err && !after.doc,
      `phase=${phase} whisper=${running} after=${J(after)}`,
    );
    const cancelToast = await cdp.eval(`window.__gpv.ui.getState().toasts.map(t=>t.kind+':'+t.message).join(' | ')`);
    r.check("④ 취소 토스트(실패 토스트 아님)", /자막 만들기를 취소했습니다/.test(cancelToast) && !/error:/.test(cancelToast), cancelToast);
    const stored = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: LONG });
    r.check("④ 취소된 전사는 문서를 저장하지 않는다", stored === null, J(stored?.doc?.rev));
    let leftW = [];
    let leftF = [];
    for (let i = 0; i < 20; i++) {
      leftW = await procs(cdp, /whisper-cli/i);
      leftF = (await procs(cdp, /^ffmpeg/i)).filter((p) => !ffBefore.has(p.pid));
      if (leftW.length === 0 && leftF.length === 0) break;
      await sleep(500);
    }
    r.check(
      "④ 취소 후 whisper-cli·ffmpeg 잔존 0",
      leftW.length === 0 && leftF.length === 0,
      `whisper=${J(leftW.map((p) => p.pid))} ffmpeg(새로 생긴 것)=${J(leftF.map((p) => p.pid))}`,
    );
    r.check("④ 취소된 잡의 임시 WAV·JSON 삭제됨", !!cancelJob && tempFiles(cancelJob).length === 0, tempFiles(cancelJob ?? "").join(", ") || `job=${cancelJob}`);

    // ⑤ 시작 직후(엔진 확인·ffprobe 중) 취소 — 잡 등록 전이던 이 틈의 취소는 모르는 id라 조용히 버려지고 전사가 끝까지 돌아
    // 문서를 썼다(리뷰 후 수정: 등록을 begin_active 바로 뒤로). 20ms는 ffprobe(수십~수백 ms)가 끝나기 전이다.
    const earlyId = crypto.randomUUID();
    await cdp.eval(`(()=>{ const I=window.__TAURI_INTERNALS__; window.__gpvEarly={pending:true};
      I.invoke('stt_transcribe', { req: { jobId: ${J(earlyId)}, projectId: ${J(pid)}, relPath: ${J(LONG)}, modelId: 'e2e-tiny', language: 'auto', prompt: null } })
        .then(()=>{ window.__gpvEarly={pending:false,ok:true}; })
        .catch((e)=>{ window.__gpvEarly={pending:false,ok:false,code:(e&&e.code)||null,message:(e&&e.message)||String(e)}; });
      setTimeout(()=>{ void I.invoke('stt_transcribe_cancel', { jobId: ${J(earlyId)} }); }, 20);
      return true; })()`);
    const early = await awaitSlot(cdp, "__gpvEarly", 300000);
    const earlyDoc = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: LONG });
    r.check(
      "⑤ 시작 20ms 뒤 취소(잡 등록 전이던 틈) → CANCELLED · 문서 안 씀 · 임시 파일 없음",
      early.ok === false && early.code === "CANCELLED" && earlyDoc === null && tempFiles(earlyId).length === 0,
      `${J(early)} doc=${earlyDoc ? `rev ${earlyDoc.doc.rev}` : "없음"}`,
    );
  } finally {
    await cdp.eval(`(()=>{ if (window.__gpvSttUnlisten) window.__gpvSttUnlisten(); window.__gpvSttUnlisten=null; window.__gpv.ui.setState({ toasts: [] }); return true; })()`).catch(() => {});
    for (const rel of created) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 없으면 무해 */
      }
    }
    // 주입한 모델만 치운다 — 원래 있던 파일(사용자가 둔 것)은 건드리지 않는다.
    if (injected) rmSync(modelDst, { force: true });
  }
}
