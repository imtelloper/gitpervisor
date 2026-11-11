// 화면 영역 캡쳐 (DOCS/screen-capture-design.md M1) — 커맨드 계약 + 세션 수명.
//
// **이 스위트가 지키는 것은 속도가 아니라 누수와 좌표다.** 지연은 로그(`[capture] … 캡쳐 Nms`)로
// 보고, 여기서는 자동으로 재현 가능한 두 가지만 단언한다.
//
//  - 확정·취소 뒤 프리즈 버퍼가 **반드시 풀린다**. 모니터 1대에 14~33MB라 새는 줄 모르고 상주한다
//    (설계 R7 — 이 저장소는 "정리 경로가 하나뿐이면 언젠가 샌다"를 비싸게 배웠다).
//  - 요청한 사각형이 **그 크기 그대로** 잘린다. 화면 배율(DPI)이 크롭 경로에 새어들면 여기서 깨진다.
//
// 오버레이는 전체화면으로 떠서 포커스를 가져간다 → 다른 스위트를 방해하지 않게 마지막에 둔다.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const name = "화면 캡쳐 (capture_* 커맨드 · 세션 수명)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r }) {
  // Windows 전용 기능 — 다른 플랫폼에서는 "지원하지 않습니다"로 실패하는 것이 정상이다.
  const begin = await cdp.try("capture_trigger", {});
  if (!begin.ok) {
    r.skip("화면 캡쳐", `capture_trigger 실패(${begin.message}) — 비Windows로 간주하고 스킵`);
    return;
  }

  // 캡쳐는 작업 스레드에서 돈다(메인 루프를 막지 않으려고) — 세션이 자리 잡을 시간을 준다.
  let sess = null;
  for (let i = 0; i < 40 && !sess; i++) {
    sess = await cdp.invoke("capture_current", {});
    if (!sess) await sleep(100);
  }
  r.check("① capture_trigger → 세션 생성", !!sess, sess ? `${sess.width}x${sess.height}` : "없음");
  if (!sess) return;

  r.check(
    "② 세션 크기가 실제 모니터 해상도",
    sess.width >= 640 && sess.height >= 480,
    `${sess.width}x${sess.height}`,
  );
  r.check(
    "③ 프리뷰가 JPEG data URL (PNG면 인코드 비용이 예산을 넘긴다)",
    typeof sess.preview === "string" && sess.preview.startsWith("data:image/jpeg;base64,"),
    `${sess.preview?.slice(0, 24)}… ${Math.round((sess.preview?.length ?? 0) / 1024)}KB`,
  );

  // 범위 밖 사각형은 패닉이 아니라 에러여야 한다 — 동기 경로에서 패닉이 새면 프로세스가 죽는다.
  const oob = await cdp.try("capture_to_clipboard", {
    id: sess.id,
    rect: { x: sess.width - 4, y: 0, w: 999999, h: 10 },
  });
  r.check("④ 범위 밖 사각형은 에러(패닉 아님)", !oob.ok, oob.message ?? "통과해버림");

  // 실패했어도 세션은 살아 있어야 한다 — 오클릭 한 번에 방금 찍은 화면이 날아가면 안 된다.
  const alive = await cdp.invoke("capture_current", {});
  r.check("⑤ 실패한 확정이 세션을 소모하지 않는다", !!alive && alive.id === sess.id);

  // 요청한 크기 그대로 잘리는지 — 클립보드 이미지 크기를 프론트에서 되읽어 대조한다.
  //
  // **환경 실패와 코드 실패를 구분한다.** Windows 클립보드는 다른 프로그램(원격 데스크톱
  // 클라이언트·클립보드 매니저류)이 잡고 있으면 프로세스를 가리지 않고 막힌다 — 실제로 이
  // 개발기에서 AnyDesk가 켜져 있는 동안 `clip.exe`조차 "액세스가 거부되었습니다"로 죽었다.
  // 그걸 우리 코드의 실패로 보고하면 다음 사람이 없는 버그를 쫓는다.
  const want = { x: 10, y: 10, w: 200, h: 120 };
  // 캡쳐 자동 저장(설정 기본 켬)은 **샤드 앱에서만** 켠 채로 둔다 — 샤드 앱은 자기 데이터 폴더 아래에 저장한다
  // (capture.rs `capture_save_dir`). 떠 있는 dev 앱에 붙은 회차(run.mjs)에서 켠 채 확정하면 사용자의 실제
  // 스크린샷 폴더에 파일이 생기고, 이 개발기는 Defender 제어된 폴더 액세스 때문에 러너가 그걸 지우지도 못한다.
  const isolated = !!process.env.GPV_E2E_SHARD;
  const settingsBefore = isolated ? null : await cdp.invoke("get_settings");
  if (settingsBefore) await cdp.invoke("set_settings", { settings: { ...settingsBefore, captureAutoSave: false } });
  let wrote;
  try {
    wrote = await cdp.try("capture_to_clipboard", { id: sess.id, rect: want });
  } finally {
    if (settingsBefore) await cdp.invoke("set_settings", { settings: settingsBefore });
  }
  if (!wrote.ok && /클립보드/.test(wrote.message ?? "")) {
    r.skip("⑥⑦ 클립보드 확정", `이 머신의 클립보드가 다른 프로그램에 잡혀 있다 — ${wrote.message}`);
    await cdp.invoke("capture_cancel", { id: sess.id });
    const freed = await cdp.invoke("capture_current", {});
    r.check("⑦' 취소로도 세션(프리즈 버퍼)이 해제된다", freed === null, freed ? "남아 있음" : "해제됨");
    return;
  }
  r.check("⑥' capture_to_clipboard 성공", wrote.ok, wrote.message ?? "");
  const got = await cdp.eval(`(async()=>{
    const m = await import("/node_modules/@tauri-apps/plugin-clipboard-manager/dist-js/index.js");
    const img = await m.readImage();
    const s = await img.size();
    return s.width + "x" + s.height;
  })()`).catch(() => null);
  if (got) {
    r.check("⑥ 클립보드 이미지가 요청한 크기와 일치", got === `${want.w}x${want.h}`, `요청 ${want.w}x${want.h} · 실제 ${got}`);
  } else {
    // 클립보드 **읽기** 권한은 일부러 안 준다 — 사용자가 복사해 둔 것을 앱이 읽을 수 있게 되는
    // 실제 권한 확대이고, 그걸 테스트 하나 때문에 여는 것은 값이 안 맞는다.
    // 크롭 좌표·크기 자체는 Rust 단위 테스트가 더 촘촘히 본다(commands/capture.rs
    // `crop_picks_the_requested_rect` — 스트라이드·알파·경계). 여기서는 체인이 도는 것만 본다.
    r.skip("⑥ 클립보드 이미지 크기", "클립보드 읽기 권한 미부여(의도) — 크롭 정확도는 Rust 단위 테스트");
  }

  // 자동 저장 — 커맨드가 돌려준 경로 **하나만** 보고 지운다(와일드카드로 남의 파일을 지우지 않는다).
  const saved = wrote.ok ? wrote.r : null;
  if (!isolated) {
    r.skip("⑩ 캡쳐 자동 저장", "샤드 앱이 아님 — 사용자 스크린샷 폴더에 쓰게 돼 껐다(node tests/e2e/shard.mjs 로 돌릴 때만 본다)");
  } else try {
    r.check("⑩ 자동 저장 = 샤드 데이터 폴더 · Windows 캡처 도구 이름 꼴", typeof saved === "string" &&
      /[\\/]gpv-shard[^\\/]*[\\/]screenshots[\\/]/i.test(saved) &&
      /^(스크린샷|Screenshot) \d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?\.png$/.test(basename(saved)), String(saved));
    // 내용은 반환 뒤 스레드가 채운다(capture.rs `start_save_png`) — 완성된 PNG 가 될 때까지 기다린다.
    let dims = null;
    for (let i = 0; i < 50 && typeof saved === "string" && !dims; i++) {
      const b = (() => { try { return readFileSync(saved); } catch { return null; } })();
      if (b && b.length > 24 && b.toString("latin1", 1, 4) === "PNG") dims = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
      else await sleep(100);
    }
    r.check("⑩' 저장된 PNG 가 요청한 크기", dims === `${want.w}x${want.h}`, `요청 ${want.w}x${want.h} · 파일 ${dims}`);
  } finally {
    if (typeof saved === "string") rmSync(saved, { force: true });
  }

  // 확정 뒤에는 버퍼가 풀려 있어야 한다(설계 R7).
  const after = await cdp.invoke("capture_current", {});
  r.check("⑦ 확정 후 세션(프리즈 버퍼) 해제", after === null, after ? "남아 있음" : "해제됨");

  // 이미 사라진 세션의 취소는 **성공**이어야 한다 — 오버레이가 닫히는 경로가 에러로 막히면
  // 전체화면 창이 화면에 남는다.
  const late = await cdp.try("capture_cancel", { id: sess.id });
  r.check("⑧ 만료된 세션 취소는 조용히 성공", late.ok, late.message ?? "");

  // 남은 오버레이가 없어야 한다(⑦에서 백엔드가 숨긴다). 떠 있으면 화면을 통째로 덮는다.
  await sleep(200);
  const visible = await cdp.eval(`(async()=>{
    const m = await import("/node_modules/@tauri-apps/api/webviewWindow.js");
    const w = await m.WebviewWindow.getByLabel("capture");
    return w ? await w.isVisible() : false;
  })()`).catch(() => null);
  if (visible === null) {
    // isVisible 권한이 없으면 확인할 방법이 없다 — 통과로 위장하지 않고 스킵으로 남긴다.
    r.skip("⑨ 확정 후 오버레이 숨김", "isVisible 조회 불가(권한) — 수동 확인 필요");
  } else {
    r.check("⑨ 확정 후 오버레이가 숨겨진다", visible === false, `isVisible=${visible}`);
  }

  await recordRoundTrip(cdp, r, isolated);
}

/**
 * 화면 녹화(commands/record.rs) 왕복 — 영역 선택 세션 → 카운트다운 → ffmpeg → 일시정지·재개(구간 녹화) → 정지(`q`)
 * → 이어 붙인 mp4 에 moov 가 있다. moov 가 없으면 재생 불가 파일이다(설계 R11 — kill 로 끝내면 이렇게 된다).
 * 오버레이 드래그 대신 커맨드로 확정한다. 샤드 앱에서만 — 샤드 앱은 `GPV_DATA_DIR/recordings` 에 쓴다.
 */
async function recordRoundTrip(cdp, r, isolated) {
  if (!isolated) {
    r.skip("⑪ 화면 녹화", "샤드 앱이 아님 — 사용자 동영상 폴더에 쓰게 돼 건너뛴다");
    return;
  }
  const tool = await cdp.invoke("video_tool_status", {});
  if (!tool?.found) {
    r.skip("⑪ 화면 녹화", "ffmpeg 없음 — 녹화는 ffmpeg 로 한다");
    return;
  }
  const openSession = async () => {
    await cdp.invoke("record_trigger", {});
    for (let i = 0; i < 60; i++) {
      const s = await cdp.invoke("capture_current", {});
      if (s?.mode === "record") return s;
      await sleep(100);
    }
    return null;
  };
  const waitResult = async () => {
    for (let i = 0; i < 60; i++) {
      const res = await cdp.eval("window.__recResult");
      if (res) return res;
      await sleep(250);
    }
    return null;
  };
  const listening = await cdp.eval(`(async()=>{
    const ev = await import("/node_modules/@tauri-apps/api/event.js");
    window.__recResult = null;
    await ev.listen("record://saved", (e) => (window.__recResult = { kind: "saved", ...e.payload }));
    await ev.listen("record://failed", (e) => (window.__recResult = { kind: "failed", message: e.payload }));
    await ev.listen("record://cancelled", () => (window.__recResult = { kind: "cancelled" }));
    return true;
  })()`).catch(() => false);
  r.check("⑪ 녹화 결과 이벤트 구독", listening === true);
  if (listening !== true) return;
  // 카운트다운은 1초로 — 기본 3초면 회차가 그만큼 늘 뿐 보는 것은 같다. 샤드 앱이라 끝나고 되돌릴 필요는 없지만 되돌린다.
  const settings = await cdp.invoke("get_settings");
  await cdp.invoke("set_settings", { settings: { ...settings, recordCountdownSecs: 1 } });
  let saved = null;
  try {
    // ── 카운트다운 중 정지 = 취소(파일 없음)
    const s1 = await openSession();
    r.check("⑫ record_trigger → 녹화 모드 선택 세션", !!s1, s1 ? `${s1.width}x${s1.height}` : "없음");
    if (!s1) return;
    const c = await cdp.try("record_start", { id: s1.id, rect: { x: 0, y: 0, w: 321, h: 181 } });
    r.check("⑬ record_start — 홀수 크기는 짝수로 내리고 카운트다운 1초", c.ok && c.r?.width === 320 && c.r?.height === 180 && c.r?.countdownSecs === 1,
      c.ok ? JSON.stringify(c.r) : c.message);
    if (!c.ok) return;
    const pauseEarly = await cdp.try("record_pause", { paused: true });
    r.check("⑬' 카운트다운 중 일시정지는 거절", !pauseEarly.ok, pauseEarly.message ?? "통과해버림");
    await cdp.eval("window.__recResult = null");
    await cdp.invoke("record_stop", {});
    const cancelled = await waitResult();
    r.check("⑭ 카운트다운 중 정지 = 취소(파일 없음)", cancelled?.kind === "cancelled", JSON.stringify(cancelled));

    // ── 녹화 → 일시정지 → 재개 → 정지: 두 구간이 한 파일로 이어 붙는다
    const s2 = await openSession();
    if (!s2) return r.check("⑮ 두 번째 녹화 세션", false, "없음");
    await cdp.eval("window.__recResult = null");
    const started = await cdp.try("record_start", { id: s2.id, rect: { x: 0, y: 0, w: 320, h: 180 } });
    if (!started.ok) return r.check("⑮ 두 번째 record_start", false, started.message);
    await sleep(1000 + 1300); // 카운트다운 1초 + 첫 구간
    const p = await cdp.try("record_pause", { paused: true });
    r.check("⑮ 일시정지", p.ok && p.r === true, p.ok ? String(p.r) : p.message);
    await sleep(800);
    const q = await cdp.try("record_pause", { paused: false });
    r.check("⑮' 재개", q.ok && q.r === false, q.ok ? String(q.r) : q.message);
    await sleep(1300);
    await cdp.invoke("record_stop", {});
    const res = await waitResult();
    saved = res?.kind === "saved" ? res.path : null;
    r.check("⑯ 정지 → 샤드 데이터 폴더에 '화면 녹화 <날짜> <시각>.mp4'", typeof saved === "string" &&
      /[\\/]gpv-shard[^\\/]*[\\/]recordings[\\/]/i.test(saved) &&
      /^(화면 녹화|Screen Recording) \d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?\.mp4$/.test(basename(saved)) && res.broken === false,
      JSON.stringify(res));
    const b = typeof saved === "string" ? readFileSync(saved) : null;
    r.check("⑰ mp4 에 moov 가 있다(정상 종료 — 재생 가능)", !!b && b.includes("moov") && b.toString("latin1", 4, 8) === "ftyp",
      b ? `${b.length}B` : "파일 없음");
    // 두 구간(각 ~1.3초)을 이어 붙였으면 길이가 한 구간보다 길다. 일시정지 0.8초는 빠진다.
    const probe = tool.probeFound && typeof saved === "string" ? join(dirname(tool.path), basename(tool.path).replace(/ffmpeg/i, "ffprobe")) : null;
    if (probe) {
      const dur = Number(execFileSync(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", saved]).toString().trim());
      r.check("⑰' 일시정지 앞뒤 두 구간이 한 파일로(길이 1.6~3.6초)", dur >= 1.6 && dur <= 3.6, `${dur.toFixed(2)}s`);
    } else {
      r.skip("⑰' 구간 이어 붙이기 길이", "ffprobe 없음");
    }
    r.check("⑱ 정지 뒤 녹화 상태가 풀려 캡쳐가 다시 열린다", (await cdp.try("capture_trigger", {})).ok);
    await sleep(800);
    const again = await cdp.invoke("capture_current", {});
    if (again) await cdp.invoke("capture_cancel", { id: again.id });
    r.check("⑱' 캡쳐 세션이 실제로 생겼다", !!again && again.mode === "capture");
  } finally {
    await cdp.invoke("set_settings", { settings }).catch(() => {}); // 복원 실패는 샤드 앱이라 회차 뒤에 버려진다
    if (typeof saved === "string") rmSync(saved, { force: true });
  }
}
