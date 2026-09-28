// 오디오 플레이어(폴더 플레이리스트) — 트리에서 오디오를 열면 왼쪽에 **같은 폴더의 오디오**가 나오고, 목록·다음 버튼·N 키·
// 곡 끝으로 곡이 바뀐다. 픽스처는 ffmpeg lavfi 사인파(작은 볼륨) 셋 + 오디오가 아닌 파일 하나:
//   01 alpha.mp3 — ID3 태그(제목·아티스트·앨범·연도·장르) + 64×64 PNG 커버(attached_pic)
//   02 beta.mp3  — 태그·커버 없음(파일 이름이 제목, 플레이스홀더)
//   03 gamma.ogg — Vorbis 주석(스트림 tags — format.tags에 없다)
//   notes.txt    — 목록에 들어오면 안 된다(필터가 고장 나면 4개가 된다)
//
// 지키는 계약:
//   ① 다음 곡 계산(순수, __gpv.playlist): 감아 돌기 · 끝에서 정지/처음으로 · 한 곡 반복 · 셔플은 현재 곡이 아닌 곡.
//   ② 백엔드: probe 태그(format·스트림 태그)·크기·샘플레이트 · 커버 있음 = jpeg data URI · 커버 없음 = null(에러 아님) ·
//      reveal_in_repo는 레포 밖·없는 파일을 거절한다(정상 경로는 탐색기 창이 뜨므로 여기서 부르지 않는다).
//   ③ UI: 트리 클릭 → 목록 = 폴더의 오디오 3개(순서 그대로) · 현재 곡 강조 · 자동재생 · 다른 곡 클릭 → 그 곡이 재생되고
//      **소리 나는 요소는 하나** · 태그 제목 · 커버 이미지 · 다음 버튼/N 키 · 전체 반복에서 마지막 곡이 끝나면 첫 곡.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "오디오 플레이어 (폴더 플레이리스트 · 곡 전환 · 태그 · 커버)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const DIR = "e2e-music";
const A = `${DIR}/01 alpha.mp3`;
const B = `${DIR}/02 beta.mp3`;
const C = `${DIR}/03 gamma.ogg`;
const TITLE_A = "E2E Alpha Title";
const TITLE_C = "E2E Gamma Vorbis";

/** 사인파 오디오 — 듣는 사람 귀를 위해 볼륨 3%. 파형 피크는 정규화되므로 모양은 그대로다. */
function makeTone(out, freq, secs, extra) {
  execFileSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${secs}`, ...extra, out],
    { encoding: "utf8" },
  );
}

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals && window.__gpv.queryClient && window.__gpv.playlist)`,
  );
  if (!hooks) {
    r.skip("오디오 플레이어 전체", "window.__gpv(playlist) 미노출(dev 빌드 아님)");
    return;
  }

  // ── ① 다음 곡 계산(순수) — 앱·픽스처 없이 결정적 ──
  const pl = await cdp.eval(`(()=>{
    const P = window.__gpv.playlist, r0 = () => 0, r9 = () => 0.999;
    return {
      step: [P.stepIndex(3,0,1,false), P.stepIndex(3,2,1,false), P.stepIndex(3,0,-1,false), P.stepIndex(0,0,1,false),
             P.stepIndex(3,-1,1,false), P.stepIndex(3,-1,-1,false)],
      ended: [P.endedIndex(3,0,'off',false), P.endedIndex(3,2,'off',false), P.endedIndex(3,2,'all',false),
              P.endedIndex(3,1,'one',false), P.endedIndex(3,1,'one',true), P.endedIndex(0,0,'all',false)],
      shuffle: [P.stepIndex(3,0,1,true,r0), P.stepIndex(3,0,1,true,r9), P.stepIndex(3,2,1,true,r9), P.stepIndex(1,0,1,true,r0),
                P.endedIndex(3,1,'off',true,r0), P.endedIndex(1,0,'off',true,r0), P.endedIndex(1,0,'all',true,r0)],
      neverCur: Array.from({ length: 400 }, () => P.stepIndex(4,2,1,true)).every((i) => i !== 2 && i >= 0 && i < 4),
      covers: new Set(Array.from({ length: 400 }, () => P.endedIndex(4,2,'all',true))).size,
    };
  })()`);
  r.check(
    "① 수동 다음/이전 — 끝에서 감아 돈다(2→0, 0→2) · 빈 목록 null · 목록 밖이면 처음/끝",
    J(pl.step) === J([1, 0, 2, null, 0, 2]),
    J(pl.step),
  );
  r.check(
    "① 곡 끝 — 끔: 다음·마지막이면 정지 · 전체: 처음으로 · 한 곡: 같은 곡(셔플이어도)",
    J(pl.ended) === J([1, null, 0, 1, 1, null]),
    J(pl.ended),
  );
  r.check(
    "① 셔플 — 현재 곡을 건너뛴 무작위(난수 0 → 1, 0.999 → 2 / 현재 2면 1) · 곡 하나면 그 곡 · 반복 끔 곡 하나면 정지",
    J(pl.shuffle) === J([1, 2, 1, 0, 0, null, 0]),
    J(pl.shuffle),
  );
  r.check(
    "① 셔플 400회 — 현재 곡이 한 번도 안 나오고 나머지 3곡이 다 나온다",
    pl.neverCur === true && pl.covers === 3,
    `neverCur=${pl.neverCur} 나온 곡 수=${pl.covers}`,
  );

  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found || !tool.r?.probeFound) {
    r.skip("오디오 플레이어 ②③", "앱이 ffmpeg/ffprobe를 못 찾음");
    return;
  }
  const dirAbs = join(fix.repo, DIR);
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  } catch {
    r.skip("오디오 플레이어 ②③", "PATH에 ffmpeg 없음(픽스처 생성 불가)");
    return;
  }

  const pid = fix.projectId;
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
  /** 플레이어 상태 한 묶음 — 뷰어 대상 · 목록 · 강조 · 문서 안 모든 <audio>(어느 곡 · 멈췄나) · 제목 · 커버. */
  const view = () =>
    cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      const box = document.querySelector('[data-gpv="audio-player"]');
      const file = (a) => { try { return decodeURIComponent(new URL(a.src).pathname).split('/').pop(); } catch { return a.src; } };
      const img = document.querySelector('[data-gpv="audio-cover"] img');
      return {
        path: s.selectedDiff ? s.selectedDiff.path : null,
        tabs: s.viewerTabs.filter((t) => t.outerId === ${J(pid)}).map((t) => t.target.path ?? null),
        player: !!box,
        rows: [...document.querySelectorAll('[data-gpv="audio-track"]')].map((e) => e.dataset.path),
        current: [...document.querySelectorAll('[data-gpv="audio-track"][aria-current="true"]')].map((e) => e.dataset.path),
        audios: [...document.querySelectorAll('audio')].map((a) => ({ file: file(a), paused: a.paused, ready: a.readyState })),
        title: document.querySelector('[data-gpv="audio-title"]')?.textContent ?? null,
        cover: img ? { jpeg: img.src.startsWith('data:image/jpeg;base64,'), w: img.naturalWidth, h: img.naturalHeight } : null,
        repeat: document.querySelector('[data-gpv="audio-repeat"]')?.dataset.mode ?? null,
        shuffle: document.querySelector('[data-gpv="audio-shuffle"]')?.getAttribute('aria-pressed') ?? null,
      };
    })()`);
  const base = (rel) => rel.split("/").pop();
  /** rel 이 열려 **소리 나는 유일한 요소**인가 — 다른 요소가 하나라도 재생 중이면 거짓(소리 겹침). */
  const playingOnly = (v, rel) =>
    !!v && v.path === rel && v.audios.filter((a) => !a.paused).length === 1 && v.audios.some((a) => a.file === base(rel) && !a.paused);
  /** 실제 사용자 조작과 같은 순서로 쏜다 — pointerdown이 자동재생 관문(lib/engagement.ts)을 연다. */
  const clickEl = (sel) =>
    cdp.eval(`(()=>{
      const el = document.querySelector(${J(sel)});
      if (!el) return 'none';
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
  const pressKey = (key) =>
    cdp.eval(`(()=>{
      const box = document.querySelector('[data-gpv="audio-player"]');
      if (!box) return 'none';
      box.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true, cancelable: true }));
      return 'ok';
    })()`);

  try {
    // ── 픽스처 ──
    mkdirSync(dirAbs, { recursive: true });
    const cover = join(dirAbs, ".cover.png");
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", cover]);
    makeTone(join(fix.repo, A), 440, 6, [
      "-i", cover, "-map", "0:a", "-map", "1:v", "-af", "volume=0.03", "-c:a", "libmp3lame", "-q:a", "5",
      "-c:v", "png", "-disposition:v:0", "attached_pic", "-id3v2_version", "3",
      "-metadata", `title=${TITLE_A}`, "-metadata", "artist=E2E Artist", "-metadata", "album=E2E Album",
      "-metadata", "date=2024-05-01", "-metadata", "genre=Synthwave",
    ]);
    rmSync(cover, { force: true });
    makeTone(join(fix.repo, B), 550, 6, ["-af", "volume=0.03", "-c:a", "libmp3lame", "-q:a", "5"]);
    makeTone(join(fix.repo, C), 660, 4, ["-af", "volume=0.03", "-c:a", "libvorbis", "-metadata", `title=${TITLE_C}`]);
    writeFileSync(join(dirAbs, "notes.txt"), "not audio\n");

    // ── ② 백엔드 계약 ──
    const pa = await cdp.invoke("video_probe", { projectId: pid, relPath: A }, { timeoutMs: 20000 });
    r.check(
      "② probe(mp3) — format.tags 제목·아티스트·앨범·날짜·장르 · 크기 = 디스크 · 44.1kHz · 커버 = video 스트림",
      pa.tags?.title === TITLE_A && pa.tags?.artist === "E2E Artist" && pa.tags?.album === "E2E Album" &&
        pa.tags?.date === "2024-05-01" && pa.tags?.genre === "Synthwave" &&
        pa.sizeBytes === statSync(join(fix.repo, A)).size && pa.audioStreams?.[0]?.sampleRate === 44100 && pa.hasVideo === true,
      J({ tags: pa.tags, sizeBytes: pa.sizeBytes, sr: pa.audioStreams?.[0]?.sampleRate, hasVideo: pa.hasVideo }),
    );
    const pc = await cdp.invoke("video_probe", { projectId: pid, relPath: C }, { timeoutMs: 20000 });
    r.check(
      "② probe(ogg) — Vorbis 주석은 스트림 tags에서 읽는다 · 커버 없음",
      pc.tags?.title === TITLE_C && pc.hasVideo === false,
      J({ tags: pc.tags, hasVideo: pc.hasVideo }),
    );
    const ca = await cdp.try("audio_cover_art", { projectId: pid, relPath: A }, { timeoutMs: 30000 });
    r.check(
      "② audio_cover_art(커버 있음) → data:image/jpeg;base64",
      ca.ok && typeof ca.r === "string" && ca.r.startsWith("data:image/jpeg;base64,") && ca.r.length > 100,
      ca.ok ? String(ca.r).slice(0, 40) : `${ca.code} ${ca.message}`,
    );
    const cb = await cdp.try("audio_cover_art", { projectId: pid, relPath: B }, { timeoutMs: 30000 });
    r.check("② audio_cover_art(커버 없음) → null — 에러가 아니다", cb.ok && cb.r === null, cb.ok ? J(cb.r) : `${cb.code} ${cb.message}`);
    const rvOut = await cdp.try("reveal_in_repo", { projectId: pid, relPath: "../outside.mp3" });
    r.check(
      "② reveal_in_repo — 레포 밖 경로(..) 거절",
      !rvOut.ok && !String(rvOut.code).startsWith("E2E_"),
      `${rvOut.ok ? "열림" : rvOut.code} ${rvOut.message ?? ""}`,
    );
    const rvMiss = await cdp.try("reveal_in_repo", { projectId: pid, relPath: `${DIR}/missing.mp3` });
    r.check(
      "② reveal_in_repo — 없는 파일은 NOT_FOUND(메시지에 경로)",
      !rvMiss.ok && rvMiss.code === "NOT_FOUND" && String(rvMiss.message).includes("missing.mp3"),
      `${rvMiss.ok ? "열림" : rvMiss.code} ${rvMiss.message ?? ""}`,
    );

    // ── ③ UI — 트리에서 02 beta.mp3 열기 ──
    // 픽스처는 원시 invoke로 추가돼 UI 캐시에 없다 — projects 갱신 후에야 선택이 박힌다(46과 같은 가드).
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await sleep(500);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(pid)})`);
    const stuck = await poll(() => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`), (v) => v === pid, 12, 250);
    if (stuck !== pid) {
      r.skip("오디오 플레이어 ③", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, "viewer")`);
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", pid])} })`);
    await sleep(400);
    const rowSel = `[data-tree-file=${J(B)}]`;
    if ((await cdp.eval(`!!document.querySelector(${J(rowSel)})`)) !== true) {
      await clickEl(`[data-tree-path=${J(DIR)}][data-tree-isdir="1"]`);
      await poll(() => cdp.eval(`!!document.querySelector(${J(rowSel)})`), (v) => v === true, 20, 250);
    }
    const viaTree = (await clickEl(rowSel)) === "ok";
    if (!viaTree) {
      r.skip("트리 행 클릭으로 열기", "트리에 행이 없어 selectDiff로 대체(패널 접힘 등)");
      await cdp.eval(`window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(B)} })`);
    }
    const v0 = await poll(view, (v) => v?.player && v.rows.length === 3 && v.audios.some((a) => a.ready >= 1), 60, 250);
    if (!r.check("③ 오디오를 열면 오디오 플레이어가 뜨고 <audio>가 메타데이터를 읽는다", v0?.player === true && v0.audios.some((a) => a.ready >= 1), J(v0)))
      return;
    r.check(
      "③ 왼쪽 목록 = 같은 폴더의 오디오 3개(폴더 순서, notes.txt 제외)",
      J(v0.rows) === J([A, B, C]),
      J(v0.rows),
    );
    r.check("③ 현재 곡(02 beta)만 강조(aria-current)", J(v0.current) === J([B]), J(v0.current));
    r.check(
      "③ 태그 없는 곡 — 제목 = 파일 이름(확장자 제외) · 커버 자리는 플레이스홀더(<img> 없음)",
      v0.title === "02 beta" && v0.cover === null,
      `title=${v0.title} cover=${J(v0.cover)}`,
    );
    const v0p = await poll(view, (v) => playingOnly(v, B), 40, 250);
    r.check(`③ 트리에서 연 곡이 자동재생된다(${viaTree ? "트리 클릭" : "selectDiff"})`, playingOnly(v0p, B), J(v0p?.audios));

    // 순서 단언을 흔드는 저장된 취향(셔플·반복)을 끈다 — 샤드 앱의 localStorage는 회차를 넘어 남을 수 있다.
    for (let i = 0; i < 3 && (await view())?.repeat !== "off"; i++) await clickEl('[data-gpv="audio-repeat"]');
    if ((await view())?.shuffle === "true") await clickEl('[data-gpv="audio-shuffle"]');
    const norm = await view();
    r.check("③ 반복 끔 · 셔플 끔으로 맞춤", norm.repeat === "off" && norm.shuffle === "false", `repeat=${norm.repeat} shuffle=${norm.shuffle}`);

    // 목록의 다른 곡 클릭 → 그 곡 재생 · 이전 곡 정지
    await clickEl(`[data-gpv="audio-track"][data-path=${J(A)}]`);
    const v1 = await poll(view, (v) => playingOnly(v, A) && v.cover?.w === 64, 60, 250);
    r.check(
      "③ 목록에서 01 alpha 클릭 → 그 곡이 재생되고(paused=false) 소리 나는 <audio>는 그것 하나",
      playingOnly(v1, A),
      `path=${v1?.path} audios=${J(v1?.audios)}`,
    );
    r.check("③ 강조가 01 alpha로 옮겨간다", J(v1?.current) === J([A]), J(v1?.current));
    r.check("③ 태그 제목이 보인다(파일 이름 아님)", v1?.title === TITLE_A, `title=${v1?.title}`);
    r.check(
      "③ 내장 커버가 <img>로 보인다(64×64 jpeg data URI)",
      v1?.cover?.jpeg === true && v1.cover.w === 64 && v1.cover.h === 64,
      J(v1?.cover),
    );

    // 다음 버튼 → 02 beta
    await clickEl('[data-gpv="audio-next"]');
    const v2 = await poll(view, (v) => playingOnly(v, B), 60, 250);
    r.check("③ 다음 버튼 → 02 beta 재생(이전 곡 정지)", playingOnly(v2, B), `path=${v2?.path} audios=${J(v2?.audios)}`);

    // N 키 → 03 gamma
    await pressKey("n");
    const v3 = await poll(view, (v) => playingOnly(v, C), 60, 250);
    r.check("③ N 키 → 03 gamma 재생", playingOnly(v3, C), `path=${v3?.path} audios=${J(v3?.audios)}`);
    // 제목은 probe(ffprobe)가 돌아와야 태그로 바뀐다 — 그 전엔 파일 이름이다. 재생 시작과 따로 기다린다.
    const v3t = await poll(view, (v) => v?.title === TITLE_C, 40, 250);
    r.check("③ ogg 스트림 태그 제목이 보인다", v3t?.title === TITLE_C, `title=${v3t?.title}`);

    // 전체 반복 · 마지막 곡이 끝나면 첫 곡으로 이어 재생
    await clickEl('[data-gpv="audio-repeat"]');
    const rep = await poll(view, (v) => v?.repeat === "all", 12, 250);
    await cdp.eval(`(()=>{ const a = document.querySelector('audio'); if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, a.duration - 0.3); return true; })()`);
    const v4 = await poll(view, (v) => playingOnly(v, A), 60, 250);
    r.check(
      "③ 전체 반복 — 마지막 곡(03 gamma)이 끝나면 01 alpha로 넘어가 재생",
      rep?.repeat === "all" && playingOnly(v4, A),
      `repeat=${rep?.repeat} path=${v4?.path} audios=${J(v4?.audios)}`,
    );
    // 곡 전환(목록 클릭·다음 버튼·N 키·곡 끝)은 탭을 갈아 끼운다 — 탭을 추가하던 때는 여기서 3개였다.
    r.check(
      "③ 곡을 네 번 넘겨도 뷰어 탭 수 그대로 — 그 탭이 지금 곡(01 alpha)을 가리킨다",
      // 앞 스위트가 남긴 탭이 있어도 흔들리지 않게 개수·소속으로 본다.
      !!v4 && v0.tabs.includes(B) && v4.tabs.length === v0.tabs.length &&
        v4.tabs.includes(A) && !v4.tabs.includes(B) && !v4.tabs.includes(C),
      `처음=${J(v0.tabs)} 지금=${J(v4?.tabs)}`,
    );
  } finally {
    // 정리 — 이 스위트가 연 탭·선택·픽스처와 바꾼 취향(반복)을 되돌린다.
    await cdp.eval(`document.querySelectorAll('audio').forEach((a) => a.pause())`).catch(() => {});
    for (let i = 0; i < 3; i++) {
      const mode = await cdp.eval(`document.querySelector('[data-gpv="audio-repeat"]')?.dataset.mode ?? 'off'`).catch(() => "off");
      if (mode === "off") break;
      await clickEl('[data-gpv="audio-repeat"]').catch(() => {});
    }
    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
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
