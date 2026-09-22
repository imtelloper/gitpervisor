// 태스크 72 P1·P2·P3 — 대본 편집·편집본 내보내기·자막 입힌 영상. **음성 인식 엔진 없이 결정적으로** 돈다: testsrc+sine 영상에
// 손으로 만든 CaptionDoc(wordTiming "dtw")을 `caption_doc_save`로 주입하고, 영상 doc 창(34와 같은 경로)의
// 대본 패널을 실제 DOM 이벤트로 구동한다.
//
// 지키는 계약:
//   ① 저장소: 저장 때 금지 문자(폭 없는·방향 제어) 제거 · 새로 읽으면 stale 아님 · 낡은 base_rev → CONFLICT
//   ② 패널: cue 행 · 오버레이가 seek 한 곳의 cue를 보인다 · 패널에서 친 `i`가 In 지점을 찍지 않는다(키 가로채기,
//      같은 키를 플레이어 컨테이너에 치면 찍힌다 — 단언이 빈말이 아님을 같은 자리에서 보인다)
//   ③ 나누기·합치기·단어 수정·찾아 바꾸기 뒤 불변식(토큰 시각 그대로, cue가 순서대로 빈틈없이 덮음, 저장본 = 화면)
//      · 포커스된 버튼의 Enter·Delete는 버튼 몫 · Shift+F2 자막 줄 고치기 · 저장 실패 배너의 '다시 저장'이 실제로 저장
//   ④ 컷 토글·무음 줄이기 → 저장 응답 plan.keep이 손으로 푼 값과 같다 · 편집 반영 재생이 잘린 구간을 건너뛴다
//      · 잘린 어절은 자막 줄·앱이 만드는 override(구절 바꾸기·합치기)에 실리지 않는다
//   ⑤ 편집본 SRT(원문 대조 — 시각 = out(t), 잘린 단어 없음, 금지 문자 없음) · 편집본 mp4 길이 ≈ Σkeep(±1프레임)
//      · 완료 토스트는 잡을 시작한 doc 창에만
//   ⑤b 자막 입힌 영상(P3 백엔드, IPC 직접): 소프트 자막 + 무손실 복사 → mov_text를 되읽으면 원본 시각 cue 그대로 ·
//      스트림 h264·aac·mov_text · 번인(libass 있을 때, 편집본 시각) → 길이 Σkeep · 자막 스트림 없음 · 자막 자리 픽셀이
//      ⑤ 편집본과 다르고 자막 없는 자리는 같다 · 없으면 TOOL_NOT_FOUND · 시간축 어긋남 거절 · 자막 임시 파일이 남지 않는다
//   ⑤c 자막 스타일·자막 넣기 UI(P3 프론트): CC 옆 스타일 → 문서 저장(Rust 왕복) · 오버레이가 값 표를 따른다 ·
//      ExportPanel 자막 트랙 + 대본 편집 → 기본 이름 .cut.sub.mp4 · mov_text = 편집본 시각 cue · 번인 선택지 = libass 유무
//   ⑤d 번역 자막(P4, LLM 없이): 가짜 chat으로 배치·검증(밀린 답 거절·베낀 원문 대조)·다시 묻기·반으로 쪼개기 ·
//      번역을 스토어에 쓰면 행에 번역 줄 · [번역] 현황 · 원문을 고치면 "원문 바뀜" → 손으로 고치면 풀림(클릭·Alt+Shift+F2) ·
//      잡 도중 손으로 고친 번역 줄은 늦게 온 배치가 덮지 않는다 · 오버레이 2단 ·
//      자막 파일 2단(name.cut.ko.dual.srt)·번역만(원본 시각 name.ko.srt) 원문 대조 · 빠진 번역은 패널·ExportPanel·백엔드
//      셋 다 막는다 · (`E2E_LLM_GGUF`를 줄 때만) 스토어 번역 잡이 실제 모델로 빠진 줄만 이어서 번역 · 시작 직후 취소는 아무 것도
//      쓰지 않는다 · 한 언어 전체 번역
//   ⑥ 무음 줄이기 복구 · approx 문서는 컷이 막힌다(패널·ExportPanel·백엔드 셋 다)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name = "대본 편집·편집본 내보내기 (caption_doc_save 주입 → 패널 편집 → 컷·무음 → 편집본 mp4·SRT)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

const SRC = "e2e-cap.mp4";
const OUT_MP4 = "e2e-cap.cut.mp4";
const OUT_SRT = "e2e-cap.cut.srt";
const OUT_SOFT = "e2e-cap.sub.mp4";
const OUT_BURN = "e2e-cap.cut.sub.mp4";
const OUT_DUAL = "e2e-cap.cut.ko.dual.srt";
const OUT_TR = "e2e-cap.ko.srt";
const FPS = 30;

/** SRT 텍스트 → [{startMs, endMs, text}] (ffmpeg가 mov_text를 되풀어 쓴 것). */
function parseSrt(s) {
  const ms = (t) => {
    const [hms, f] = t.trim().split(",");
    const [h, m, sec] = hms.split(":").map(Number);
    return ((h * 60 + m) * 60 + sec) * 1000 + Number(f);
  };
  return s
    .replace(/\r/g, "")
    .split(/\n\n+/)
    .map((b) => b.split("\n"))
    .filter((l) => l.length >= 3 && l[1].includes("-->"))
    .map((l) => {
      const [a, b] = l[1].split("-->");
      return { startMs: ms(a), endMs: ms(b), text: l.slice(2).join("\n").trim() };
    });
}

/** 한 프레임의 아래 40%를 회색조 원시 바이트로 — 번인 자막 자리 비교용. */
function bottomGray(file, secs) {
  return execFileSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(secs), "-i", file, "-frames:v", "1", "-vf", "crop=iw:ih*0.4:0:ih*0.6,format=gray", "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 24 },
  );
}

/** 밝기가 48 넘게 달라진 화소의 비율 — 인코딩 잡음(한 자릿수)은 세지 않고 글자·박스만 센다. */
const changedFraction = (a, b) => {
  const n = Math.min(a.length, b.length);
  let c = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > 48) c++;
  return n && a.length === b.length ? c / n : Infinity;
};

/** 시각(ms) — 영상 10초 기준. 이웃 단어 사이가 300ms 미만이면 gap 토큰이 없다(Rust build_doc 규칙과 같게). */
function buildTokens(D) {
  const w = (id, s, e, text) => ({ id, kind: "word", startMs: s, endMs: e, text, cut: false });
  const g = (id, s, e) => ({ id, kind: "gap", startMs: s, endMs: e, cut: false });
  return [
    g("t1", 0, 500),
    w("t2", 500, 900, "hello"),
    w("t3", 1000, 1400, "world,"),
    g("t4", 1400, 3000),
    w("t5", 3000, 3400, "um"),
    w("t6", 3500, 3900, "this"),
    w("t7", 4000, 4400, "is"),
    w("t8", 4500, 4900, "a"),
    w("t9", 5000, 5400, "test."),
    g("t10", 5400, 6500),
    w("t11", 6500, 6900, "second"),
    // 폭 없는 공백·방향 제어 — 저장 때 지워져야 한다(①)
    w("t12", 7000, 7400, "li" + String.fromCodePoint(0x200b) + "ne" + String.fromCodePoint(0x202e)),
    g("t13", 7400, D),
  ];
}
const CUES = [
  { id: "c14", firstTokenId: "t1", lastTokenId: "t3" },
  { id: "c15", firstTokenId: "t4", lastTokenId: "t9" },
  { id: "c16", firstTokenId: "t10", lastTokenId: "t13" },
];

/** 편집본 SRT·자막 파일에 있으면 안 되는 문자(설계 §3.6 — CR·LF는 SRT 줄 끝이라 허용). */
const FORBIDDEN = [[0x00, 0x09], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x2029], [0x2060, 0x2060], [0xfeff, 0xfeff], [0x202a, 0x202e], [0x2066, 0x2069]];
const hasForbidden = (s) => [...s].some((c) => FORBIDDEN.some(([a, b]) => c.codePointAt(0) >= a && c.codePointAt(0) <= b));

const keepStr = (keep) => (keep ?? []).map((r) => `${r.startMs}-${r.endMs}`).join(",");

/** 스트림 목록 "video:h264,audio:aac,subtitle:mov_text" — 자막 입힌 영상이 무엇을 담았나(순서 = 컨테이너 순). */
const streamsOf = (file) =>
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(",").slice(0, 2).reverse().join(":"))
    .join(",");

function probeDur(file, stream) {
  const args = stream
    ? ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", file]
    : ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file];
  return Number(execFileSync("ffprobe", args, { encoding: "utf8" }).trim());
}

/** doc 창에 설치하는 헬퍼 — 창마다 JS 컨텍스트가 따로다(34 DOC_HELPERS와 같은 이유). */
const helpers = (key) => `(() => {
  const H = {};
  H.st = () => window.__gpv.captionDoc.getState();
  H.entry = () => H.st().entries[${J(key)}] || null;
  H.doc = () => (H.entry() && H.entry().doc) || null;
  H.panel = () => document.querySelector('[data-gpv="transcript-panel"]');
  H.rows = () => document.querySelectorAll('[data-gpv="transcript-panel"] [data-cue]').length;
  H.tok = (tid) => document.querySelector('[data-gpv="transcript-panel"] [data-tid="' + tid + '"]');
  H.key = (key, o, target) => {
    const el = target || H.panel();
    if (!el) return 'no-target';
    const ev = new KeyboardEvent('keydown', Object.assign({ key: key, bubbles: true, cancelable: true }, o || {}));
    el.dispatchEvent(ev);
    return true;
  };
  H.down = (tid, shift) => {
    const el = H.tok(tid);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, shiftKey: !!shift }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return true;
  };
  H.setVal = (el, v) => {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  H.click = (el) => { if (!el || el.disabled) return false; el.click(); return true; };
  H.btn = (root, text) => root ? [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text) || null : null;
  H.settled = () => { const e = H.entry(); return !!e && !!e.doc && !e.dirty && !e.saving && !e.conflict && !e.saveError; };
  H.toasts = () => window.__gpv.ui.getState().toasts.map((t) => t.kind + ':' + t.message).join(' | ');
  H.video = () => document.querySelector('video');
  H.inMarked = () => !!document.querySelector('[aria-label="구간 해제"]');
  H.overlay = () => { const o = document.querySelector('[data-gpv="caption-overlay-text"]'); return o ? o.textContent : null; };
  /** 토큰 시각이 그대로이고 cue가 순서대로 빈틈없이 덮는가 — 틀린 곳을 문자열로. */
  H.invariant = (orig) => {
    const d = H.doc();
    if (!d) return 'no-doc';
    if (d.tokens.length !== orig.length) return 'token count ' + d.tokens.length;
    for (let i = 0; i < orig.length; i++) {
      const a = d.tokens[i], b = orig[i];
      if (a.id !== b.id || a.kind !== b.kind || a.startMs !== b.startMs || a.endMs !== b.endMs) return 'token ' + b.id + ' moved';
    }
    const idx = new Map(d.tokens.map((t, i) => [t.id, i]));
    let next = 0;
    const ids = new Set();
    for (const c of d.cues) {
      if (ids.has(c.id)) return 'dup cue ' + c.id;
      ids.add(c.id);
      const a = idx.get(c.firstTokenId), b = idx.get(c.lastTokenId);
      if (a !== next || b === undefined || b < a) return 'cue ' + c.id + ' gap/overlap';
      next = b + 1;
    }
    return next === d.tokens.length ? 'ok' : 'cues do not cover tail';
  };
  window.__gpvCap = H;
  return true;
})()`;

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found || !tool.r?.probeFound) {
    r.skip("대본 편집 전체", "ffmpeg/ffprobe 미발견");
    return;
  }
  const hooks = await cdp.eval(`!!(window.__gpv && window.__gpv.openDocWindow && window.__gpv.captionDoc && window.__gpv.caption)`);
  if (!hooks) {
    r.skip("대본 편집 전체", "window.__gpv.openDocWindow/captionDoc/caption 미노출(dev 빌드 아님)");
    return;
  }

  const pid = fix.projectId;
  const srcAbs = join(fix.repo, SRC);
  const created = [SRC, OUT_MP4, OUT_SRT, OUT_SOFT, OUT_BURN, OUT_DUAL, OUT_TR];
  let dLabel = null;
  let d = null;
  try {
    // ── 0. 픽스처 — 10초 320×240@30 h264 + 440Hz aac(33과 같은 합성, 키프레임 1초) ──
    execFileSync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=duration=10:size=320x240:rate=${FPS}`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
        "-g", "30", "-pix_fmt", "yuv420p", "-shortest", srcAbs,
      ],
      { encoding: "utf8" },
    );
    const probe = await cdp.invoke("video_probe", { projectId: pid, relPath: SRC }, { timeoutMs: 20000 });
    const D = probe.durationMs;
    const st = statSync(srcAbs);
    const tokens = buildTokens(D);
    const doc = {
      version: 1,
      rev: 0,
      source: {
        rel: SRC,
        sizeBytes: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        durationMs: D,
        startTimeMs: probe.startTimeMs,
        audioStream: 0,
      },
      engine: {
        name: "whisper.cpp",
        build: "b5130",
        modelId: "turbo-q5",
        language: "en",
        detectedLanguage: "en",
        vad: true,
        wordTiming: "dtw",
      },
      tokens,
      cues: CUES,
    };
    const clean = tokens.map((t) => (t.id === "t12" ? { ...t, text: "line" } : t));

    // ── ① 저장소 ──
    // dev 앱에서 다시 돌리면 지난 회차 문서가 남아 있을 수 있다 — 그 rev를 기준으로 덮는다.
    const prior = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    const saved = await cdp.invoke("caption_doc_save", { projectId: pid, relPath: SRC, doc, baseRev: prior?.doc.rev ?? 0 });
    r.check(
      "① caption_doc_save: rev+1 · 컷 없는 plan.keep = 영상 전체",
      saved.rev === (prior?.doc.rev ?? 0) + 1 && keepStr(saved.plan.keep) === `0-${D}` && saved.plan.outDurationMs === D,
      `rev=${saved.rev} keep=${keepStr(saved.plan.keep)} out=${saved.plan.outDurationMs}`,
    );
    const loaded = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    const t12 = loaded?.doc.tokens.find((t) => t.id === "t12");
    r.check(
      "① 다시 읽기: stale 아님(원본 크기·수정 시각 일치) · 금지 문자(U+200B·U+202E)가 저장 때 지워짐",
      loaded && loaded.stale === false && t12?.text === "line",
      `stale=${loaded?.stale} t12=${J(t12?.text)}`,
    );
    const conflict = await cdp.try("caption_doc_save", { projectId: pid, relPath: SRC, doc, baseRev: saved.rev - 1 });
    r.check("① 낡은 base_rev 저장 → CONFLICT", !conflict.ok && conflict.code === "CONFLICT", `${conflict.code} ${conflict.message ?? ""}`);

    // ── ② doc 창 · 대본 패널 ──
    const before = await cdp.eval(
      `(async()=>{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); })()`,
    );
    await cdp.eval(`window.__gpv.openDocWindow(${J(pid)}, ${J(SRC)}, { size: [1280, 900] })`);
    for (let i = 0; i < 40 && !dLabel; i++) {
      await sleep(500);
      const now = await cdp.eval(
        `(async()=>{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); })()`,
      );
      dLabel = now.find((l) => l.startsWith("doc-") && !before.includes(l)) ?? null;
    }
    if (!r.check("② 영상 doc 창 생성", !!dLabel, dLabel || "미발견")) return;
    d = await connectLabel(dLabel, { port: cdpPort });
    const key = `${pid}\n${SRC}`;
    const poll = async (expr, ok, tries = 40, ms = 250) => {
      let v;
      for (let i = 0; i < tries; i++) {
        v = await d.eval(expr).catch((e) => `ERR ${e.message}`);
        if (ok(v)) return v;
        await sleep(ms);
      }
      return v;
    };
    const ready = await poll(`(()=>{ const v=document.querySelector('video'); return v ? v.readyState : -1; })()`, (n) => n >= 1, 60, 500);
    r.check("② doc 창 <video> 메타데이터 로드(readyState≥1)", ready >= 1, `readyState=${ready}`);
    await d.eval(helpers(key));
    await d.eval(`(()=>{ __gpvCap.video().pause(); window.__gpv.ui.setState({ toasts: [] }); return true; })()`);

    const opened = await poll(
      `(()=>{ if (!__gpvCap.panel()) document.querySelector('[data-gpv="transcript-toggle"]')?.click(); return __gpvCap.rows(); })()`,
      (n) => n === 3,
    );
    r.check("② 대본 토글 → 패널에 cue 행 3개", opened === 3, `rows=${opened}`);
    const docRev = await d.eval(`__gpvCap.entry()?.baseRev ?? null`);
    r.check("② doc 창 스토어가 저장본(rev)을 읽음", docRev === saved.rev, `store=${docRev} saved=${saved.rev}`);

    // 오버레이 — seek한 곳의 cue(원본 시각). startTime은 플레이어와 같은 probe 값으로 더한다(§3.5 변환).
    const startSec = (probe.startTimeMs ?? 0) / 1000;
    const seekDoc = (ms) => d.eval(`(()=>{ __gpvCap.video().currentTime = ${ms / 1000 + startSec}; return true; })()`);
    await seekDoc(3600);
    const ov1 = await poll(`__gpvCap.overlay()`, (t) => t === "um this is a test.");
    await seekDoc(700);
    const ov2 = await poll(`__gpvCap.overlay()`, (t) => t === "hello world,");
    await seekDoc(8500);
    const ov3 = await poll(`__gpvCap.overlay()`, (t) => t === null);
    r.check(
      "② 오버레이: seek 3.6s → 'um this is a test.' · 0.7s → 'hello world,' · 쉼(8.5s) → 없음",
      ov1 === "um this is a test." && ov2 === "hello world," && ov3 === null,
      `${J(ov1)} / ${J(ov2)} / ${J(ov3)}`,
    );

    // 키 가로채기 — 패널에서 친 i는 In을 찍지 않는다. 같은 키를 플레이어 컨테이너에 치면 찍힌다(대조군).
    await d.eval(`__gpvCap.key('i')`);
    await sleep(400);
    const inFromPanel = await d.eval(`__gpvCap.inMarked()`);
    await d.eval(`__gpvCap.key('i', {}, __gpvCap.video().closest('[tabindex="0"]'))`);
    const inFromPlayer = await poll(`__gpvCap.inMarked()`, (v) => v === true, 12);
    r.check(
      "② 패널에서 'i' → In 지점 안 찍힘(대조: 플레이어 컨테이너의 'i'는 찍힘)",
      inFromPanel === false && inFromPlayer === true,
      `panel=${inFromPanel} player=${inFromPlayer}`,
    );
    await d.eval(`(()=>{ document.querySelector('[aria-label="구간 해제"]')?.click(); return true; })()`);
    await poll(`__gpvCap.inMarked()`, (v) => v === false, 12);

    // ── ③ 나누기 · 합치기 · 단어 수정 · 찾아 바꾸기 ──
    await d.eval(`__gpvCap.down('t7')`);
    await sleep(120);
    await d.eval(`__gpvCap.key('Enter')`);
    const split = await poll(`(()=>{ const c=__gpvCap.doc().cues; return c.length + ':' + c.map(x=>x.firstTokenId+'-'+x.lastTokenId).join(','); })()`,
      (v) => String(v).startsWith("4:"));
    r.check("③ 'is'에서 Enter → cue 4개(t4-t6 | t7-t9)", split === "4:t1-t3,t4-t6,t7-t9,t10-t13", split);
    await d.eval(`__gpvCap.key('Backspace')`);
    const merged = await poll(`(()=>{ const c=__gpvCap.doc().cues; return c.length + ':' + c.map(x=>x.id+'='+x.firstTokenId+'-'+x.lastTokenId+(x.caption?'*':'')).join(','); })()`,
      (v) => String(v).startsWith("3:"));
    r.check(
      "③ 새 cue 첫 단어에서 Backspace → 위와 합치기(원래 cue 그대로, override 없음)",
      merged === "3:c14=t1-t3,c15=t4-t9,c16=t10-t13",
      merged,
    );

    // 포커스된 버튼의 Enter·Delete는 그 버튼 몫 — 나누기·컷으로 가로채지 않는다(리뷰 후 수정). 합성 이벤트는 버튼을
    // 누르지 않으므로 "기본 동작을 막지 않음"과 "cue·컷 그대로"를 본다. 대조: 같은 Enter를 패널 루트에 치면 나눈다(위).
    await d.eval(`__gpvCap.down('t7')`);
    await sleep(120);
    const btnKeys = await d.eval(`(()=>{ const b=[...__gpvCap.panel().querySelectorAll('button')].find(x=>(x.title||'').startsWith('찾기'));
      if (!b) return 'no-button'; b.focus(); const res={};
      for (const k of ['Enter','Delete']) { const ev=new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}); b.dispatchEvent(ev); res[k]=ev.defaultPrevented; }
      return res; })()`);
    await sleep(300);
    const afterBtn = await d.eval(`(()=>{ const x=__gpvCap.doc(); return x.cues.length + ':' + x.tokens.filter(t=>t.cut).length; })()`);
    r.check(
      "③ 포커스된 버튼의 Enter·Delete → 버튼 몫(기본 동작 안 막음) · 나누기·컷 없음",
      btnKeys?.Enter === false && btnKeys?.Delete === false && afterBtn === "3:0",
      `${J(btnKeys)} cues:cut=${afterBtn}`,
    );

    // Shift+F2 — caret이 든 cue의 자막 줄 고치기(마우스 없이). Esc는 고치지 않고 닫는다.
    await d.eval(`__gpvCap.down('t3')`);
    await sleep(120);
    await d.eval(`__gpvCap.key('F2', { shiftKey: true })`);
    const capInput = await poll(`!!document.querySelector('[data-cue="c14"] textarea')`, (v) => v === true, 20);
    await d.eval(`__gpvCap.key('Escape', {}, document.querySelector('[data-cue="c14"] textarea'))`);
    const capClosed = await poll(`!document.querySelector('[data-cue="c14"] textarea') && !__gpvCap.doc().cues[0].caption`, (v) => v === true, 20);
    r.check("③ Shift+F2 → caret cue의 자막 줄 입력(키보드만으로) · Esc는 override 없이 닫음", capInput === true && capClosed === true, `input=${capInput} closed=${capClosed}`);

    await d.eval(`(()=>{ __gpvCap.tok('t2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    const wordInput = await poll(`!!document.querySelector('[data-cue="c14"] input')`, (v) => v === true, 20);
    if (wordInput) {
      await d.eval(`__gpvCap.setVal(document.querySelector('[data-cue="c14"] input'), 'Hello')`);
      await sleep(80);
      await d.eval(`__gpvCap.key('Enter', {}, document.querySelector('[data-cue="c14"] input'))`);
    }
    const word = await poll(`__gpvCap.doc().tokens.find(t=>t.id==='t2').text`, (v) => v === "Hello", 20);
    r.check("③ 더블클릭 → 단어 입력 → 'Hello'로 교정(시각 그대로)", wordInput === true && word === "Hello", `input=${wordInput} t2=${J(word)}`);

    await d.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] }); return __gpvCap.key('h', { ctrlKey: true }); })()`);
    const findOpen = await poll(`document.querySelectorAll('[data-gpv="transcript-find"] input').length`, (n) => n === 2, 20);
    if (findOpen === 2) {
      await d.eval(`__gpvCap.setVal(document.querySelectorAll('[data-gpv="transcript-find"] input')[0], 'second')`);
      await d.eval(`__gpvCap.setVal(document.querySelectorAll('[data-gpv="transcript-find"] input')[1], '2nd')`);
      await sleep(120);
      await d.eval(`__gpvCap.click(__gpvCap.btn(document.querySelector('[data-gpv="transcript-find"]'), '모두'))`);
    }
    const replaced = await poll(`__gpvCap.doc().tokens.find(t=>t.id==='t11').text`, (v) => v === "2nd", 20);
    const replToast = await d.eval(`__gpvCap.toasts()`);
    r.check(
      "③ Ctrl+H 찾아 바꾸기 'second'→'2nd'(단어 텍스트만, 토스트 1곳)",
      findOpen === 2 && replaced === "2nd" && /1곳 바꿨습니다/.test(replToast),
      `inputs=${findOpen} t11=${J(replaced)} toast=${replToast}`,
    );
    await d.eval(`__gpvCap.key('Escape', {}, document.querySelector('[data-gpv="transcript-find"] input'))`);

    const inv = await d.eval(`__gpvCap.invariant(${J(clean)})`);
    const settled = await poll(`__gpvCap.settled()`, (v) => v === true, 40);
    const stored = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    const shown = await d.eval(`JSON.stringify({ tokens: __gpvCap.doc().tokens, cues: __gpvCap.doc().cues })`);
    r.check(
      "③ 편집 뒤 불변식(토큰 시각 그대로 · cue 연속·전체 덮음) + 자동 저장 = 화면",
      inv === "ok" && settled === true && J({ tokens: stored?.doc.tokens, cues: stored?.doc.cues }) === shown,
      `invariant=${inv} settled=${settled} rev=${stored?.doc.rev}`,
    );

    // 저장 실패 배너의 '다시 저장' — 실제로 다시 보낸다(리뷰 후 수정: flush가 saveError를 보고 바로 false라 무반응이었다).
    // 디스크 오류는 흉내 낸다(스토어 상태만 — 문서는 그대로라 다시 보내면 성공한다).
    const revBefore = await d.eval(`__gpvCap.entry().baseRev`);
    await d.eval(`(()=>{ const s=window.__gpv.captionDoc; const e=__gpvCap.entry();
      s.setState({ entries: { ...s.getState().entries, [${J(key)}]: { ...e, dirty: true, saveError: 'e2e 디스크 오류 흉내' } } }); return true; })()`);
    const retryBtn = await poll(`!!__gpvCap.btn(__gpvCap.panel(), '다시 저장')`, (v) => v === true, 20);
    await d.eval(`__gpvCap.click(__gpvCap.btn(__gpvCap.panel(), '다시 저장'))`);
    const retried = await poll(`__gpvCap.settled() ? __gpvCap.entry().baseRev : null`, (v) => v === revBefore + 1, 40);
    const bannerGone = await d.eval(`!__gpvCap.btn(__gpvCap.panel(), '다시 저장')`);
    r.check(
      "③ 저장 실패 배너 '다시 저장' → 다시 저장됨(rev+1 · 배너 사라짐)",
      retryBtn === true && retried === revBefore + 1 && bannerGone === true,
      `button=${retryBtn} rev ${revBefore} → ${retried} gone=${bannerGone}`,
    );

    // ── ④ 컷 · 무음 줄이기 ──
    await d.eval(`__gpvCap.down('t5')`);
    await sleep(120);
    await d.eval(`__gpvCap.key('Delete')`);
    await d.eval(`__gpvCap.down('t7')`);
    await sleep(120);
    await d.eval(`__gpvCap.down('t8', true)`);
    await sleep(120);
    await d.eval(`__gpvCap.key('Delete')`);
    const cutIds = await poll(`__gpvCap.doc().tokens.filter(t=>t.cut).map(t=>t.id).join(',')`, (v) => v === "t5,t7,t8", 20);
    // 전부 잘린 선택에서 다시 Delete → 되살리기(토글), 한 번 더 → 다시 자르기
    await d.eval(`__gpvCap.key('Delete')`);
    const uncut = await poll(`__gpvCap.doc().tokens.filter(t=>t.cut).map(t=>t.id).join(',')`, (v) => v === "t5", 20);
    await d.eval(`__gpvCap.key('Delete')`);
    const recut = await poll(`__gpvCap.doc().tokens.filter(t=>t.cut).map(t=>t.id).join(',')`, (v) => v === "t5,t7,t8", 20);
    const strike = await d.eval(`__gpvCap.tok('t5').className.includes('line-through')`);
    r.check(
      "④ Delete 컷 토글(선택 영역 · 전부 잘렸으면 되살림) + 취소선",
      cutIds === "t5,t7,t8" && uncut === "t5" && recut === "t5,t7,t8" && strike === true,
      `cut=${cutIds} → ${uncut} → ${recut} strike=${strike}`,
    );

    // 잘린 어절은 자막 줄·앱이 만드는 override에 실리지 않는다(리뷰 후 수정) — override는 컷보다 앞서므로 실리면 영상에서
    // 지운 말이 편집본 자막에 되살아난다. 화면의 자막 줄 + 순수 함수(구절 바꾸기·합치기·고치지 않고 확정).
    const capLine = await poll(`document.querySelector('[data-cue="c15"] [data-gpv="caption-line"]')?.textContent ?? null`, (t) => t === "this test.", 20);
    const ov = await d.eval(`(()=>{ const C=window.__gpv.caption; const base=__gpvCap.doc();
      const w=(id,s,e,text,cut)=>({ id, kind:'word', startMs:s, endMs:e, text, cut:!!cut });
      const syn={ ...base, engine:{ ...base.engine, language:'ko', detectedLanguage:'ko' },
        tokens:[w('x1',0,100,'음',true), w('x2',200,300,'좋은'), w('x3',400,500,'아침'), w('x4',600,700,'어',true), w('x5',800,900,'여러분')],
        cues:[{ id:'x6', firstTokenId:'x1', lastTokenId:'x3' }, { id:'x7', firstTokenId:'x4', lastTokenId:'x5' }] };
      const withOv=C.setCaptionCueCaption(syn, 'x6', '좋은 아침!');
      return { rep: C.replaceCaptionMatches(syn, '좋은 아침', '굿모닝').doc.cues[0].caption ?? null,
        merged: withOv ? C.mergeCaptionCues(withOv, 0).cues[0].caption ?? null : 'no-override',
        unchanged: C.setCaptionCueCaption(syn, 'x6', '좋은 아침') === null }; })()`);
    r.check(
      "④ 잘린 어절 빼기 — 자막 줄 'this test.' · 구절 바꾸기 '굿모닝' · 합치기 '좋은 아침! 여러분' · 고치지 않은 확정은 override 없음",
      capLine === "this test." && ov?.rep === "굿모닝" && ov?.merged === "좋은 아침! 여러분" && ov?.unchanged === true,
      `line=${J(capLine)} ${J(ov)}`,
    );
    const wantCut = `0-3000,3400-4000,4900-${D}`;
    const planCut = await poll(`(()=>{ const e=__gpvCap.entry(); return __gpvCap.settled() && e.plan ? e.plan.keep.map(k=>k.startMs+'-'+k.endMs).join(',') : null; })()`,
      (v) => v === wantCut, 40);
    r.check("④ 저장 응답 plan.keep = 손으로 푼 값(pad 200ms, 잘린 어절 패딩 잘라냄)", planCut === wantCut, `${planCut} (기대 ${wantCut})`);
    const cutPlay = await poll(`document.querySelector('[data-gpv="cut-play-toggle"]')?.getAttribute('aria-pressed') ?? null`, (v) => v === "true", 20);
    r.check("④ 컷이 생기면 '편집 반영' 토글이 켜진 채 나타남", cutPlay === "true", `aria-pressed=${cutPlay}`);

    // 1.0s 넘는 쉼 셋(1.6·1.1·꼬리) → 각각 0.6s만 남김. 줄어드는 합 = 1.0 + 0.5 + (꼬리 − 0.6).
    const silWant = `3곳 · 총 ${((1000 + 500 + (D - 7400 - 600)) / 1000).toFixed(1)}초 줄어듦`;
    await d.eval(`(()=>{ document.querySelector('[data-gpv="silence-toggle"]')?.click(); return true; })()`);
    const silText = await poll(`document.querySelector('[data-gpv="silence-panel"]')?.textContent ?? ''`, (t) => String(t).includes(silWant), 20);
    await d.eval(`__gpvCap.click(__gpvCap.btn(document.querySelector('[data-gpv="silence-panel"]'), '적용'))`);
    const silDoc = await poll(`(()=>{ const x=__gpvCap.doc(); return x.silenceMinMs + '/' + x.silenceKeepMs; })()`, (v) => v === "1000/600", 20);
    const wantSil = `0-1700,2700-3000,3400-4000,4900-5700,6200-7700,${D - 300}-${D}`;
    const planSil = await poll(`(()=>{ const e=__gpvCap.entry(); return __gpvCap.settled() && e.plan ? e.plan.keep.map(k=>k.startMs+'-'+k.endMs).join(',') + ' out=' + e.plan.outDurationMs : null; })()`,
      (v) => String(v).startsWith(wantSil + " "), 40);
    const chip = await d.eval(`(__gpvCap.tok('t4')?.textContent || '').trim()`);
    r.check(
      "④ 무음 줄이기 검토(3곳·줄어드는 합) → 적용(1.0s 초과 → 0.6s) → plan.keep 6구간 · 쉼 칩 '1.6→0.6s'",
      String(silText).includes(silWant) && silDoc === "1000/600" && planSil === `${wantSil} out=5200` && chip === "··· 1.6→0.6s",
      `검토="${String(silText).slice(0, 40)}" doc=${silDoc} plan=${planSil} chip=${J(chip)}`,
    );

    // 편집 반영 재생 — 2.85s(남는 구간 2.7~3.0)에서 틀면 잘린 3.0~3.4를 건너뛴다. 플레이어 rAF가 잡기 전 한 프레임은 허용.
    const samples = await d.eval(
      `(async()=>{ const v=__gpvCap.video(); v.currentTime=${2.85 + startSec};
         await new Promise((res)=>v.addEventListener('seeked', res, { once: true }));
         const out=[]; let go=true; const tick=()=>{ out.push(Math.round((v.currentTime-${startSec})*1000)); if(go) requestAnimationFrame(tick); };
         await v.play().catch(()=>{}); requestAnimationFrame(tick);
         await new Promise((res)=>setTimeout(res, 900)); go=false; v.pause(); return out; })()`,
      { timeoutMs: 15000 },
    );
    const inCut = (samples ?? []).filter((ms) => ms >= 3060 && ms <= 3340);
    const maxMs = Math.max(0, ...(samples ?? []));
    if ((samples ?? []).length < 10 || maxMs < 2950) {
      r.skip("④ 편집 반영 재생", `재생이 진행되지 않았다(창이 가려져 rAF·재생이 멈춤?) — 표본 ${samples?.length}개, 최대 ${maxMs}ms`);
    } else {
      r.check(
        "④ 편집 반영 재생: 잘린 3.0~3.4s를 건너뜀(그 안의 표본 0개)",
        inCut.length === 0 && maxMs >= 3450,
        `표본 ${samples.length}개 · 구간 안 ${inCut.length}개(${inCut.slice(0, 5).join(",")}) · 최대 ${maxMs}ms`,
      );
    }

    // ── ⑤ 편집본 SRT ──
    await d.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] }); document.querySelector('[data-gpv="subs-export-toggle"]')?.click(); return true; })()`);
    await poll(`!!document.querySelector('[data-gpv="subs-timeline-edited"]')`, (v) => v === true, 20);
    await d.eval(`(()=>{ document.querySelector('[data-gpv="subs-timeline-edited"]').click(); return true; })()`);
    const srtName = await poll(`document.querySelector('[data-gpv="subs-export"] input')?.value ?? ''`, (v) => v === OUT_SRT, 20);
    await d.eval(`__gpvCap.click(__gpvCap.btn(document.querySelector('[data-gpv="subs-export"]'), '자막 파일 저장'))`);
    const srtToast = await poll(`__gpvCap.toasts()`, (t) => /자막 파일 저장/.test(t) || /error:/.test(t), 40);
    const srtAbs = join(fix.repo, OUT_SRT);
    const srt = existsSync(srtAbs) ? readFileSync(srtAbs, "utf8") : "";
    // out(t) = t − (t 이전 제거 길이). keep 0-1700,2700-3000,3400-4000,4900-5700,6200-7700 → 누적 0,1700,2000,2600,3400.
    const wantSrt =
      "1\r\n00:00:00,500 --> 00:00:01,400\r\nHello world,\r\n\r\n" +
      "2\r\n00:00:02,100 --> 00:00:03,100\r\nthis test.\r\n\r\n" +
      "3\r\n00:00:03,700 --> 00:00:04,600\r\n2nd line\r\n\r\n";
    r.check(`⑤ 편집본 시각 → 기본 이름 ${OUT_SRT} · 저장 토스트`, srtName === OUT_SRT && /success:자막 파일 저장/.test(srtToast), `name=${srtName} toast=${srtToast}`);
    r.check(
      "⑤ 편집본 SRT 원문 대조 — 시각 = out(t), 잘린 'um'·'is a' 없음, 교정·바꾸기 반영",
      srt === wantSrt,
      J(srt.slice(0, 200)),
    );
    r.check("⑤ 편집본 SRT에 금지 문자(제어·폭 없는·방향 제어) 없음", srt.length > 0 && !hasForbidden(srt), `${srt.length}자`);

    // ── ⑤ 편집본 mp4 — ExportPanel(편집 모드) · 토스트는 이 doc 창에만 ──
    await d.eval(`(()=>{ const t=[...document.querySelectorAll('[aria-label="플레이어 모드"] [role="tab"]')].find(b=>/편집/.test(b.textContent||'')); if (t && !t.disabled) t.click(); return true; })()`);
    const panel = await poll(`!!document.querySelector('[data-gpv="caption-cut-toggle"] input')`, (v) => v === true, 60);
    if (!r.check("⑤ 편집 인스펙터에 '대본 편집' 섹션", panel === true)) return;
    await d.eval(`(()=>{ const cb=document.querySelector('[data-gpv="caption-cut-toggle"] input'); if (!cb.checked) cb.click(); return true; })()`);
    const outName = await poll(`document.querySelector('.gpv-export-panel input[type=text]')?.value ?? ''`, (v) => v === OUT_MP4, 20);
    const hatches = await d.eval(`[...document.querySelectorAll('div')].filter(x=>(x.style.backgroundImage||'').includes('repeating-linear-gradient(135deg, var(--color-danger)')).length`);
    r.check(
      `⑤ '대본 편집 반영' → 기본 이름 ${OUT_MP4} · S1 트랙 빗금 5개(빠지는 구간)`,
      outName === OUT_MP4 && hatches === 5,
      `name=${outName} hatch=${hatches}`,
    );
    await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    await d.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    const clicked = await d.eval(
      `(()=>{ const b=[...document.querySelectorAll('.gpv-export-panel button')].find(x=>x.textContent.trim()==='내보내기' && !x.dataset.tab);
         if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`,
    );
    const docToast = await poll(`__gpvCap.toasts()`, (t) => /내보내기 완료|error:/.test(t), 120, 500);
    const mainToast = await cdp.eval(`window.__gpv.ui.getState().toasts.map(t => t.kind + ':' + t.message).join(' | ')`);
    r.check(
      "⑤ 편집본 내보내기 완료 토스트가 그 doc 창에만(메인 0개)",
      clicked === "ok" && /success:내보내기 완료/.test(docToast) && !/내보내기/.test(mainToast),
      `click=${clicked} doc="${docToast}" main="${mainToast}"`,
    );
    const mp4Abs = join(fix.repo, OUT_MP4);
    if (existsSync(mp4Abs)) {
      const frame = 1 / FPS;
      const fmt = probeDur(mp4Abs);
      const vid = probeDur(mp4Abs, "v:0");
      const aud = probeDur(mp4Abs, "a:0");
      r.check(
        "⑤ 편집본 mp4 길이 ≈ Σkeep 5.2s(±1프레임) — 컨테이너·영상·오디오 스트림 모두",
        [fmt, vid, aud].every((x) => Math.abs(x - 5.2) <= frame + 0.001),
        `format=${fmt} video=${vid} audio=${aud}`,
      );
    } else {
      r.check("⑤ 편집본 mp4 생성", false, `${OUT_MP4} 없음`);
    }

    // ── ⑤b 자막 입힌 영상 — IPC 직접(P3 백엔드. 내보내기 UI는 프론트 단계) ──
    const subsSpec = (o) => ({
      srcRel: SRC, overwrite: true, range: null, speed: null, crop: null, masks: null, maskKind: "mosaic", crf: 23,
      maxHeight: null, removeAudio: false, durationMs: D, hasAudio: true, ...o,
    });
    const sttDir = await cdp
      .eval(`(async()=>{ const m=await import("/node_modules/@tauri-apps/api/path.js"); return await m.join(await m.appLocalDataDir(), "stt"); })()`)
      .catch(() => null);
    const subsTemps = () => {
      try {
        return readdirSync(sttDir).filter((n) => /^gpv-stt-(burn|subs)-/.test(n));
      } catch {
        return []; // 폴더가 아직 없으면 남은 것도 없다
      }
    };
    const tempsBefore = subsTemps();
    const subsDoc = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    const wantSoft = await cdp.eval(`window.__gpv.caption.captionSourceCues(${J(subsDoc.doc)}, true)`);
    const soft = await cdp.try(
      "video_export",
      { projectId: pid, jobId: crypto.randomUUID(), spec: subsSpec({ outRel: OUT_SOFT, mode: "copy", crf: null, captionSubs: { mode: "soft", timeline: "source", text: "caption", lang: null, preset: "basic" } }) },
      { timeoutMs: 60000 },
    );
    const softAbs = join(fix.repo, OUT_SOFT);
    const softBack = soft.ok && existsSync(softAbs)
      ? parseSrt(execFileSync("ffmpeg", ["-v", "error", "-i", softAbs, "-map", "0:s:0", "-f", "srt", "-"], { encoding: "utf8" }))
      : [];
    // 무손실 복사는 B프레임의 음수 DTS 때문에 `-avoid_negative_ts make_zero`가 모든 스트림을 같은 만큼 민다(실측 +66ms) —
    // 자막이 맞는지는 0이 아니라 **출력 영상의 시작**에 대해 잰다(원본 t 프레임 = 출력 t + 이동).
    const vStart = (f) =>
      Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
    const shiftMs = softBack.length ? Math.round((vStart(softAbs) - vStart(srcAbs)) * 1000) : 0;
    r.check(
      "⑤b 소프트 자막(무손실 복사) → mov_text를 되읽으면 원본 시각 cue 그대로(영상과 같은 이동 ±2ms·글·개수, 잘린 어절 포함)",
      soft.ok && wantSoft.length > 0 && softBack.length === wantSoft.length &&
        wantSoft.every((w, i) =>
          Math.abs(softBack[i].startMs - shiftMs - w.startMs) <= 2 && Math.abs(softBack[i].endMs - shiftMs - w.endMs) <= 2 && softBack[i].text === w.text),
      `${soft.ok ? "" : soft.code + " " + soft.message} 영상 이동=${shiftMs}ms want=${J(wantSoft.map((c) => [c.startMs, c.endMs, c.text]))} got=${J(softBack.map((c) => [c.startMs, c.endMs, c.text]))}`,
    );
    const softStreams = soft.ok && existsSync(softAbs) ? streamsOf(softAbs) : "파일 없음";
    r.check("⑤b 소프트 자막 mp4 스트림 = 영상 h264 · 소리 aac · 자막 mov_text", softStreams === "video:h264,audio:aac,subtitle:mov_text", softStreams);

    const mismatch = await cdp.try("video_export", {
      projectId: pid, jobId: crypto.randomUUID(),
      spec: subsSpec({ outRel: OUT_BURN, mode: "encode", captionCut: true, captionSubs: { mode: "burn", timeline: "source", text: "caption", lang: null, preset: "basic" } }),
    });
    r.check("⑤b 편집본에 원본 시각 자막은 거절(시간축 짝)", !mismatch.ok && /편집본 시각 자막만/.test(mismatch.message || ""), `${mismatch.code} ${mismatch.message}`);

    const burnSpec = subsSpec({ outRel: OUT_BURN, mode: "encode", captionCut: true, captionSubs: { mode: "burn", timeline: "edited", text: "caption", lang: null, preset: "box" } });
    const burn = await cdp.try("video_export", { projectId: pid, jobId: crypto.randomUUID(), spec: burnSpec }, { timeoutMs: 120000 });
    const burnAbs = join(fix.repo, OUT_BURN);
    if (tool.r.hasSubtitlesFilter) {
      const dur = burn.ok && existsSync(burnAbs) ? probeDur(burnAbs) : NaN;
      // 편집본 시각 cue: 0.5–1.4 · 2.1–3.1 · 3.7–4.6(⑤ SRT). 2.3초는 자막 자리, 3.3초는 자막 사이 — 원본 시각(3.0–5.4)을
      // 잘못 쓰면 둘 다 뒤집힌다.
      const plainOk = existsSync(join(fix.repo, OUT_MP4));
      const on = plainOk && burn.ok ? changedFraction(bottomGray(burnAbs, 2.3), bottomGray(join(fix.repo, OUT_MP4), 2.3)) : NaN;
      const off = plainOk && burn.ok ? changedFraction(bottomGray(burnAbs, 3.3), bottomGray(join(fix.repo, OUT_MP4), 3.3)) : NaN;
      r.check(
        "⑤b 번인(편집본 시각, 박스) → 길이 Σkeep 5.2s · 자막 자리만 ⑤ 편집본과 다르다",
        burn.ok && Math.abs(dur - 5.2) <= 1 / FPS + 0.001 && on > 0.01 && off < 0.002,
        `${burn.ok ? "" : burn.code + " " + burn.message} dur=${dur} 바뀐 화소(자막)=${(on * 100).toFixed(2)}% (없음)=${(off * 100).toFixed(2)}%`,
      );
      // 번인은 화면에 그리므로 자막 스트림이 따로 없어야 한다(소프트와 섞이면 플레이어가 두 번 그린다).
      const burnStreams = burn.ok && existsSync(burnAbs) ? streamsOf(burnAbs) : "파일 없음";
      r.check("⑤b 번인 mp4 스트림 = 영상 h264 · 소리 aac뿐(자막 스트림 없음)", burnStreams === "video:h264,audio:aac", burnStreams);
    } else {
      r.check("⑤b libass 없는 ffmpeg의 번인은 TOOL_NOT_FOUND(소프트 안내)", !burn.ok && burn.code === "TOOL_NOT_FOUND", `${burn.code} ${burn.message}`);
    }
    if (sttDir) {
      // 앱 로컬 데이터는 샤드·dev 앱이 공유한다(shard.mjs) — 다른 샤드의 자막 내보내기(66 ④)가 돌고 있으면 그 임시 파일이
      // 잠깐 보인다. ⑤b 전에 없던 것 중 30초 안에 사라지지 않는 것만 남은 것으로 센다(잡이 끝나면 가드가 지운다).
      const newTemps = () => subsTemps().filter((n) => !tempsBefore.includes(n));
      let left = newTemps();
      for (let i = 0; i < 60 && left.length; i++) {
        await sleep(500);
        left = newTemps();
      }
      r.check("⑤b 자막 임시 파일(stt/gpv-stt-burn-*·subs-*)이 남지 않는다", left.length === 0, `before=${tempsBefore.join(",")} 남음=${left.join(",")}`);
    } else {
      r.skip("⑤b 자막 임시 파일 정리", "appLocalDataDir를 못 읽었다");
    }

    // ── ⑤c 자막 스타일·자막 넣기 UI(P3 프론트) ──
    const setSelect = (sel, v) =>
      d.eval(`(()=>{ const s=document.querySelector(${J(sel)}); if (!s) return 'no-select'; if (s.disabled) return 'disabled';
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${J(v)});
        s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    const styleSet = await setSelect('[data-gpv="caption-style"]', "box");
    const styled = await poll(`__gpvCap.settled() ? (__gpvCap.doc().stylePreset ?? 'basic') : null`, (v) => v === "box", 40);
    const styledDisk = (await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC }))?.doc.stylePreset;
    r.check("⑤c CC 옆 스타일 → 문서에 저장(Rust 왕복 후에도 box)", styleSet === "ok" && styled === "box" && styledDisk === "box", `set=${styleSet} store=${styled} disk=${styledDisk}`);
    await seekDoc(700);
    await poll(`__gpvCap.overlay()`, (t) => !!t, 20);
    const ovl = await d.eval(`(()=>{ const w=document.querySelector('[data-gpv="caption-overlay"]'); const t=document.querySelector('[data-gpv="caption-overlay-text"]');
      if (!w || !t) return null; const b=w.parentElement; const f=window.__gpv.caption.captionOverlayLayout;
      const L=f('box', b.clientWidth, b.clientHeight), B=f('basic', b.clientWidth, b.clientHeight); const cs=getComputedStyle(t);
      return { preset: w.dataset.preset, bottom: parseFloat(w.style.bottom), want: L.bottom, basic: B.bottom, font: parseFloat(cs.fontSize), wantFont: L.fontSize, bg: cs.backgroundColor }; })()`);
    r.check(
      "⑤c 오버레이가 box 값 표를 따른다(아래 여백 = MarginV − 박스 여백 ≠ basic · 글자 크기 · 반투명 박스)",
      !!ovl && ovl.preset === "box" && Math.abs(ovl.bottom - ovl.want) < 0.5 && Math.abs(ovl.want - ovl.basic) >= 1 &&
        Math.abs(ovl.font - ovl.wantFont) < 0.5 && ovl.bg === "rgba(0, 0, 0, 0.7)",
      J(ovl),
    );
    const label = await d.eval(`window.__gpv.caption.sttAudioTrackLabel({ index: 1, codec: 'aac', channels: 2, language: 'kor', title: '마이크' }) + ' / ' +
      window.__gpv.caption.sttAudioTrackLabel({ index: 0, codec: null, channels: null, language: 'und', title: null })`);
    r.check("⑤c 오디오 트랙 이름(번호 1부터·und 생략)", label === "트랙 2 · kor · 마이크 · aac 2ch / 트랙 1", label);

    // ExportPanel — '대본 편집 반영'(⑤에서 켬)과 함께 자막 트랙 → 편집본 시각 · 기본 이름 name.cut.sub.mp4.
    const libass = !!tool.r.hasSubtitlesFilter;
    const burnDisabled = await d.eval(`document.querySelector('[data-gpv="caption-subs"] option[value=burn]')?.disabled ?? null`);
    let burnNote = true;
    if (libass) {
      await setSelect('[data-gpv="caption-subs"]', "burn");
      burnNote = await poll(`(document.querySelector('.gpv-export-panel')?.textContent || '').includes('스타일 박스')`, (v) => v === true, 20);
    }
    r.check("⑤c 번인 선택지는 libass가 있을 때만 · 번인 스타일 = 문서 스타일", burnDisabled === !libass && burnNote === true, `libass=${libass} disabled=${burnDisabled} note=${burnNote}`);
    try {
      unlinkSync(join(fix.repo, OUT_BURN)); // ⑤b 번인 결과 — 같은 이름이라 덮어쓰기 확인이 뜬다
    } catch {
      /* libass 없으면 ⑤b가 만들지 않았다 */
    }
    const softSet = await setSelect('[data-gpv="caption-subs"]', "soft");
    const uiName = await poll(`document.querySelector('.gpv-export-panel input[type=text]')?.value ?? ''`, (v) => v === OUT_BURN, 20);
    const edNote = await d.eval(`(document.querySelector('.gpv-export-panel')?.textContent || '').includes('편집본 시각으로 넣습니다')`);
    await d.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    const uiClick = await d.eval(
      `(()=>{ const b=[...document.querySelectorAll('.gpv-export-panel button')].find(x=>x.textContent.trim()==='내보내기' && !x.dataset.tab);
         if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`,
    );
    const uiToast = await poll(`__gpvCap.toasts()`, (t) => /내보내기 완료|error:/.test(t), 120, 500);
    const uiAbs = join(fix.repo, OUT_BURN);
    const wantEd = (await d.eval(`__gpvCap.entry().plan.outCues.filter(c => c.text.trim()).map(c => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }))`)) ?? [];
    const uiBack = existsSync(uiAbs)
      ? parseSrt(execFileSync("ffmpeg", ["-v", "error", "-i", uiAbs, "-map", "0:s:0", "-f", "srt", "-"], { encoding: "utf8" }))
      : [];
    const uiShift = uiBack.length ? Math.round(vStart(uiAbs) * 1000) : 0;
    r.check(
      "⑤c 자막 트랙(UI) + 대본 편집 → 기본 이름 .cut.sub.mp4 · mov_text = 편집본 시각 cue(±40ms·글·개수)",
      softSet === "ok" && uiName === OUT_BURN && edNote === true && uiClick === "ok" && /success:내보내기 완료/.test(uiToast) &&
        wantEd.length > 0 && uiBack.length === wantEd.length &&
        wantEd.every((w, i) => Math.abs(uiBack[i].startMs - uiShift - w.startMs) <= 40 && Math.abs(uiBack[i].endMs - uiShift - w.endMs) <= 40 && uiBack[i].text === w.text),
      `set=${softSet} name=${uiName} note=${edNote} click=${uiClick} toast="${uiToast}" shift=${uiShift} want=${J(wantEd.map((c) => [c.startMs, c.endMs, c.text]))} got=${J(uiBack.map((c) => [c.startMs, c.endMs, c.text]))}`,
    );
    await setSelect('[data-gpv="caption-subs"]', "none");

    // ── ⑤d 번역 자막(P4) — LLM 없이. 순수 함수엔 가짜 chat, 스토어엔 번역 잡이 배치마다 쓰는 함수(setCaptionTranslations) ──
    const pure = await d.eval(`(async()=>{
      const C = window.__gpv.caption;
      const P = (t, s) => C.parseCaptionTranslation(t, s);
      const out = {
        shifted: P('1|A => a\\n2|C => c\\n3|B => b', ['A','B','C']),
        good: P('서문 한 줄\\n1|A. => a\\n2|B, => b\\n3|C => 3|c|', ['A','B','C']),
        punct: P('1|Hello。 => 안녕\\n2|x | y', ['Hello.', 'x']),
        salvage: P('1|1|Hello', ['안녕']),
        echoOnly: P('1|안녕하세요.', ['안녕하세요.']),
        junk: P('???', ['안녕']),
        chatter: P('1|A => a\\n2|B => b\\nHope this helps!', ['A','B']),
      };
      // 가짜 chat — 3줄 이상 배치엔 한 줄씩 밀린 답(번호 개수는 맞다), 2줄 이하엔 바른 답. 첫 호출은 잘림.
      const items = ['하나','둘\\n셋','넷','다섯','여섯'].map((t,i)=>({ cueId:'k'+i, text:t, src:'s'+i }));
      const sizes = [], users = [];
      let first = true;
      const chat = async (messages, o) => {
        const lines = messages[1].content.split('\\n');
        sizes.push(lines.length + '@' + o.temperature);
        users.push(messages[1].content);
        if (first) { first = false; return { text: '', truncated: true }; }
        const src = lines.map((l) => l.slice(l.indexOf('|') + 1));
        return { text: src.map((s, i) => (i + 1) + '|' + (lines.length >= 3 ? src[(i + 1) % src.length] : s) + ' => T(' + s + ')').join('\\n'), truncated: false };
      };
      const got = [], failed = [];
      await C.translateCaptionItems({ items, lang: 'en', ctx: 8192, chat, onChunk: (g, f) => { got.push(...g); failed.push(...f); } });
      const failed2 = [];
      await C.translateCaptionItems({ items: items.slice(0, 2), lang: 'en', ctx: 8192, chat: async () => ({ text: '', truncated: false }),
        onChunk: (g, f) => failed2.push(...g.map((x) => 'ok:' + x.cueId), ...f) });
      // 요청 중에 취소 — llm_cancel이 헛돌아(요청 등록 전) 바른 답이 그대로 와도 쓰지 않아야 한다.
      const ac = new AbortController(), late = [];
      let abortName = null;
      try {
        await C.translateCaptionItems({ items: items.slice(0, 1), lang: 'en', ctx: 8192, signal: ac.signal,
          chat: async (messages) => { ac.abort(); return { text: '1|' + messages[1].content.slice(2) + ' => late', truncated: false }; },
          onChunk: (g) => late.push(...g.map((x) => x.cueId)) });
      } catch (e) { abortName = e.name; }
      // 번역하지 않고 원문을 번역 자리에 그대로 돌려준 답(1.7B 실측) — 대상 언어 글자가 원문에 없으면 거절(한국어), 원문이 이미
      // 한국어면 받는다. 라틴 문자 대상(영어)은 가릴 수 없어 받는다.
      const echoChat = async (messages) => ({ truncated: false,
        text: messages[1].content.split('\\n').map((l, i) => { const s = l.slice(l.indexOf('|') + 1); return (i + 1) + '|' + s + ' => ' + s; }).join('\\n') });
      const echoItems = [{ cueId: 'e0', text: 'second line', src: 'h0' }, { cueId: 'e1', text: '안녕하세요', src: 'h1' }];
      const echo = async (lang) => { const o = []; await C.translateCaptionItems({ items: echoItems, lang, ctx: 8192, chat: echoChat,
        onChunk: (g, f) => o.push(...g.map((x) => 'ok:' + x.cueId), ...f.map((x) => 'fail:' + x)) }); return o; };
      const echoKo = await echo('ko'), echoEn = await echo('en');
      // 잡 도중 손으로 고친(a)·새로 쓴(c) 번역 줄은 늦게 온 배치가 덮지 않는다 — base = 잡을 시작할 때의 번역. 손대지 않은
      // 줄(b)만 LLM 답으로. base 없이 쓰면(손으로 고치기·대조군) 다 덮는다.
      const bdoc = { cues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], translations: { ko: { a: '손 a', b: '옛 b', c: '손 c' } },
        translationSrc: { ko: { a: 'h', b: 'h', c: 'h' } } };
      const bgot = ['a', 'b', 'c'].map((id) => ({ cueId: id, text: 'LLM ' + id, src: 's' }));
      const withBase = C.setCaptionTranslations(bdoc, 'ko', bgot, { a: '옛 a', b: '옛 b' })?.translations.ko ?? null;
      const noBase = C.setCaptionTranslations(bdoc, 'ko', bgot)?.translations.ko ?? null;
      return { ...out, sizes, user0: users[0], got: got.map((g) => g.cueId + '=' + g.text + '@' + g.src), failed, failed2, late, abortName, echoKo, echoEn,
        withBase, noBase };
    })()`);
    r.check(
      "⑤d 응답 검증: 한 줄씩 밀린 답(번호 개수는 맞음) 거절 · 서문 무시·같은 번호 반복·문장부호 차이 허용 · 뒤따르는 잡담·원문만 베낀 답·기호뿐인 답 거절",
      pure.shifted === null && J(pure.good) === J(["a", "b", "c"]) && J(pure.punct) === J(["안녕", "y"]) &&
        J(pure.salvage) === J(["Hello"]) && pure.echoOnly === null && pure.junk === null && pure.chatter === null,
      J({ shifted: pure.shifted, good: pure.good, punct: pure.punct, salvage: pure.salvage, echoOnly: pure.echoOnly, junk: pure.junk, chatter: pure.chatter }),
    );
    r.check(
      "⑤d 번역 배치: 잘림·밀린 답 → temperature 0 → 반으로 → 한 줄까지 · cue id로 다시 붙임 · 타임코드 없이 번호|글만 보냄",
      J(pure.sizes) === J(["5@0.2", "5@0", "3@0.2", "3@0", "2@0.2", "1@0.2", "2@0.2"]) &&
        J(pure.got) === J(["k0=T(하나)@s0", "k1=T(둘 셋)@s1", "k2=T(넷)@s2", "k3=T(다섯)@s3", "k4=T(여섯)@s4"]) &&
        pure.failed.length === 0 && pure.user0 === "1|하나\n2|둘 ⏎ 셋\n3|넷\n4|다섯\n5|여섯" &&
        J(pure.failed2) === J(["k0", "k1"]),
      J({ sizes: pure.sizes, got: pure.got, failed: pure.failed, failed2: pure.failed2, user0: pure.user0 }),
    );
    r.check(
      "⑤d 원문을 그대로 돌려준 답: 한국어 대상 + 원문에 한글 없음 → 거절(쪼개도 실패로 남음) · 원문이 이미 한국어면 받음 · 영어 대상은 받음",
      J(pure.echoKo) === J(["fail:e0", "ok:e1"]) && J(pure.echoEn) === J(["ok:e0", "ok:e1"]),
      J({ ko: pure.echoKo, en: pure.echoEn }),
    );
    r.check(
      "⑤d 요청 중 취소 → 답이 와도 쓰지 않고 AbortError로 끝난다(헛돈 llm_cancel 대비)",
      pure.late.length === 0 && pure.abortName === "AbortError",
      J({ late: pure.late, abortName: pure.abortName }),
    );
    r.check(
      "⑤d 번역 배치 쓰기: 잡을 시작한 뒤 손으로 고치거나 새로 쓴 번역 줄은 덮지 않는다(base) · base 없으면 다 덮는다",
      J(pure.withBase) === J({ a: "손 a", b: "LLM b", c: "손 c" }) && J(pure.noBase) === J({ a: "LLM a", b: "LLM b", c: "LLM c" }),
      J({ withBase: pure.withBase, noBase: pure.noBase }),
    );

    const trIds =
      (await d.eval(`(()=>{ const C=window.__gpv.caption; const items=C.captionTranslateItems(__gpvCap.doc());
        const ok=__gpvCap.st().edit(${J(key)}, (doc)=>C.setCaptionTranslations(doc, 'ko', items.map((it, i)=>({ cueId: it.cueId, text: '번역' + (i + 1), src: it.src }))));
        return ok ? items.map((it)=>it.cueId) : null; })()`)) ?? [];
    const trSaved = await poll(`__gpvCap.settled() ? Object.keys(__gpvCap.doc().translations?.ko ?? {}).length : -1`, (n) => n === trIds.length, 40);
    const trDisk = (await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC }))?.doc;
    r.check(
      "⑤d 번역을 문서에 쓰면 자동 저장 — translations·translationSrc 둘 다 Rust 왕복",
      trIds.length >= 2 && trSaved === trIds.length && Object.keys(trDisk?.translations?.ko ?? {}).length === trIds.length &&
        Object.keys(trDisk?.translationSrc?.ko ?? {}).length === trIds.length,
      `ids=${J(trIds)} store=${trSaved} disk=${J(trDisk?.translations)} src=${Object.keys(trDisk?.translationSrc?.ko ?? {}).length}`,
    );
    await d.eval(`(()=>{ document.querySelector('[data-gpv="translate-toggle"]')?.click(); return true; })()`);
    const trUi = await poll(
      `(()=>{ const p=document.querySelector('[data-gpv="translate-panel"]'); if (!p) return null;
        return { lang: p.querySelector('[data-gpv="translate-lang"]').value, count: p.querySelector('[data-gpv="translate-count"]').textContent,
          start: p.querySelector('[data-gpv="translate-start"]')?.textContent ?? null,
          lines: [...document.querySelectorAll('[data-gpv="translation-line"]')].map((x)=>x.textContent) }; })()`,
      (v) => !!v && v.lines.length === trIds.length,
      20,
    );
    r.check(
      "⑤d [번역] 팝업: 기본 대상 = 번역한 언어(ko) · n/n줄 · 모두 번역됨 · 행마다 번역 줄",
      !!trUi && trUi.lang === "ko" && trUi.count === `${trIds.length}/${trIds.length}줄` && trUi.start === "모두 번역됨" &&
        J(trUi.lines) === J(trIds.map((_, i) => `번역${i + 1}`)),
      J(trUi),
    );

    // 오버레이 2단 — CC 옆 "원문 + 한국어".
    const ccSet = await setSelect('[data-gpv="caption-trans"]', "ko");
    const pick = await d.eval(`(()=>{ const C=window.__gpv.caption; const doc=__gpvCap.doc(); const tr=doc.translations.ko;
      const c=C.captionSourceCues(doc, false).find((x)=>tr[x.cueId]); if (!c) return null;
      const full=C.captionSourceCues(doc, true).find((x)=>x.cueId===c.cueId);
      return { at: c.startMs + 50, want: [c.text + '\\n' + tr[c.cueId], full.text + '\\n' + tr[c.cueId]] }; })()`);
    if (pick) await seekDoc(pick.at);
    const ov2line = await poll(`__gpvCap.overlay()`, (t) => !!pick && pick.want.includes(t), 20);
    r.check("⑤d 오버레이 2단: 원문 아래 번역(CC 옆 '원문 + 한국어')", ccSet === "ok" && !!pick && pick.want.includes(ov2line), `set=${ccSet} got=${J(ov2line)} want=${J(pick?.want)}`);
    await setSelect('[data-gpv="caption-trans"]', "");

    // 원문을 고치면 그 cue만 "원문 바뀜" → 번역 줄을 손으로 고치면 풀린다.
    const staleId = trIds[0];
    await d.eval(`__gpvCap.st().edit(${J(key)}, (doc)=>window.__gpv.caption.setCaptionCueCaption(doc, ${J(staleId)}, '새 자막 줄 P4'))`);
    const stale = await poll(
      `(()=>({ badges: document.querySelectorAll('[data-gpv="translation-stale"]').length,
        start: document.querySelector('[data-gpv="translate-start"]')?.textContent ?? null,
        pending: window.__gpv.caption.captionTranslatePending(__gpvCap.doc(), 'ko').map((x)=>x.cueId) }))()`,
      (v) => v.badges === 1 && /남은 1줄/.test(v.start ?? ""),
      20,
    );
    r.check(
      "⑤d 원문(자막 줄)을 고친 cue만 '원문 바뀜' · 이어서 번역 대상 = 그 cue 하나(남은 1줄)",
      stale.badges === 1 && J(stale.pending) === J([staleId]) && /이어서 번역 \(남은 1줄\)/.test(stale.start ?? ""),
      J(stale),
    );
    const trClick = await d.eval(`(()=>{ const l=document.querySelector('[data-cue=${J(staleId)}] [data-gpv="translation-line"]'); if (!l) return 'no-line'; l.click(); return 'ok'; })()`);
    const ta = await poll(`!!document.querySelector('[data-cue=${J(staleId)}] textarea')`, (v) => v === true, 20);
    await d.eval(`(()=>{ const t=document.querySelector('[data-cue=${J(staleId)}] textarea'); __gpvCap.setVal(t, '고친 번역'); return __gpvCap.key('Enter', {}, t); })()`);
    const fixed = await poll(
      `__gpvCap.settled() ? { tr: __gpvCap.doc().translations.ko[${J(staleId)}], badges: document.querySelectorAll('[data-gpv="translation-stale"]').length,
        pending: window.__gpv.caption.captionTranslatePending(__gpvCap.doc(), 'ko').length } : null`,
      (v) => !!v && v.tr === "고친 번역" && v.badges === 0,
      40,
    );
    r.check(
      "⑤d 번역 줄 클릭 → 고쳐 Enter → 저장 · 원문 해시 갱신('원문 바뀜' 풀림·남은 줄 0)",
      trClick === "ok" && ta === true && !!fixed && fixed.tr === "고친 번역" && fixed.badges === 0 && fixed.pending === 0,
      J({ trClick, ta, fixed }),
    );
    // 키보드로 번역 줄 고치기 — 그 cue의 토큰을 골라(caret) Alt+Shift+F2 → 번역 줄 입력(초깃값 = 번역) · Esc 취소.
    const kbId = trIds[1];
    const kbOpen = await d.eval(`(()=>{ const t=document.querySelector('[data-cue=${J(kbId)}] [data-tid]'); if (!t || !__gpvCap.down(t.dataset.tid)) return 'no-token';
      return true; })()`);
    await sleep(120);
    await d.eval(`__gpvCap.key('F2', { altKey: true, shiftKey: true })`);
    const kbTa = await poll(`document.querySelector('[data-cue=${J(kbId)}] textarea')?.value ?? null`, (v) => v !== null, 20);
    await d.eval(`(()=>{ const t=document.querySelector('[data-cue=${J(kbId)}] textarea'); return t ? __gpvCap.key('Escape', {}, t) : false; })()`);
    const kbClosed = await poll(`!document.querySelector('[data-cue=${J(kbId)}] textarea')`, (v) => v === true, 20);
    r.check(
      "⑤d Alt+Shift+F2 → caret이 든 cue의 번역 줄 고치기(마우스 없이) · Esc 취소",
      kbOpen === true && kbTa === "번역2" && kbClosed === true,
      J({ kbOpen, kbTa, kbClosed }),
    );

    // 자막 파일 2단 — 대본 패널 내보내기(⑤에서 고른 편집본 시각이 남아 있다) → name.cut.ko.dual.srt.
    await d.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] }); document.querySelector('[data-gpv="subs-export-toggle"]')?.click(); return true; })()`);
    await poll(`!!document.querySelector('[data-gpv="subs-text-both"]')`, (v) => v === true, 20);
    await d.eval(`(()=>{ document.querySelector('[data-gpv="subs-text-both"]').click(); return true; })()`);
    const dualName = await poll(`document.querySelector('[data-gpv="subs-export"] input')?.value ?? ''`, (v) => v === OUT_DUAL, 20);
    await d.eval(`__gpvCap.click(__gpvCap.btn(document.querySelector('[data-gpv="subs-export"]'), '자막 파일 저장'))`);
    const dualToast = await poll(`__gpvCap.toasts()`, (t) => /자막 파일 저장/.test(t) || /error:/.test(t), 40);
    const dualAbs = join(fix.repo, OUT_DUAL);
    const dual = existsSync(dualAbs) ? parseSrt(readFileSync(dualAbs, "utf8")) : [];
    const wantDual = await d.eval(`(()=>{ const e=__gpvCap.entry(); const tr=e.doc.translations.ko;
      return e.plan.outCues.filter((c)=>c.text.trim()).map((c)=>({ startMs: c.startMs, endMs: c.endMs,
        text: c.text.split('\\n').map((s)=>s.trim()).filter(Boolean).join('\\n') + '\\n' + tr[c.cueId] })); })()`);
    r.check(
      `⑤d 자막 파일 2단(편집본 시각) → 기본 이름 ${OUT_DUAL} · 줄마다 원문 아래 번역 · 시각 = plan.outCues`,
      dualName === OUT_DUAL && /success:자막 파일 저장/.test(dualToast) && wantDual.length > 0 && J(dual) === J(wantDual),
      `name=${dualName} toast=${dualToast} got=${J(dual)} want=${J(wantDual)}`,
    );

    // 번역만(원본 시각) — IPC 직접. 원본 시각 cue(잘린 어절 포함, Rust source_cues)마다 원문 대신 그 cue id의 번역이 붙는다.
    const trOut = await cdp.try("caption_export_subs", {
      projectId: pid,
      relPath: SRC,
      spec: { format: "srt", timeline: "source", text: "translation", lang: "ko", outRel: OUT_TR, overwrite: true },
    });
    const trAbs = join(fix.repo, OUT_TR);
    const trSrt = existsSync(trAbs) ? parseSrt(readFileSync(trAbs, "utf8")) : [];
    const wantTr = await d.eval(`(()=>{ const doc=__gpvCap.doc(); const tr=doc.translations.ko;
      return window.__gpv.caption.captionSourceCues(doc, true).filter((c)=>c.text.trim()).map((c)=>({ startMs: c.startMs, endMs: c.endMs, text: tr[c.cueId] })); })()`);
    r.check(
      `⑤d 번역만(원본 시각) SRT ${OUT_TR} — 원본 시각 cue마다 원문 대신 번역 · 시각 = 원본 cue`,
      trOut.ok && wantTr.length > 0 && wantTr.every((w) => typeof w.text === "string") && J(trSrt) === J(wantTr),
      `${trOut.ok ? "" : trOut.code + " " + trOut.message} got=${J(trSrt)} want=${J(wantTr)}`,
    );

    // 빠진 번역 — 패널·ExportPanel이 미리 막고, 백엔드도 원문으로 채우지 않고 거절한다.
    const missId = trIds[trIds.length - 1];
    await d.eval(`__gpvCap.st().edit(${J(key)}, (doc)=>window.__gpv.caption.setCaptionTranslation(doc, 'ko', ${J(missId)}, ''))`);
    await poll(`__gpvCap.settled() && !(${J(missId)} in (__gpvCap.doc().translations.ko ?? {}))`, (v) => v === true, 40);
    await d.eval(`(()=>{ if (!document.querySelector('[data-gpv="subs-export"]')) document.querySelector('[data-gpv="subs-export-toggle"]')?.click(); return true; })()`);
    const panelMiss = await poll(
      `(()=>{ const w=document.querySelector('[data-gpv="subs-trans-missing"]'); const b=__gpvCap.btn(document.querySelector('[data-gpv="subs-export"]'), '자막 파일 저장');
        return { warn: w ? w.textContent : null, disabled: b ? b.disabled : null }; })()`,
      (v) => !!v.warn,
      20,
    );
    await setSelect('[data-gpv="caption-subs"]', "soft");
    const exText = await setSelect('[data-gpv="caption-subs-text"]', "both");
    const exMiss = await poll(`(document.querySelector('.gpv-export-panel')?.textContent || '').includes('번역이 1줄 빠졌습니다')`, (v) => v === true, 20);
    await setSelect('[data-gpv="caption-subs"]', "none");
    const missBack = await cdp.try("caption_export_subs", {
      projectId: pid,
      relPath: SRC,
      spec: { format: "srt", timeline: "edited", text: "translation", lang: "ko", outRel: "e2e-cap.p4-miss.srt", overwrite: false },
    });
    r.check(
      "⑤d 번역이 빠진 줄이 있으면 막는다 — 패널(안내·저장 버튼 비활성)·ExportPanel(안내)·백엔드(거절, 파일 안 씀)",
      /1줄 빠졌습니다/.test(panelMiss.warn ?? "") && panelMiss.disabled === true && exText === "ok" && exMiss === true &&
        !missBack.ok && /1줄에 번역이 없습니다/.test(missBack.message || "") && !existsSync(join(fix.repo, "e2e-cap.p4-miss.srt")),
      J({ panelMiss, exText, exMiss, back: `${missBack.code} ${missBack.message ?? ""}` }),
    );
    await d.eval(`(()=>{ if (document.querySelector('[data-gpv="subs-export"]')) document.querySelector('[data-gpv="subs-export-toggle"]')?.click(); return true; })()`);

    // 실제 LLM — `E2E_LLM_GGUF`(소형 GGUF, 예: dev 데이터의 Qwen3-1.7B-Q8_0.gguf)를 줄 때만(47과 같은 게이트·주입). 기본 회차에서
    // 모델(수 GB)을 띄우면 다른 샤드와 메모리를 다툰다(e2e 드라이버의 여유 메모리 중단선). 런타임은 샤드가 공유하는 dev 앱 로컬
    // 데이터의 것(47이 E2E_NET=1로 받는다). 스토어 번역 잡: 빠진 한 줄만 이어서 · 시작 직후 취소는 아무 것도 쓰지 않음 ·
    // 한 언어 전체를 한 배치로(chatWithBusyRetry → llm_chat).
    const gguf = process.env.E2E_LLM_GGUF;
    const llmOrig = gguf && existsSync(gguf) ? await cdp.invoke("get_settings") : null;
    const llmRt = llmOrig ? await cdp.invoke("llm_status", {}, { timeoutMs: 10000 }).catch(() => null) : null;
    if (!llmOrig) {
      r.skip("⑤d 실제 LLM 번역(이어서·취소·배치)", "E2E_LLM_GGUF 미주입 — 47과 같은 게이트");
    } else if (!llmRt?.runtime) {
      r.skip("⑤d 실제 LLM 번역(이어서·취소·배치)", "llama 런타임 없음 — E2E_NET=1 회차의 47이 받는다");
    } else {
      await cdp.invoke("set_settings", { settings: { ...llmOrig, llmProvider: "managed", llmModel: "custom", llmCustomModelPath: gguf } });
      const model = gguf.split(/[\\/]/).pop();
      try {
        await d.eval(`(()=>{ __gpvCap.st().translate(${J(key)}, 'ko', 8192); return true; })()`);
        const real = await poll(
          `(()=>{ const e=__gpvCap.entry(); return e.translate ? null : { err: e.translateError, tr: (e.doc.translations || {}).ko || {} }; })()`,
          (v) => !!v,
          240,
          500,
        );
        r.check(
          `⑤d 실제 LLM(${model}): 빠진 한 줄만 이어서 번역 · 다른 줄(손으로 고친 것 포함)은 그대로`,
          !!real && real.err === null && /[가-힣]/.test(real.tr[missId] ?? "") && real.tr[staleId] === "고친 번역" && real.tr[trIds[1]] === "번역2",
          J(real),
        );
        await d.eval(`(()=>{ const s=__gpvCap.st(); s.translate(${J(key)}, 'ja', 8192); s.cancelTranslate(${J(key)}); return true; })()`);
        const cancelled = await poll(
          `(()=>{ const e=__gpvCap.entry(); return e.translate ? null : { err: e.translateError, ja: Object.keys((e.doc.translations || {}).ja || {}).length }; })()`,
          (v) => !!v,
          120,
          500,
        );
        await sleep(1500); // 헛돈 취소로 답이 늦게 와도 쓰지 않는지 — 잠시 뒤 다시 본다
        const jaLate = await d.eval(`Object.keys((__gpvCap.doc().translations || {}).ja || {}).length`);
        r.check(
          "⑤d 시작 직후 취소 → 잡이 오류 없이 끝나고 번역을 쓰지 않는다(늦게 온 답 포함)",
          !!cancelled && cancelled.err === null && cancelled.ja === 0 && jaLate === 0,
          J({ cancelled, jaLate }),
        );

        // 한 언어 전체 — 한국어 번역을 지우고 처음부터. 모든 cue에 한글 번역 · 원문 해시가 지금 원문과 같다(남은 줄 0).
        await d.eval(`__gpvCap.st().edit(${J(key)}, (doc)=>{ const t={ ...(doc.translations || {}) }, s={ ...(doc.translationSrc || {}) };
          delete t.ko; delete s.ko; return { ...doc, translations: t, translationSrc: s }; })`);
        await poll(`__gpvCap.settled() && !((__gpvCap.doc().translations || {}).ko)`, (v) => v === true, 40);
        const t0 = Date.now();
        // 시작하자마자(배치가 LLM에 가 있는 동안) 한 줄을 손으로 번역한다 — 늦게 온 배치가 그 줄을 덮으면 안 된다.
        const handId = trIds[0];
        const hand = await d.eval(`(()=>{ const s=__gpvCap.st(); s.translate(${J(key)}, 'ko', 8192); const busy=!!__gpvCap.entry().translate;
          const ok=s.edit(${J(key)}, (doc)=>window.__gpv.caption.setCaptionTranslation(doc, 'ko', ${J(handId)}, '잡 도중 손 번역')); return { busy, ok }; })()`);
        const full = await poll(
          `(()=>{ const e=__gpvCap.entry(); if (e.translate) return null; const C=window.__gpv.caption; const tr=(e.doc.translations || {}).ko || {};
            return { err: e.translateError, items: C.captionTranslateItems(e.doc).map((it)=>[it.cueId, tr[it.cueId] ?? null]),
              pending: C.captionTranslatePending(e.doc, 'ko').length }; })()`,
          (v) => !!v,
          240,
          500,
        );
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        r.check(
          `⑤d 실제 LLM(${model}): 한 언어 전체 번역 — 모든 cue에 한글 번역 · 남은 줄 0 · 오류 없음 · 잡 도중 손으로 쓴 줄은 그대로`,
          !!full && full.err === null && full.items.length === trIds.length && full.items.every(([, t]) => /[가-힣]/.test(t ?? "")) && full.pending === 0 &&
            hand?.busy === true && hand.ok === true && full.items.find(([id]) => id === handId)?.[1] === "잡 도중 손 번역",
          `${secs}s ${J({ hand, full })}`,
        );
      } finally {
        await cdp.invoke("set_settings", { settings: llmOrig });
        await cdp.invoke("llm_stop", {}, { timeoutMs: 10000 }).catch(() => {}); // 모델 메모리를 다음 스위트에 넘긴다 — 실패해도 앱 종료가 거둔다
      }
    }

    // ── ⑥ 무음 줄이기 복구 ──
    await d.eval(`(()=>{ document.querySelector('[data-gpv="silence-toggle"]')?.click(); return true; })()`);
    await poll(`!!__gpvCap.btn(document.querySelector('[data-gpv="silence-panel"]'), '복구')`, (v) => v === true, 20);
    await d.eval(`__gpvCap.click(__gpvCap.btn(document.querySelector('[data-gpv="silence-panel"]'), '복구'))`);
    const restored = await poll(`(()=>{ const e=__gpvCap.entry(); const x=e.doc; return __gpvCap.settled() && !('silenceKeepMs' in x) && !('silenceMinMs' in x) ? e.plan.keep.map(k=>k.startMs+'-'+k.endMs).join(',') : null; })()`,
      (v) => v === wantCut, 40);
    r.check("⑥ 무음 줄이기 복구 → 두 필드 삭제 · plan이 컷만 반영한 값으로", restored === wantCut, `${restored}`);

    // ── ⑥ approx 문서 — 다른 창(메인)이 저장하면 이 창이 다시 읽고, 컷이 막힌다 ──
    const cur = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    const approxDoc = { ...cur.doc, engine: { ...cur.doc.engine, wordTiming: "approx" } };
    await cdp.invoke("caption_doc_save", { projectId: pid, relPath: SRC, doc: approxDoc, baseRev: cur.doc.rev });
    const note = await poll(`!!document.querySelector('[data-gpv="approx-note"]')`, (v) => v === true, 40);
    await d.eval(`(()=>{ window.__gpv.ui.setState({ toasts: [] }); return __gpvCap.down('t2'); })()`);
    await sleep(120);
    await d.eval(`__gpvCap.key('Delete')`);
    await sleep(300);
    const approxState = await d.eval(`({ cut: __gpvCap.doc().tokens.find(t=>t.id==='t2').cut, toast: __gpvCap.toasts(),
      exportWarn: (document.querySelector('.gpv-export-panel')?.textContent || '').includes('근사값') })`);
    r.check(
      "⑥ approx 문서: 다른 창 저장 → 다시 읽어 배너 · Delete로 안 잘림(안내 토스트) · ExportPanel이 이유 표시",
      note === true && approxState.cut === false && /근사값/.test(approxState.toast) && approxState.exportWarn === true,
      J({ note, ...approxState }),
    );
    const backend = await cdp.try(
      "video_export",
      {
        projectId: pid,
        jobId: crypto.randomUUID(),
        spec: {
          srcRel: SRC, outRel: "e2e-cap.approx.mp4", overwrite: false, range: null, mode: "encode", speed: null,
          crop: null, masks: null, maskKind: "mosaic", crf: 23, maxHeight: null, removeAudio: false,
          durationMs: D, hasAudio: true, captionCut: true,
        },
      },
      { timeoutMs: 30000 },
    );
    r.check(
      "⑥ approx 문서의 편집본 내보내기는 백엔드가 거절(UI 우회 불가)",
      !backend.ok && /근사값/.test(backend.message || "") && !existsSync(join(fix.repo, "e2e-cap.approx.mp4")),
      `${backend.code} ${backend.message ?? ""}`,
    );
  } finally {
    if (d) d.close();
    if (dLabel) {
      await cdp
        .eval(`(async()=>{ const m=await import(${J(WIN_API)}); for (const w of await m.getAllWebviewWindows()) if (w.label===${J(dLabel)}) await w.close(); return true; })()`)
        .catch(() => {});
      // 닫힌 doc 창이 남긴 대상 기록(34 forgetDoc과 같은 정리)
      await cdp
        .eval(`(()=>{ try{ const k='gp:doc-windows'; const v=JSON.parse(localStorage.getItem(k)||'{}'); delete v[${J(dLabel.slice("doc-".length))}]; localStorage.setItem(k, JSON.stringify(v)); }catch(e){} return true; })()`)
        .catch(() => {});
    }
    await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`).catch(() => {});
    for (const rel of created) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 없으면 무해 — 픽스처 정리가 통째로 지운다 */
      }
    }
    await sleep(300);
  }
}
