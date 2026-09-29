// 조각 MP4(색인 없음) 감지 · 빠른 재생용 사본 · 배속 16x.
//
// 실파일(nqvm-vis camstation 녹화물, 11GB)은 `-movflags +frag_every_frame+empty_moov+default_base_moof`로 프레임마다
// moof+mdat가 붙고 sidx·mfra가 없다 — 웹뷰가 파일 전체를 훑어야 재생이 시작된다. 픽스처(ffmpeg lavfi testsrc 4초):
//   frag.mp4       — 같은 플래그 + skip_trailer. ffmpeg는 기본으로 꼬리에 mfra를 쓰므로 그걸 꺼야 실파일과 같아진다.
//   frag-mfra.mp4  — 같은 플래그(꼬리 mfra 있음 = 색인 있음) — 안내 대상이 아니다.
//   plain.mp4      — 일반 mp4(moov 하나).
//
// 지키는 계약:
//   ① video_container_info: frag = 조각·색인 없음 · frag-mfra = 조각·색인 있음 · plain = 조각 아님 · 레포 밖 경로 거절.
//   ② 길이를 모르는(durationMs 0) copy 내보내기도 진행률이 0에 머물지 않는다(쓴 바이트 ÷ 원본 바이트).
//   ③ UI: plain엔 안내 띠가 없고(판정이 끝난 뒤에) frag엔 띠와 버튼 · 버튼 → `frag (빠른 재생).mp4`가 생기고 조각이 아니다 ·
//      뷰어가 사본으로 바뀐다 · 사본이 이미 있으면 다시 만들지 않고 그걸 연다.
//   ④ 배속: = 키로 16x까지 오르고(<video>.playbackRate) 더 눌러도 16 · - 한 번이면 8.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const name = "조각 MP4 감지 · 빠른 재생용 사본 · 배속 16x";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const DIR = "e2e-fragmented";
const FRAG = `${DIR}/frag.mp4`;
const FRAG_MFRA = `${DIR}/frag-mfra.mp4`;
const PLAIN = `${DIR}/plain.mp4`;
const COPY = `${DIR}/frag (빠른 재생).mp4`;
const BYTES = `${DIR}/bytes-copy.mp4`;
const EVENT_API = "/node_modules/@tauri-apps/api/event.js";
const FRAG_FLAGS = "+frag_every_frame+empty_moov+default_base_moof";

function makeVideo(out, movflags) {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(movflags ? ["-movflags", movflags] : []),
      out,
    ],
    { encoding: "utf8" },
  );
}

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(`!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals && window.__gpv.queryClient)`);
  if (!hooks) {
    r.skip("조각 MP4 전체", "window.__gpv 미노출(dev 빌드 아님)");
    return;
  }
  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found) {
    r.skip("조각 MP4 전체", "앱이 ffmpeg를 못 찾음");
    return;
  }
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  } catch {
    r.skip("조각 MP4 전체", "PATH에 ffmpeg 없음(픽스처 생성 불가)");
    return;
  }

  const pid = fix.projectId;
  const dirAbs = join(fix.repo, DIR);
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch((e) => `ERR ${e.message}`);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const info = (rel) => cdp.try("video_container_info", { projectId: pid, relPath: rel });
  /** 보이는 플레이어 한 묶음 — 숨은 뷰어 탭(display:none)도 마운트돼 있어 보이는 것만 센다. */
  const view = (rel) =>
    cdp.eval(`(()=>{
      const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0);
      const s = window.__gpv.ui.getState();
      const v = vis('video')[0];
      const btn = vis('[data-gpv="fast-start-make"]')[0];
      const file = (a) => { try { return decodeURIComponent(new URL(a.src).pathname).split('/').pop(); } catch { return a.src; } };
      return {
        path: s.selectedDiff ? s.selectedDiff.path : null,
        video: v ? { file: file(v), rate: v.playbackRate, ready: v.readyState } : null,
        notice: vis('[data-gpv="fast-start-notice"]').length,
        button: btn ? { disabled: btn.disabled } : null,
        judged: ${rel ? `window.__gpv.queryClient.getQueryData(${J(["video-container", pid, rel])}) ?? null` : "null"},
      };
    })()`);
  const clickVisible = (sel) =>
    cdp.eval(`(()=>{
      const el = [...document.querySelectorAll(${J(sel)})].find((e) => e.offsetWidth > 0);
      if (!el) return 'none';
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
  const open = (rel) => cdp.eval(`window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(rel)} })`);

  try {
    // ── 픽스처 ──
    mkdirSync(dirAbs, { recursive: true });
    makeVideo(join(fix.repo, FRAG), `${FRAG_FLAGS}+skip_trailer`);
    makeVideo(join(fix.repo, FRAG_MFRA), FRAG_FLAGS);
    makeVideo(join(fix.repo, PLAIN), null);

    // ── ① 판정 ──
    const fi = await info(FRAG);
    r.check(
      "① frag(프레임마다 조각 · sidx·mfra 없음) → fragmented · !indexed",
      fi.ok && fi.r?.fragmented === true && fi.r?.indexed === false,
      fi.ok ? J(fi.r) : `${fi.code} ${fi.message}`,
    );
    const fm = await info(FRAG_MFRA);
    r.check(
      "① frag-mfra(ffmpeg 기본 — 꼬리 mfra) → fragmented · indexed",
      fm.ok && fm.r?.fragmented === true && fm.r?.indexed === true,
      fm.ok ? J(fm.r) : `${fm.code} ${fm.message}`,
    );
    const pi = await info(PLAIN);
    r.check(
      "① plain(일반 mp4) → !fragmented",
      pi.ok && pi.r?.fragmented === false,
      pi.ok ? J(pi.r) : `${pi.code} ${pi.message}`,
    );
    const outside = await info("../outside.mp4");
    r.check(
      "① 레포 밖 경로(..)는 거절",
      !outside.ok && !String(outside.code).startsWith("E2E_"),
      `${outside.ok ? J(outside.r) : outside.code} ${outside.message ?? ""}`,
    );

    // ── ② 길이 모르는 copy 내보내기의 진행률 ──
    await cdp.eval(`(async()=>{ const m=await import(${J(EVENT_API)});
      window.__gpvFragProg=[]; if (window.__gpvFragUnlisten) window.__gpvFragUnlisten();
      window.__gpvFragUnlisten = await m.listen('video://export-progress', (e)=>window.__gpvFragProg.push(e.payload)); return true; })()`);
    const jobId = `e2e-frag-bytes-${Date.now()}`;
    const bytesSpec = {
      srcRel: FRAG, outRel: BYTES, overwrite: false, range: null, mode: "copy", speed: null, crop: null,
      masks: null, maskKind: "mosaic", crf: null, maxHeight: null, removeAudio: false, durationMs: 0, hasAudio: false,
    };
    const ex = await cdp.try("video_export", { projectId: pid, jobId, spec: bytesSpec }, { timeoutMs: 60000 });
    const pcts = await poll(
      () => cdp.eval(`(window.__gpvFragProg||[]).filter((p)=>p.jobId===${J(jobId)}).map((p)=>p.percent)`),
      (v) => Array.isArray(v) && v.some((p) => p > 0),
      12,
      250,
    );
    r.check(
      "② durationMs 0 인 전체 copy — 진행률이 0에 머물지 않는다(쓴 바이트 ÷ 원본 바이트)",
      ex.ok && Array.isArray(pcts) && pcts.some((p) => p > 0) && pcts.every((p) => p >= 0 && p <= 100),
      `export=${ex.ok ? "ok" : `${ex.code} ${ex.message}`} percents=${J(pcts)}`,
    );
    const bi = await info(BYTES);
    r.check("② 스트림 카피 결과는 조각 MP4가 아니다", bi.ok && bi.r?.fragmented === false, bi.ok ? J(bi.r) : `${bi.code} ${bi.message}`);

    // ── ③ UI ──
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await sleep(500);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(pid)})`);
    const stuck = await poll(() => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`), (v) => v === pid, 12, 250);
    if (stuck !== pid) {
      r.skip("조각 MP4 ③④", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, "viewer")`);

    await open(PLAIN);
    const vp = await poll(() => view(PLAIN), (v) => v?.path === PLAIN && v.video?.file === "plain.mp4" && v.judged !== null, 60, 250);
    r.check(
      "③ plain — 판정이 끝난 뒤에도 안내 띠가 없다",
      vp?.video?.file === "plain.mp4" && vp.judged?.fragmented === false && vp.notice === 0 && vp.button === null,
      J(vp),
    );

    await open(FRAG);
    const vf = await poll(
      () => view(FRAG),
      (v) => v?.path === FRAG && v.video?.file === "frag.mp4" && v.notice === 1 && v.button?.disabled === false,
      60,
      250,
    );
    r.check(
      "③ frag — 안내 띠와 [빠른 재생용 사본 만들기] 버튼(활성)",
      vf?.video?.file === "frag.mp4" && vf.notice === 1 && vf.button?.disabled === false,
      J(vf),
    );

    await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    const clicked = await clickVisible('[data-gpv="fast-start-make"]');
    const copyAbs = join(fix.repo, COPY);
    const vc = await poll(() => view(COPY), (v) => existsSync(copyAbs) && v?.path === COPY && v.video?.file === "frag (빠른 재생).mp4", 120, 250);
    r.check(
      "③ 버튼 → `frag (빠른 재생).mp4` 가 생기고 뷰어가 그 사본으로 바뀐다",
      clicked === "ok" && existsSync(copyAbs) && vc?.path === COPY && vc.video?.file === "frag (빠른 재생).mp4",
      `click=${clicked} exists=${existsSync(copyAbs)} ${J(vc)}`,
    );
    const ci = await info(COPY);
    r.check("③ 사본은 조각 MP4가 아니다", ci.ok && ci.r?.fragmented === false, ci.ok ? J(ci.r) : `${ci.code} ${ci.message}`);
    const vc2 = await poll(() => view(COPY), (v) => v?.judged !== null, 20, 250);
    r.check("③ 사본 화면엔 안내 띠가 없다", vc2?.judged?.fragmented === false && vc2.notice === 0, J(vc2));

    // 같은 이름 사본이 이미 있다 — 다시 만들지 않고(mtime 그대로) 그걸 연다.
    const mtime0 = existsSync(copyAbs) ? statSync(copyAbs).mtimeMs : null;
    await open(FRAG);
    await poll(() => view(FRAG), (v) => v?.path === FRAG && v.button?.disabled === false, 40, 250);
    await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`);
    await clickVisible('[data-gpv="fast-start-make"]');
    const again = await poll(
      async () => ({
        v: await view(COPY),
        toasts: await cdp.eval(`window.__gpv.ui.getState().toasts.map((t) => t.kind + ':' + t.message)`),
      }),
      (x) => x.v?.path === COPY && x.toasts.some((t) => t.startsWith("info:") && t.includes("이미 있어")),
      40,
      250,
    );
    r.check(
      "③ 사본이 이미 있으면 안내 토스트 + 그 사본을 연다(다시 만들지 않는다)",
      again.v?.path === COPY && again.toasts.some((t) => t.startsWith("info:") && t.includes("이미 있어")) &&
        mtime0 !== null && statSync(copyAbs).mtimeMs === mtime0,
      `path=${again.v?.path} toasts=${J(again.toasts)} mtime=${mtime0}→${existsSync(copyAbs) ? statSync(copyAbs).mtimeMs : "없음"}`,
    );

    // ── ④ 배속 — 키 핸들러는 포커스된 컨테이너(tabIndex)에 걸려 있다. 키마다 렌더를 기다린다(같은 틱이면 같은 rate를 읽는다). ──
    const rates = await cdp.eval(`(async()=>{
      const v = [...document.querySelectorAll('video')].find((e) => e.offsetWidth > 0);
      const box = v && v.closest('[tabindex="0"]');
      if (!box) return null;
      const key = async (k) => { box.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 80)); };
      const start = v.playbackRate;
      for (let i = 0; i < 12; i++) await key('=');
      const top = v.playbackRate;
      await key('='); await key('=');
      const over = v.playbackRate;
      const label = [...box.querySelectorAll('button')].some((b) => b.textContent.trim() === '16x');
      await key('-');
      const down = v.playbackRate;
      return { start, top, over, label, down };
    })()`);
    r.check(
      "④ = 키로 16x까지 오르고(playbackRate 16 · 표시 16x) 더 눌러도 16 · - 한 번이면 8",
      rates?.top === 16 && rates.over === 16 && rates.label === true && rates.down === 8,
      J(rates),
    );
  } finally {
    await cdp.eval(`(()=>{ if (window.__gpvFragUnlisten) window.__gpvFragUnlisten(); window.__gpvFragUnlisten=null; return true; })()`).catch(() => {});
    await cdp.eval(`document.querySelectorAll('video').forEach((v) => v.pause())`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`).catch(() => {});
    try {
      rmSync(dirAbs, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* 픽스처 정리가 레포째 지운다 — 실패해도 무해 */
    }
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", pid])} })`).catch(() => {});
    if (origSel) await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
    await sleep(300);
  }
}
