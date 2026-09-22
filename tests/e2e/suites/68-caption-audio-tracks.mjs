// 태스크 72 P3 — 오디오 트랙이 여럿인 영상 · 번인 불가 안내. **음성 인식 엔진 없이 결정적으로** 돈다: 사인파 두 트랙
// (440Hz eng · 880Hz kor) 영상을 영상 doc 창(64와 같은 경로)으로 열어 대본 패널·ExportPanel을 실제 DOM 이벤트로 구동한다.
//
// 지키는 계약:
//   ① video_probe가 오디오 트랙을 순번(0:a:<n>)·코덱·채널·언어로 돌려준다.
//   ② 자막이 없는 영상의 [자막 만들기] 폼에 트랙 드롭다운(트랙 2개 이상일 때만) — 이름 = sttAudioTrackLabel, 기본 첫 트랙 ·
//      둘째를 고르고 시작하면 전사 요청에 audioStream 1이 실린다. 엔진·모델 준비 판정은 doc 창 쿼리 캐시의 가짜 stt-status로
//      통과시키고 스토어 transcribe를 가로챈다 — 여기서는 드롭다운 → 요청까지만 본다(요청 → 추출 → 문서는 65 ②b가 실제 엔진으로).
//   ③ 문서(source.audioStream 1)가 생기면 [다시 인식] 폼의 트랙 기본값 = 문서의 트랙 · 트랙 목록을 아직 모르면(probe 읽는
//      중) 첫 트랙으로 바꾸지 않고 문서의 트랙으로 요청한다.
//   ④ ExportPanel 자막 트랙 → 어느 트랙이 들어가는지 안내 · 내보낸 mp4는 소리 한 트랙(둘째 = 언어 kor) + mov_text 자막 ·
//      자막 글의 `\ { } <`가 ffmpeg SRT 마크업으로 먹히지 않는다(되읽은 글 = 원문의 전각 치환 — `C:\new`·`<i>`·`{\an8}`·`a<b c>d`).
//   ④b 자막을 만든 트랙이 파일에 없는 stale 문서(원본 교체): ExportPanel 경고 · 백엔드가 거절(소리 없는 영상을 쓰지 않는다).
//   ⑤ libass 없는 ffmpeg(도구 상태만 흉내): 번인 선택지 비활성 + "자막 트랙으로 넣습니다" 안내 · 번인을 고른 뒤 libass가
//      사라지면 경고 + 기본 이름에서 .sub가 빠진다(스펙에 자막을 넣지 않는다).
import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name = "자막 오디오 트랙·번인 불가 안내 (두 트랙 영상 → 전사 폼 드롭다운 → 요청 · 자막 트랙 내보내기 매핑)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

const SRC = "e2e-trk.mp4";
const OUT_SUB = "e2e-trk.sub.mp4";
const OUT_STALE = "e2e-trk.stale.sub.mp4";

/** 소프트 자막이 ffmpeg SRT 디코더를 지나도 글 그대로 남게 백엔드가 바꾸는 글자(video_subs.rs build_soft_srt). */
const softEscape = (s) => s.replace(/[{}\\<]/g, (c) => ({ "{": "｛", "}": "｝", "\\": "＼", "<": "＜" })[c]);

/** mp4의 첫 자막 스트림을 SRT로 되읽어 cue 글만(줄바꿈 포함). */
const softTexts = (file) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:s:0", "-f", "srt", "-"], { encoding: "utf8" })
    .replace(/\r/g, "")
    .split(/\n\n+/)
    .map((b) => b.split("\n").slice(2).join("\n").trim())
    .filter(Boolean);

/** ffprobe 스트림 줄 "type:codec[:language]" — 오디오만 언어를 붙인다(어느 트랙이 들어갔는지 가르는 값). */
const streamsOf = (file) =>
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language", "-of", "csv=p=0", file], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((l) => {
      const [codec, type, lang] = l.split(",");
      return type === "audio" ? `${type}:${codec}:${lang}` : `${type}:${codec}`;
    })
    .join(",");

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found || !tool.r?.probeFound) {
    r.skip("자막 오디오 트랙 전체", "ffmpeg/ffprobe 미발견");
    return;
  }
  const hooks = await cdp.eval(`!!(window.__gpv && window.__gpv.openDocWindow && window.__gpv.captionDoc && window.__gpv.caption)`);
  if (!hooks) {
    r.skip("자막 오디오 트랙 전체", "window.__gpv.openDocWindow/captionDoc/caption 미노출(dev 빌드 아님)");
    return;
  }

  const pid = fix.projectId;
  const srcAbs = join(fix.repo, SRC);
  const key = `${pid}\n${SRC}`;
  let dLabel = null;
  let d = null;
  try {
    // ── ① 픽스처 · probe — 6초 320×240 + 440Hz(eng) + 880Hz(kor) ──
    execFileSync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=6",
        "-map", "0:v", "-map", "1:a", "-map", "2:a",
        "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=kor",
        "-g", "30", "-pix_fmt", "yuv420p", "-shortest", srcAbs,
      ],
      { encoding: "utf8" },
    );
    const probe = await cdp.invoke("video_probe", { projectId: pid, relPath: SRC }, { timeoutMs: 20000 });
    const tracks = (probe.audioStreams ?? []).map((s) => [s.index, s.codec, s.channels, s.language]);
    r.check(
      "① video_probe 오디오 트랙 2개 — 순번 0·1 · aac 1ch · 언어 eng·kor",
      J(tracks) === J([[0, "aac", 1, "eng"], [1, "aac", 1, "kor"]]),
      J(probe.audioStreams),
    );
    const prior = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });

    // ── ② doc 창 · 자막 만들기 폼 ──
    const labels = async () =>
      cdp.eval(`(async()=>{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); })()`);
    const before = await labels();
    await cdp.eval(`window.__gpv.openDocWindow(${J(pid)}, ${J(SRC)}, { size: [1280, 900] })`);
    for (let i = 0; i < 40 && !dLabel; i++) {
      await sleep(500);
      dLabel = (await labels()).find((l) => l.startsWith("doc-") && !before.includes(l)) ?? null;
    }
    if (!r.check("② 영상 doc 창 생성", !!dLabel, dLabel || "미발견")) return;
    d = await connectLabel(dLabel, { port: cdpPort });
    const poll = async (expr, ok, tries = 40, ms = 250) => {
      let v;
      for (let i = 0; i < tries; i++) {
        v = await d.eval(expr).catch((e) => `ERR ${e.message}`);
        if (ok(v)) return v;
        await sleep(ms);
      }
      return v;
    };
    const setSelect = (sel, v) =>
      d.eval(`(()=>{ const s=document.querySelector(${J(sel)}); if (!s) return 'no-select'; if (s.disabled) return 'disabled';
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${J(v)});
        s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    const ready = await poll(`(()=>{ const v=document.querySelector('video'); return v ? v.readyState : -1; })()`, (n) => n >= 1, 60, 500);
    r.check("② doc 창 <video> 메타데이터 로드(readyState≥1)", ready >= 1, `readyState=${ready}`);
    await d.eval(`(()=>{ document.querySelector('video')?.pause(); window.__gpv.ui.setState({ toasts: [] }); return true; })()`);

    const want = await d.eval(`${J(probe.audioStreams)}.map((s)=>[String(s.index), window.__gpv.caption.sttAudioTrackLabel(s)])`);
    if (prior) {
      r.skip("② 자막 만들기 폼의 트랙 드롭다운", `지난 회차 자막 문서가 남아 있다(rev ${prior.doc.rev}) — 폼이 아니라 대본이 보인다`);
    } else {
      const form = await poll(
        `(()=>{ if (!document.querySelector('[data-gpv="transcript-panel"]')) document.querySelector('[data-gpv="transcript-toggle"]')?.click();
          const s=document.querySelector('[data-gpv="stt-audio-track"]'); return s ? { value: s.value, options: [...s.options].map((o)=>[o.value, o.textContent]) } : null; })()`,
        (v) => !!v && typeof v === "object",
      );
      r.check(
        "② 자막 만들기 폼에 오디오 트랙 드롭다운 — 트랙 2개 · 이름 = sttAudioTrackLabel · 기본 첫 트랙",
        !!form && form.value === "0" && J(form.options) === J(want) && want.length === 2,
        `${J(form)} want=${J(want)}`,
      );

      // 준비 판정만 통과시키고(가짜 stt-status — 설정의 기본 모델이 받아져 있다고) 스토어 transcribe를 가로챈다. 한 번의 eval
      // 안에서 끝낸다 — stt-status 쿼리는 5초만 신선하다.
      const cfg = await cdp.invoke("get_settings");
      const picked = await d.eval(`(async()=>{
        const qc=window.__gpv.docQueryClient, S=window.__gpv.captionDoc;
        const frames=()=>new Promise((res)=>requestAnimationFrame(()=>requestAnimationFrame(res)));
        const orig=S.getState().transcribe, calls=[];
        qc.setQueryData(['stt-status'], { runtime: { state: 'found', path: 'e2e-whisper-cli', source: 'managed' }, runtimeSize: 0,
          models: [{ id: ${J(cfg.sttModel)}, label: 'e2e', size: 1, note: '', installed: true }], vadInstalled: true });
        S.setState({ transcribe: async (...a)=>{ calls.push(a); } });
        try {
          await frames();
          const s=document.querySelector('[data-gpv="stt-audio-track"]');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, '1');
          s.dispatchEvent(new Event('change', { bubbles: true }));
          await frames();
          const b=document.querySelector('[data-gpv="stt-start"]');
          const disabled=!b || b.disabled;
          if (!disabled) b.click();
          await frames();
          return { disabled, calls: calls.map(([p, rel, o])=>({ own: p === ${J(pid)} && rel === ${J(SRC)}, audioStream: o.audioStream, modelId: o.modelId })) };
        } finally {
          S.setState({ transcribe: orig });
          void qc.invalidateQueries({ queryKey: ['stt-status'] });
        }
      })()`);
      r.check(
        "② 둘째 트랙을 골라 [자막 만들기] → 전사 요청에 audioStream 1(같은 영상·설정 모델)",
        picked?.disabled === false && picked.calls.length === 1 && picked.calls[0].own && picked.calls[0].audioStream === 1 &&
          picked.calls[0].modelId === cfg.sttModel,
        J(picked),
      );
    }

    // ── ③ 문서가 생기면 [다시 인식]의 기본 트랙 = 문서의 트랙 ──
    const D = probe.durationMs;
    const st = statSync(srcAbs);
    const doc = {
      version: 1,
      rev: 0,
      source: { rel: SRC, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), durationMs: D, startTimeMs: probe.startTimeMs, audioStream: 1 },
      engine: { name: "whisper.cpp", build: "b5130", modelId: "turbo-q5", language: "en", detectedLanguage: "en", vad: true, wordTiming: "dtw" },
      // 화면 녹화 해설에 흔한 경로·태그·비교식 — ffmpeg SRT 디코더가 마크업으로 읽는 글자들(④에서 되읽는다).
      tokens: [
        { id: "t1", kind: "gap", startMs: 0, endMs: 1000, cut: false },
        { id: "t2", kind: "word", startMs: 1000, endMs: 1400, text: "C:\\new", cut: false },
        { id: "t3", kind: "word", startMs: 1500, endMs: 1900, text: "{\\an8}<i>x</i>", cut: false },
        { id: "t4", kind: "word", startMs: 2000, endMs: 2400, text: "a<b", cut: false },
        { id: "t5", kind: "word", startMs: 2500, endMs: 2900, text: "and", cut: false },
        { id: "t6", kind: "word", startMs: 3000, endMs: 3400, text: "c>d.", cut: false },
        { id: "t7", kind: "gap", startMs: 3400, endMs: D, cut: false },
      ],
      cues: [{ id: "c8", firstTokenId: "t1", lastTokenId: "t7" }],
    };
    const saved = await cdp.invoke("caption_doc_save", { projectId: pid, relPath: SRC, doc, baseRev: prior?.doc.rev ?? 0 });
    // 다른 창(메인)의 저장 → caption://changed → doc 창이 다시 읽는다(64 ⑥과 같은 경로).
    const rows = await poll(
      `(()=>{ if (!document.querySelector('[data-gpv="transcript-panel"]')) document.querySelector('[data-gpv="transcript-toggle"]')?.click();
        const e=window.__gpv.captionDoc.getState().entries[${J(key)}]; return e && e.doc ? e.doc.rev + ':' + document.querySelectorAll('[data-gpv="transcript-panel"] [data-cue]').length : null; })()`,
      (v) => v === `${saved.rev}:1`,
      40,
    );
    await d.eval(`(()=>{ [...document.querySelectorAll('[data-gpv="transcript-panel"] button')].find((b)=>(b.title||'').startsWith('다시 인식 —'))?.click(); return true; })()`);
    const reTrack = await poll(`document.querySelector('[data-gpv="stt-audio-track"]')?.value ?? null`, (v) => v !== null, 20);
    r.check("③ 문서(audioStream 1) → [다시 인식] 폼의 트랙 기본값 = 트랙 2", rows === `${saved.rev}:1` && reTrack === "1", `rows=${rows} value=${reTrack}`);

    // 트랙 목록을 아직 모른다(probe 읽는 중·실패 — doc 창 쿼리 캐시로 흉내) → 드롭다운은 숨고, 요청은 첫 트랙이 아니라 문서의
    // 트랙이다. 다시 인식은 확인 대화상자를 거친다(ui.confirm). ②와 같은 가짜 stt-status·transcribe 가로채기, 한 eval 안에서.
    const cfg3 = await cdp.invoke("get_settings");
    const unknown = await d.eval(`(async()=>{
      const qc=window.__gpv.docQueryClient, S=window.__gpv.captionDoc, U=window.__gpv.ui;
      const frames=()=>new Promise((res)=>requestAnimationFrame(()=>requestAnimationFrame(res)));
      const pk=['video-probe', ${J(pid)}, ${J(SRC)}], probe0=qc.getQueryData(pk);
      if (!probe0) return { err: 'no probe cache' };
      const orig=S.getState().transcribe, calls=[];
      qc.setQueryData(['stt-status'], { runtime: { state: 'found', path: 'e2e-whisper-cli', source: 'managed' }, runtimeSize: 0,
        models: [{ id: ${J(cfg3.sttModel)}, label: 'e2e', size: 1, note: '', installed: true }], vadInstalled: true });
      qc.setQueryData(pk, { ...probe0, audioStreams: undefined });
      S.setState({ transcribe: async (...a)=>{ calls.push(a); } });
      try {
        await frames();
        const dropdown=!!document.querySelector('[data-gpv="stt-audio-track"]');
        const b=document.querySelector('[data-gpv="stt-start"]');
        const disabled=!b || b.disabled;
        if (!disabled) b.click();
        await frames();
        const c=U.getState().confirm;
        if (c) { U.getState().closeConfirm(); c.onConfirm(); }
        await frames();
        return { dropdown, disabled, confirm: !!c, calls: calls.map(([, , o])=>o.audioStream) };
      } finally {
        S.setState({ transcribe: orig });
        qc.setQueryData(pk, probe0);
        void qc.invalidateQueries({ queryKey: ['stt-status'] });
      }
    })()`);
    r.check(
      "③ 트랙 목록을 모를 때 [다시 인식] → 드롭다운 없음 · 요청 audioStream = 문서의 트랙 1(첫 트랙으로 바꾸지 않음)",
      unknown?.dropdown === false && unknown.disabled === false && unknown.confirm === true && J(unknown.calls) === J([1]),
      J(unknown),
    );
    // 확인하면 폼이 닫힌다 — 실패로 열려 있으면 닫는다.
    await d.eval(`(()=>{ if (document.querySelector('[data-gpv="stt-start"]')) [...document.querySelectorAll('[data-gpv="transcript-panel"] button')].find((b)=>(b.title||'').startsWith('다시 인식 —'))?.click(); return true; })()`);

    // ── ④ ExportPanel 자막 트랙 — 문서의 트랙 하나만 들어간다 ──
    await d.eval(`(()=>{ const t=[...document.querySelectorAll('[aria-label="플레이어 모드"] [role="tab"]')].find(b=>/편집/.test(b.textContent||'')); if (t && !t.disabled) t.click(); return true; })()`);
    const subsSel = await poll(`!!document.querySelector('[data-gpv="caption-subs"]')`, (v) => v === true, 60);
    if (!r.check("④ 편집 인스펙터에 '자막 넣기' 섹션", subsSel === true)) return;
    const softSet = await setSelect('[data-gpv="caption-subs"]', "soft");
    const noteWant = `소리는 자막을 만든 트랙 하나만 들어갑니다 — ${want[1]?.[1]}`;
    const note = await poll(
      `(()=>({ note: (document.querySelector('.gpv-export-panel')?.textContent || '').includes(${J(noteWant)}),
        name: document.querySelector('.gpv-export-panel input[type=text]')?.value ?? '' }))()`,
      (v) => v.note === true && v.name === OUT_SUB,
      20,
    );
    r.check(
      `④ 자막 트랙 → 안내 '${noteWant}' · 기본 이름 ${OUT_SUB}`,
      softSet === "ok" && note.note === true && note.name === OUT_SUB,
      J({ softSet, ...note }),
    );
    await d.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    const clicked = await d.eval(
      `(()=>{ const b=[...document.querySelectorAll('.gpv-export-panel button')].find(x=>x.textContent.trim()==='내보내기' && !x.dataset.tab);
         if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`,
    );
    const toast = await poll(`window.__gpv.ui.getState().toasts.map(t=>t.kind+':'+t.message).join(' | ')`, (t) => /내보내기 완료|error:/.test(t), 120, 500);
    const outAbs = join(fix.repo, OUT_SUB);
    const outStreams = existsSync(outAbs) ? streamsOf(outAbs) : "파일 없음";
    r.check(
      "④ 내보낸 mp4 = 영상 + 소리 한 트랙(둘째 = kor, 첫 트랙 eng는 빠짐) + mov_text 자막",
      clicked === "ok" && /success:내보내기 완료/.test(toast) && outStreams === "video:h264,audio:aac:kor,subtitle:mov_text",
      `click=${clicked} toast="${toast}" streams=${outStreams}`,
    );
    const wantSoft = (await cdp.eval(`window.__gpv.caption.captionSourceCues(${J(doc)}, true).map((c)=>c.text)`)).map(softEscape);
    const gotSoft = existsSync(outAbs) ? softTexts(outAbs) : [];
    r.check(
      "④ 자막 트랙 글이 ffmpeg SRT 마크업으로 먹히지 않는다 — `\\ { } <`만 전각, 나머지 그대로(`C:\\new`·`{\\an8}<i>x</i>`·`a<b and c>d`)",
      wantSoft.length === 1 && /＼new/.test(wantSoft[0]) && J(gotSoft) === J(wantSoft),
      `want=${J(wantSoft)} got=${J(gotSoft)}`,
    );

    // ── ④b 자막을 만든 트랙이 파일에 없는 stale 문서(원본 교체 흉내: 문서의 크기를 1바이트 틀리게 + 트랙 6번) ──
    // `-map 0:a:5?`의 `?`가 없는 트랙을 말없이 건너뛰어 소리 없는 영상이 "성공"했다. 다른 창(메인)의 저장 → doc 창이 다시 읽는다.
    const cur4 = await cdp.invoke("caption_doc_load", { projectId: pid, relPath: SRC });
    await cdp.invoke("caption_doc_save", {
      projectId: pid, relPath: SRC, baseRev: cur4.doc.rev,
      doc: { ...cur4.doc, source: { ...cur4.doc.source, sizeBytes: cur4.doc.source.sizeBytes + 1, audioStream: 5 } },
    });
    const missWarn = await poll(`document.querySelector('[data-gpv="caption-audio-missing"]')?.textContent ?? null`, (v) => !!v, 40);
    const staleBack = await cdp.try(
      "video_export",
      {
        projectId: pid, jobId: crypto.randomUUID(),
        spec: {
          srcRel: SRC, outRel: OUT_STALE, overwrite: true, range: null, mode: "copy", speed: null, crop: null, masks: null,
          maskKind: "mosaic", crf: null, maxHeight: null, removeAudio: false, durationMs: D, hasAudio: true,
          captionSubs: { mode: "soft", timeline: "source", text: "caption", lang: null, preset: "basic" },
        },
      },
      { timeoutMs: 60000 },
    );
    r.check(
      "④b 자막을 만든 트랙(6번)이 없는 stale 문서 → ExportPanel 경고 · 백엔드 거절(소리 없는 영상을 쓰지 않음)",
      /트랙 6번이 이 파일에 없어/.test(missWarn ?? "") && !staleBack.ok && /트랙 6번이 이 파일에 없습니다/.test(staleBack.message || "") &&
        !existsSync(join(fix.repo, OUT_STALE)),
      J({ missWarn, back: `${staleBack.code} ${staleBack.message ?? ""}`, out: existsSync(join(fix.repo, OUT_STALE)) }),
    );

    // ── ⑤ libass 없는 ffmpeg — 도구 상태만 흉내(doc 창 쿼리 캐시). 번인을 먼저 골라 두면 사라진 뒤 경고로 바뀐다 ──
    const libass = !!tool.r.hasSubtitlesFilter;
    const burnPicked = libass ? await setSelect('[data-gpv="caption-subs"]', "burn") : "no-libass";
    const burnName = libass ? await poll(`document.querySelector('.gpv-export-panel input[type=text]')?.value ?? ''`, (v) => v === OUT_SUB, 20) : null;
    await d.eval(`(()=>{ window.__gpv.docQueryClient.setQueryData(['video-tool'], (t)=>({ ...t, hasSubtitlesFilter: false })); return true; })()`);
    try {
      const gone = await poll(
        `(()=>{ const p=document.querySelector('.gpv-export-panel'); const t=p?.textContent || '';
          return { burnDisabled: document.querySelector('[data-gpv="caption-subs"] option[value=burn]')?.disabled ?? null,
            warn: t.includes('이 ffmpeg엔 libass가 없어 영상에 입힐 수 없습니다 — 자막 트랙으로 넣으세요'),
            name: p?.querySelector('input[type=text]')?.value ?? '' }; })()`,
        (v) => v.burnDisabled === true && (!libass || (v.warn && !/\.sub\./.test(v.name))),
        20,
      );
      if (libass) {
        r.check(
          "⑤ 번인을 고른 뒤 libass가 사라지면 → 경고 · 선택지 비활성 · 기본 이름에서 .sub 빠짐(자막을 스펙에 넣지 않음)",
          burnPicked === "ok" && burnName === OUT_SUB && gone.burnDisabled === true && gone.warn === true && !/\.sub\./.test(gone.name),
          J({ burnPicked, burnName, ...gone }),
        );
      } else {
        r.skip("⑤ 번인을 고른 뒤 libass가 사라지면 경고", "이 머신의 ffmpeg엔 libass가 없어 번인을 먼저 고를 수 없다");
      }
      await setSelect('[data-gpv="caption-subs"]', "none");
      const notice = await poll(
        `(document.querySelector('.gpv-export-panel')?.textContent || '').includes('이 ffmpeg엔 libass가 없어 영상에 입힐 수 없습니다 — 자막 트랙으로 넣습니다.')`,
        (v) => v === true,
        20,
      );
      r.check("⑤ libass 없는 ffmpeg → 번인 선택지 비활성 + '자막 트랙으로 넣습니다' 안내", gone.burnDisabled === true && notice === true, J({ ...gone, notice }));
    } finally {
      await d.eval(`(()=>{ void window.__gpv.docQueryClient.invalidateQueries({ queryKey: ['video-tool'] }); return true; })()`).catch(() => {});
    }
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
    for (const rel of [SRC, OUT_SUB, OUT_STALE]) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 없으면 무해 — 픽스처 정리가 통째로 지운다 */
      }
    }
    await sleep(300);
  }
}
