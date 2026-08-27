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
  const wrote = await cdp.try("capture_to_clipboard", { id: sess.id, rect: want });
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
}
