// 이미지 뷰어 글자 추출(OCR) — DOCS/task/68-image-ocr.md §4.
//
// 이 스위트가 지키는 계약 넷:
//   ① **엔진은 OS 것을 쓰되 계약은 하나다.** `ocr_image` 하나가 세 OS에서 같은 `OcrResult` 를
//      돌려준다. 그래서 "값이 나왔다"로 끝내지 않고 **이 OS에서 이 엔진이 돌았다**까지 함께
//      잰다 — `#[cfg]` 백엔드가 엉뚱한 쪽에 붙으면 결과는 그럴듯한데 엔진 이름이 어긋난다.
//   ② **상자는 원본 이미지 px 다.** Vision 의 정규화 좌표([0,1], 원점 좌하단)나 ×2 패스의 두 배
//      좌표가 그대로 새면 강조 상자가 글줄이 아니라 왼쪽 위 귀퉁이에 찍힌다. 상자를 뷰어
//      `<img>` 의 naturalWidth/Height 안에 가두는 것만으로는 부족하다 — **글줄 크기(w ≥ 8,
//      h ≥ 4)와 y 단조 증가**를 함께 봐야 정규화 좌표와 y 뒤집기가 걸린다.
//   ③ **빈 결과는 모든 단언을 공허하게 만든다.** `[].every(...)` 는 참이고, 줄이 0개면 확대
//      판정도 false 라 warnings 도 빈다. 그래서 상자 단언과 "warnings 가 비었다" 단언은 각각
//      `lines.length >= 3` 과 **같은 `r.check` 안**에 둔다(§4 ②⑥의 명시 요구).
//   ④ **인식 텍스트는 느슨하게, 그러나 완전 실패는 빨갛게.** 실측 CER 이 0 이 아니라(§2.2)
//      정확 일치를 요구하면 간헐이 된다 — 안정적인 토막(릴리스·latest·2026)만 본다.
//
// 픽스처는 페이지 캔버스에 `fillText` 로 그린다(43 이 이미 한글을 캔버스에 그린다). 32px 세 줄이
// 주 픽스처고, 같은 세 줄의 12px 판이 ×2 재인식 분기를 켠다. **두 방향을 함께 잰다** — 12px 은
// 확대되어야 하고 32px 은 확대되면 **안 된다**(16px 밝은 산문은 ×2 가 오히려 해쳤다, §3.4).
// 한쪽만 재면 "무조건 확대"와 "확대 안 함"이 둘 다 통과한다.
//
// 클립보드는 머신에 하나뿐이라 이 스위트는 `run.mjs` 의 `GLOBAL_RESOURCE` 에 들어 있다.
// 잠금화면에서는 52·60 과 같이 복사 단언이 빨개진다 — 감지·스킵 선례가 없어 그대로 받는다.
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

export const name =
  "이미지 뷰어 글자 추출 OCR (ocr_image 계약 · 원본 px 상자 · ×2 재인식 · 패널 복사)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const REL32 = "e2e-ocr-32.png";
const REL12 = "e2e-ocr-12.png";
const REL_MISSING = "e2e-ocr-none.png";
/** 레포 **밖**(fix.repo 의 부모)에 두는 진짜 PNG — 경로 게이트의 과녁이다(아래 ⑨ 주석). */
const OUTSIDE_NAME = "e2e-ocr-outside.png";
const OUTSIDE_REL = `../${OUTSIDE_NAME}`;
const SENTINEL = "gpv-e2e-54-clipboard-sentinel";

/** 픽스처 세 줄. 안정적으로 읽히는 토막 셋이 텍스트 단언의 과녁이다(정확 일치는 안 본다). */
const FIXTURE_LINES = [
  "릴리스는 태그 푸시에서 시작한다",
  "latest.json 을 생성한다",
  "2026-09-17 14:32",
];
const NEEDLES = ["릴리스", "latest", "2026"];
const ENGINES = ["windows_ocr", "apple_vision", "tesseract_cli"];

/**
 * 흰 바탕에 검은 세 줄을 그린 PNG 를 만든다 — base64 와 함께 크기·잉크 양을 돌려준다.
 *
 * 잉크를 세는 이유: 한글 폰트가 없어 캔버스가 통째로 비면 뒤따르는 OCR 단언이 전부 빨개지는데,
 * 그때 원인이 "OCR 이 못 읽었다"로 보인다. 픽스처가 비었다는 것은 픽스처 단계에서 말해야 한다.
 */
const MAKE_PNG = (px) => `(() => {
  const px = ${px};
  const lines = ${J(FIXTURE_LINES)};
  const font = px + 'px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const pad = Math.round(px * 0.8);
  const lh = Math.round(px * 1.7);
  const w = Math.ceil(Math.max.apply(null, lines.map((s) => probe.measureText(s).width))) + pad * 2;
  const h = lh * lines.length + pad * 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#111111';
  x.font = font;
  x.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) x.fillText(lines[i], pad, pad + lh * i);
  const d = x.getImageData(0, 0, w, h).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
  return { b64: c.toDataURL('image/png').split(',')[1], w: w, h: h, ink: ink };
})()`;

/**
 * 이 머신에 OCR 엔진이 실제로 있는가. 없으면 §4 ④에 따라 ①을 `TOOL_NOT_FOUND` 로 대체한다.
 * macOS 는 darwin 커널 22 = macOS 13 이고, 그게 Vision 한국어의 하한이다(§2.3).
 */
function detectEngine() {
  if (process.platform === "win32") return { engine: "windows_ocr", why: "Windows.Media.Ocr" };
  if (process.platform === "darwin") {
    const major = Number(release().split(".")[0]);
    return major >= 22
      ? { engine: "apple_vision", why: `Vision (darwin ${major})` }
      : { engine: null, why: `macOS 13 미만(darwin ${major}) — Vision 에 한국어가 없다` };
  }
  if (process.platform === "linux") {
    const probe = spawnSync("tesseract", ["--version"]);
    return !probe.error && probe.status === 0
      ? { engine: "tesseract_cli", why: "tesseract CLI" }
      : { engine: null, why: "PATH 에 tesseract 없음" };
  }
  return { engine: null, why: `지원하지 않는 플랫폼(${process.platform})`, unsupported: true };
}

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("이미지 글자 추출(OCR)", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const platform = detectEngine();
  if (platform.unsupported) {
    r.skip("이미지 글자 추출(OCR)", `${platform.why} — 스킵`);
    return;
  }

  const poll = async (fn, ok, tries = 30, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  // ── 페이지 질의 ────────────────────────────────────────────────────────────
  /** 뷰어가 **그 파일을** 그리고 있는지 + 원본 픽셀 크기. alt 로 가른다(46 과 같은 규칙). */
  const viewerImage = (rel) =>
    cdp.eval(`(()=>{
      const box = document.querySelector('.checkerboard[tabindex="0"]');
      const img = box && box.querySelector('img');
      if (!img || img.getAttribute('alt') !== ${J(rel)}) return null;
      return { w: img.naturalWidth, h: img.naturalHeight };
    })()`);
  const runBtn = () =>
    cdp.eval(`(()=>{
      const b = document.querySelector('[data-ocr-run]');
      return b ? { label: (b.textContent || '').trim(), disabled: !!b.disabled } : null;
    })()`);
  const clickRun = () =>
    cdp.eval(`(()=>{
      const b = document.querySelector('[data-ocr-run]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
  /** 패널 요약 — 줄은 패널 안에서만 센다(강조 상자는 패널 밖, 이미지 위에 있다). */
  const panel = () =>
    cdp.eval(`(()=>{
      const p = document.querySelector('[data-ocr-panel]');
      if (!p) return null;
      const meta = p.querySelector('[data-ocr-meta]');
      return {
        meta: meta ? (meta.textContent || '').trim() : '',
        lines: Array.from(p.querySelectorAll('[data-ocr-line]')).map((el) => el.textContent || ''),
        warnings: Array.from(p.querySelectorAll('[data-ocr-warning]')).map((el) => (el.textContent || '').trim()),
        empty: !!p.querySelector('[data-ocr-empty]'),
        // 버튼은 문서 전체에서 찾는다 — 계약이 요구하는 것은 **있다** 이지 패널 안에 중첩됐다가
        // 아니다(헤더에 나란히 두는 배치도 사용자에겐 같은 것이다).
        copy: !!document.querySelector('[data-ocr-copy]'),
        close: !!document.querySelector('[data-ocr-close]'),
      };
    })()`);
  /**
   * 줄에 hover. React 의 onMouseEnter 는 네이티브 mouseenter 가 아니라 **mouseover** 에서
   * 합성된다(14 #2d 주석) — relatedTarget 없이 보내야 "밖에서 들어옴"으로 읽힌다.
   */
  const hoverLine = (i) =>
    cdp.eval(`(()=>{
      const p = document.querySelector('[data-ocr-panel]');
      const el = p && p.querySelector('[data-ocr-line="' + ${i} + '"]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    })()`);
  const highlight = () =>
    cdp.eval(`(()=>{
      const all = document.querySelectorAll('[data-ocr-highlight]');
      if (all.length !== 1) return { n: all.length, top: null, h: null };
      const rc = all[0].getBoundingClientRect();
      return { n: 1, top: rc.top, h: rc.height };
    })()`);
  const clickPanelBtn = (sel) =>
    cdp.eval(`(()=>{
      const p = document.querySelector('[data-ocr-panel]');
      const b = (p && p.querySelector(${J(sel)})) || document.querySelector(${J(sel)});
      if (!b) return false;
      b.click();
      return true;
    })()`);

  // 클립보드는 52 와 같은 경로로 읽는다(공용 헬퍼는 없다). `cdp.try` 는 성공 값을 `.r` 로 준다.
  const clipboard = () =>
    cdp
      .try("term_paste")
      .then((x) => (x.ok ? String(x.r ?? "") : ""))
      .catch(() => "");
  const primeClipboard = (text) =>
    cdp
      .eval(`window.__gpvClipboard.copy(${J(text)})`)
      .then((v) => !!(v && v.ok))
      .catch(() => false);
  const hasClipHook = await cdp.eval(`!!window.__gpvClipboard`);

  const ocr = (rel) => cdp.try("ocr_image", { projectId: fix.projectId, relPath: rel }, { timeoutMs: 45000 });
  /** CRLF 는 클립보드 계층의 관례다 — 여기서 재는 것은 줄 내용이지 줄바꿈 표기가 아니다. */
  const lf = (s) => String(s || "").split("\r\n").join("\n");

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  const outsidePath = join(fix.repo, "..", OUTSIDE_NAME);
  let savedClip = "";

  try {
    // ── 셋업: 픽스처 두 장 + 레포 밖 한 장 ──────────────────────────────────
    const png32 = await cdp.eval(MAKE_PNG(32));
    const png12 = await cdp.eval(MAKE_PNG(12));
    if (
      !r.check(
        "픽스처 캔버스 렌더(32px·12px 세 줄, 흰 바탕) — 잉크가 실제로 찍혔다",
        !!png32 && !!png12 && png32.ink > 500 && png12.ink > 100 && png32.w > png12.w,
        `32px=${png32 && png32.w}×${png32 && png32.h} ink=${png32 && png32.ink} · 12px=${png12 && png12.w}×${png12 && png12.h} ink=${png12 && png12.ink}`,
      )
    )
      return;

    const w32 = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: REL32,
      base64: png32.b64,
      overwrite: true,
    });
    const w12 = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: REL12,
      base64: png12.b64,
      overwrite: true,
    });
    if (
      !r.check(
        "픽스처 PNG 두 장 기록(write_file_bytes)",
        w32.ok && w12.ok && existsSync(join(fix.repo, REL32)) && existsSync(join(fix.repo, REL12)),
        `32=${J(w32.code || w32.ok)} 12=${J(w12.code || w12.ok)}`,
      )
    )
      return;
    // 레포 밖 파일은 node 로 쓴다 — `write_file_bytes` 도 같은 경로 게이트라 거기선 못 나간다.
    writeFileSync(outsidePath, Buffer.from(png32.b64, "base64"));

    // ── 뷰어에 32px 픽스처 열기 ─────────────────────────────────────────────
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(400);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (stuck !== fix.projectId) {
      r.skip("이미지 글자 추출(OCR)", `픽스처 프로젝트 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer")`,
    );
    await cdp.eval(
      `window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`,
    );
    await cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(REL32)} })`,
    );
    const dims = await poll(() => viewerImage(REL32), (v) => !!v && v.w > 0, 40, 250);
    if (
      !r.check(
        "이미지 뷰어가 32px 픽스처를 원본 크기로 그린다(.checkerboard 박스)",
        !!dims && dims.w === png32.w && dims.h === png32.h,
        `naturalSize=${dims && dims.w}×${dims && dims.h} 기대=${png32.w}×${png32.h}`,
      )
    )
      return;

    const btn0 = await poll(runBtn, (v) => !!v, 20, 250);
    if (
      !r.check(
        "뷰어 헤더에 [글자 추출] 버튼(`data-ocr-run`)이 있다",
        !!btn0 && btn0.disabled === false && btn0.label.includes("글자 추출"),
        `btn=${J(btn0)}`,
      )
    )
      return;

    if (platform.engine === null) {
      // ── §4 ④ 엔진 없는 환경: ①을 `TOOL_NOT_FOUND` 로 대체한다 ─────────────
      const miss = await ocr(REL32);
      r.check(
        `(68 ①') 엔진이 없는 환경(${platform.why})은 **무반응이 아니라 TOOL_NOT_FOUND** 로 끝난다 — 메시지에 무엇을 설치하면 되는지가 실려야 한다(§1)`,
        miss.ok === false && miss.code === "TOOL_NOT_FOUND" && String(miss.message || "").length > 10,
        `ok=${miss.ok} code=${J(miss.code)} msg=${J(String(miss.message || "").slice(0, 120))}`,
      );

      await cdp.eval(`window.__gpv.ui.setState({ toasts: [] })`);
      await clickRun();
      const toasts = await poll(
        () => cdp.eval(`window.__gpv.ui.getState().toasts.map(t => t.kind + ':' + t.message)`),
        (v) => Array.isArray(v) && v.length > 0,
        20,
        250,
      );
      r.check(
        "(68 ④') [글자 추출] 은 회색 버튼·무반응이 아니라 **토스트**로 끝난다 — 패널도 안 뜬다",
        Array.isArray(toasts) &&
          toasts.length >= 1 &&
          toasts.some((t) => t.startsWith("error:")) &&
          (await panel()) === null,
        `toasts=${J(toasts)}`,
      );
    } else {
      // ── ① 계약 · ② 상자 · ③ 확대 금지 ────────────────────────────────────
      const res = await ocr(REL32);
      const R = (res.ok && res.r) || null;
      const lines = (R && R.lines) || [];
      const text = (R && R.text) || "";
      r.check(
        `(68 ①) \`ocr_image\` 가 32px 세 줄을 읽는다 — 이 OS 의 엔진(${platform.engine})·요청 언어가 실리고, 줄 ≥ 3, text 에 ${NEEDLES.join("·")} 가 들어 있다(느슨한 포함 — 실측 CER 이 0 이 아니다)`,
        !!R &&
          R.engine === platform.engine &&
          ENGINES.includes(R.engine) &&
          Array.isArray(R.languages) &&
          R.languages.length >= 1 &&
          lines.length >= 3 &&
          NEEDLES.every((s) => text.includes(s)),
        `ok=${res.ok} code=${J(res.code)} engine=${J(R && R.engine)} lang=${J(R && R.languages)} 줄=${lines.length} text=${J(text.slice(0, 160))}`,
      );

      // **한 `r.check` 안에서** 줄 수와 상자를 함께 잰다 — 줄이 0개면 `every` 가 참이라
      // 상자 단언만 따로 두면 OCR 이 통째로 죽어도 초록이다(§4 ②).
      const W = dims.w;
      const H = dims.h;
      const inBounds = (b) =>
        !!b &&
        b.x >= -1 &&
        b.y >= -1 &&
        b.x + b.w <= W + 1 &&
        b.y + b.h <= H + 1 &&
        // 크기까지 봐야 정규화 좌표([0,1])가 걸린다 — 그건 "0 ≤ x ≤ W" 를 그냥 통과한다.
        b.w >= 8 &&
        b.h >= 4;
      // `box` 자체가 없을 수 있다(serde rename "box" 누락) — 없으면 여기서 던지지 말고 빨개져야 한다.
      const first = lines.length ? lines[0].box : null;
      const last = lines.length ? lines[lines.length - 1].box : null;
      const ascending = lines.length >= 2 && !!first && !!last && first.y < last.y;
      r.check(
        "(68 ②) 줄 상자가 **원본 이미지 px** 다 — 줄 ≥ 3 이면서 모든 상자가 naturalWidth/Height 안이고 글줄 크기(w ≥ 8, h ≥ 4)이며 y 가 읽기 순서로 증가한다(정규화 좌표·×2 좌표·y 뒤집기가 여기서 걸린다)",
        lines.length >= 3 && lines.every((l) => inBounds(l.box)) && ascending,
        `줄=${lines.length} 이미지=${W}×${H} 상자=${J(lines.slice(0, 3).map((l) => l.box))}`,
      );

      r.check(
        "(68 ③) 32px(글자 큼) 픽스처는 **확대하지 않는다** — 줄 ≥ 3 이면서 warnings 가 비어 있다(16px 밝은 산문은 ×2 가 CER 을 0.053 → 0.112 로 해쳤다, §3.4)",
        lines.length >= 3 && Array.isArray(R.warnings) && R.warnings.length === 0,
        `줄=${lines.length} warnings=${J(R && R.warnings)}`,
      );

      // ── ④ 패널 · ⑤ 강조 · ⑥ 복사 · ⑦ 닫기 ────────────────────────────────
      savedClip = await clipboard();
      const clicked = await clickRun();
      const p1 = await poll(panel, (v) => !!v && v.lines.length > 0, 40, 250);
      r.check(
        "(68 ④) [글자 추출] → 패널(`data-ocr-panel`)에 줄이 뜬다 — 줄 ≥ 3, 머리에 엔진·언어·줄 수 한 줄, 줄 텍스트에 인식한 글자가 그대로 들어 있다",
        clicked === true &&
          !!p1 &&
          p1.lines.length >= 3 &&
          p1.meta.length > 0 &&
          p1.empty === false &&
          p1.copy === true &&
          NEEDLES.every((s) => p1.lines.join("\n").includes(s)),
        `클릭=${clicked} 줄=${p1 && p1.lines.length} meta=${J(p1 && p1.meta.slice(0, 80))} 빈상태=${p1 && p1.empty}`,
      );

      const before = await highlight();
      const h0 = (await hoverLine(0)) ? await poll(highlight, (v) => v && v.n === 1, 12, 150) : null;
      // 둘째 줄은 **값이 바뀔 때까지** 기다린다 — 리렌더 전에 읽으면 첫 줄의 top 을 다시 본다.
      const h1 =
        (await hoverLine(1)) && h0
          ? await poll(highlight, (v) => v && v.n === 1 && v.top !== h0.top, 12, 150)
          : null;
      r.check(
        "(68 ⑤) 줄에 hover 하면 이미지 위 강조 상자가 **정확히 하나** 생기고(hover 전엔 0개), 둘째 줄 상자가 첫 줄보다 아래다 — 좌표 매핑과 읽기 순서를 한 번에 잰다",
        !!before &&
          before.n === 0 &&
          !!h0 &&
          h0.n === 1 &&
          !!h1 &&
          h1.n === 1 &&
          h0.top < h1.top,
        `hover전=${before && before.n} 첫줄=${J(h0)} 둘째줄=${J(h1)}`,
      );

      // 센티널을 먼저 깔아 둔다 — 안 깔면 "클립보드가 이미 그 값이었다"가 통과로 위장한다
      // (52 `primeClipboard` 주석의 그 결함 계열).
      const primed = hasClipHook ? await primeClipboard(SENTINEL) : false;
      const wantCopy = lf((p1 ? p1.lines : []).join("\n"));
      await clickPanelBtn("[data-ocr-copy]");
      const clip = lf(
        await poll(clipboard, (v) => typeof v === "string" && lf(v) !== SENTINEL, 20, 250),
      );
      r.check(
        "(68 ⑥) [전체 복사] 가 인식한 줄 전체를 클립보드에 넣는다 — 센티널이 패널 텍스트로 바뀌고, 그 텍스트에 실제 글자가 들어 있다(둘 다 비면 '같다'가 공허하다)",
        primed === true && wantCopy.includes("릴리스") && clip === wantCopy && clip !== SENTINEL,
        `센티널기록=${primed} 클립=${J(clip.slice(0, 120))} 패널=${J(wantCopy.slice(0, 120))}`,
      );

      const closed = await clickPanelBtn("[data-ocr-close]");
      const gone = await poll(panel, (v) => v === null, 16, 200);
      r.check(
        "(68 ⑦) [닫기] 로 패널이 사라진다 — 열림·닫힘 **두 방향**을 함께 잰다(열리기만 재면 닫기가 죽어도 초록이다)",
        !!p1 && closed === true && gone === null,
        `열림=${!!p1} 닫기클릭=${closed} 닫힘=${gone === null}`,
      );

      // ── ⑧ ×2 재인식 분기(12px) ───────────────────────────────────────────
      const small = await ocr(REL12);
      const S = (small.ok && small.r) || null;
      r.check(
        "(68 ⑧) 12px(작은 글자) 픽스처는 **×2 로 다시 읽는다** — warnings 에 `2배` 가 실리고 줄 ≥ 1(텍스트 일치는 안 본다: 13px 실측 상한이 CER 0.10 이다, §3.4)",
        !!S &&
          Array.isArray(S.warnings) &&
          S.warnings.some((w) => String(w).includes("2배")) &&
          S.lines.length >= 1,
        `ok=${small.ok} code=${J(small.code)} 줄=${S ? S.lines.length : -1} warnings=${J(S && S.warnings)}`,
      );
    }

    // ── ⑨ 반증: 경로 게이트 ─────────────────────────────────────────────────
    //
    // `../e2e-ocr-outside.png` 자리에는 **읽히는 진짜 PNG** 를 미리 뒀다. 게이트가 빠지면
    // 이 호출은 성공한다(파일이 없어서 실패하는 게 아니다) — 그래야 이 단언이 경로 게이트를
    // 재는 것이지 파일 유무를 재는 것이 아니게 된다.
    const escape = await ocr(OUTSIDE_REL);
    const missing = await ocr(REL_MISSING);
    const realError = (x) => x.ok === false && !!x.code && x.code !== "E2E_TIMEOUT" && x.code !== "E2E_CDP";
    r.check(
      "(68 ⑨) 레포 밖 경로(`../`, 그 자리에 진짜 PNG 가 있다)와 없는 파일이 **둘 다 오류**다 — 조용한 빈 성공이 아니다",
      existsSync(outsidePath) && realError(escape) && realError(missing),
      `밖=${escape.ok}/${J(escape.code)} 없음=${missing.ok}/${J(missing.code)}`,
    );
  } finally {
    // ── 정리 — 이 스위트가 연 탭·선택·픽스처·클립보드를 되돌린다(53·46 과 같은 규칙) ──
    await cdp
      .eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(fix.projectId)})`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    await cdp
      .eval(
        `window.__gpv.queryClient.removeQueries({ queryKey: ${J(["file-image", fix.projectId])} })`,
      )
      .catch(() => {});
    for (const p of [join(fix.repo, REL32), join(fix.repo, REL12), outsidePath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 픽스처 정리는 best-effort — 러너 teardown 이 임시 루트를 통째로 지운다 */
      }
    }
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`)
      .catch(() => {});
    // 사용자 클립보드 복원 — 이 스위트는 GLOBAL_RESOURCE 라 남기면 다음 스위트가 본다.
    if (hasClipHook && savedClip) await primeClipboard(savedClip);
    if (origSel)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
    await sleep(300);
  }
}
