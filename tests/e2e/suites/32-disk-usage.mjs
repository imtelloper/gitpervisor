// 디스크 용량 분석 (disk_scan.rs — DOCS/disk-usage-analyzer-design.md)
// 격리된 임시 픽스처 폴더를 스캔해 합산 정확성·자식 목록·Top 파일·경로 가드·취소를 검증한다.
// 사용자 데이터는 읽지도 쓰지도 않는다(픽스처는 os.tmpdir 아래, 끝나면 제거).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name = "디스크 용량 분석 (disk_scan_* / disk_children / disk_top_files)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 스캔 종결(phase != scanning)까지 status 폴링. */
async function waitDone(cdp, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const s = await cdp.invoke("disk_scan_status", {}, { timeoutMs: 5000 });
    if (s.phase !== "scanning") return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await sleep(250);
  }
}

/** 진행률 Channel<String> 인자 생성 — 수신 JSON 메시지를 window 슬롯에 쌓는다. */
async function progressChannel(cdp, slot) {
  const rid = await cdp.eval(
    `(()=>{ window[${JSON.stringify(slot)}]=[]; return window.__TAURI_INTERNALS__.transformCallback((m)=>{ try{ window[${JSON.stringify(slot)}].push(m&&m.message); }catch(_){} }); })()`,
  );
  return {
    ref: `__CHANNEL__:${rid}`,
    drain: () =>
      cdp.eval(
        `(()=>{ const a=window[${JSON.stringify(slot)}]||[]; window[${JSON.stringify(slot)}]=[]; return a; })()`,
      ),
  };
}

export async function run({ cdp, report: r }) {
  // ── 픽스처: a.bin(100K) + sub/b.bin(200K) + sub/inner/c.bin(300K) ──
  const KB = 1024;
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-disk-"));
  try {
    writeFileSync(join(root, "a.bin"), Buffer.alloc(100 * KB));
    mkdirSync(join(root, "sub", "inner"), { recursive: true });
    writeFileSync(join(root, "sub", "b.bin"), Buffer.alloc(200 * KB));
    writeFileSync(join(root, "sub", "inner", "c.bin"), Buffer.alloc(300 * KB));

    // ── 볼륨 목록 ──
    const roots = await cdp.invoke("disk_roots", {}, { timeoutMs: 10000 });
    r.check(
      "disk_roots: 마운트·total 셰이프",
      Array.isArray(roots) &&
        roots.length > 0 &&
        roots.every((d) => typeof d.mount === "string" && d.total > 0 && d.available >= 0),
      roots.map((d) => d.mount).join(", "),
    );

    // ── 스캔 전 가드 — 완료된 스캔이 없으면 disk_children 은 실패해야 한다 ──
    // (직전 실행이 결과를 남겼을 수 있어, 실패했다면 코드가 타임아웃이 아님만 확인)
    const before = await cdp.try("disk_children", { rel: "" }, { timeoutMs: 5000 });
    r.check(
      "가드: 스캔 전/무결과 disk_children 동작",
      before.ok || before.code !== "E2E_TIMEOUT",
      before.ok ? "직전 결과 존재(허용)" : `${before.code || ""}`,
    );

    // ── 스캔 실행 (진행 Channel 포함) ──
    const ch = await progressChannel(cdp, "__gpvDiskProg");
    const started = await cdp.try(
      "disk_scan_start",
      { path: root, onProgress: ch.ref },
      { timeoutMs: 10000 },
    );
    r.check("disk_scan_start: 호출 성공", started.ok, started.ok ? root : `${started.code} ${started.message}`);

    const done = await waitDone(cdp);
    r.check("스캔 완료: phase=done", done.phase === "done", `phase=${done.phase} err=${done.error ?? ""}`);
    r.check(
      "합산 정확성: bytes=600K · files=3 · dirs=2",
      done.bytes === 600 * KB && done.files === 3 && done.dirs === 2,
      `bytes=${done.bytes} files=${done.files} dirs=${done.dirs}`,
    );
    r.check("스캔: 접근 불가 폴더 없음(skipped=0)", done.skipped === 0, `${done.skipped}`);

    // 진행 Channel — 최소 1건, 마지막 메시지 done=true (250ms 스로틀이라 빠른 스캔도 1건은 온다)
    await sleep(600); // 리포터의 마지막 틱 여유
    const msgs = (await ch.drain()).map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    });
    const last = msgs.filter(Boolean).at(-1);
    r.check(
      "진행 Channel: 수신 + 마지막 메시지 done=true",
      msgs.length > 0 && !!last && last.done === true,
      `${msgs.length}건, last.phase=${last?.phase}`,
    );

    // ── 자식 목록: 루트 ──
    const top = await cdp.invoke("disk_children", { rel: "" }, { timeoutMs: 10000 });
    r.check("children(루트): 폴더 합산 bytes=600K", top.bytes === 600 * KB, `${top.bytes}`);
    const sub = top.dirs.find((d) => d.name === "sub");
    r.check(
      "children(루트): sub 폴더 캐시 합산(500K·2파일·1폴더)",
      !!sub && sub.bytes === 500 * KB && sub.files === 2 && sub.dirs === 1,
      sub ? `bytes=${sub.bytes} files=${sub.files} dirs=${sub.dirs}` : "sub 없음",
    );
    const aFile = top.files.find((f) => f.name === "a.bin");
    r.check(
      "children(루트): live 파일 행(a.bin=100K) + 절단 없음",
      !!aFile && aFile.bytes === 100 * KB && top.truncatedFiles === 0,
      aFile ? `${aFile.bytes}` : "a.bin 없음",
    );

    // ── 자식 목록: 하위 폴더 + 정렬(내림차순) ──
    const subL = await cdp.invoke("disk_children", { rel: "sub" }, { timeoutMs: 10000 });
    const inner = subL.dirs.find((d) => d.name === "inner");
    r.check(
      "children(sub): inner=300K, b.bin=200K",
      !!inner && inner.bytes === 300 * KB && subL.files[0]?.name === "b.bin" && subL.files[0]?.bytes === 200 * KB,
      `inner=${inner?.bytes} file0=${subL.files[0]?.name}`,
    );

    // ── Top 파일 — 전역 내림차순 ──
    const tops = await cdp.invoke("disk_top_files", { limit: 10 }, { timeoutMs: 10000 });
    r.check(
      "top_files: c.bin(300K) → b.bin(200K) → a.bin(100K)",
      tops.length === 3 &&
        tops[0].bytes === 300 * KB &&
        tops[0].path.endsWith("c.bin") &&
        tops[1].bytes === 200 * KB &&
        tops[2].bytes === 100 * KB,
      tops.map((t) => t.bytes).join(","),
    );

    // ── 할당 크기(§2.2) — 일반 파일 볼륨이면 alloc ≈ bytes(Windows는 동일, Unix는 블록 반올림 이상) ──
    r.check(
      "alloc: 합계가 논리 크기 이상 규약",
      typeof done.alloc === "number" && done.alloc >= done.bytes * 0.9,
      `alloc=${done.alloc} bytes=${done.bytes}`,
    );
    r.check(
      "children: 행에 alloc 필드",
      typeof sub?.alloc === "number" && typeof aFile?.alloc === "number",
      `sub.alloc=${sub?.alloc} file.alloc=${aFile?.alloc}`,
    );

    // ── 트리맵(§3.5) — own_bytes(직속 파일 몫)·자식 크기순·드릴다운 rel ──
    const tm = await cdp.invoke("disk_treemap", { rel: "", depth: 2 }, { timeoutMs: 10000 });
    r.check("treemap: 루트 bytes=600K", tm.bytes === 600 * KB, `${tm.bytes}`);
    r.check(
      "treemap: 루트 ownBytes=a.bin(100K)·ownFiles=1",
      tm.ownBytes === 100 * KB && tm.ownFiles === 1,
      `own=${tm.ownBytes}/${tm.ownFiles}`,
    );
    const tmSub = tm.children.find((c) => c.name === "sub");
    r.check(
      "treemap: sub 노드(500K)·rel·하위 inner(300K)",
      !!tmSub &&
        tmSub.bytes === 500 * KB &&
        tmSub.rel === "sub" &&
        tmSub.children[0]?.name === "inner" &&
        tmSub.children[0]?.bytes === 300 * KB &&
        tmSub.children[0]?.rel === "sub/inner",
      tmSub ? `bytes=${tmSub.bytes} child0=${tmSub.children[0]?.rel}` : "sub 없음",
    );
    // depth=1이면 sub의 자식(inner)은 접혀 otherBytes로 남는다.
    const tm1 = await cdp.invoke("disk_treemap", { rel: "", depth: 1 }, { timeoutMs: 10000 });
    const tm1Sub = tm1.children.find((c) => c.name === "sub");
    r.check(
      "treemap: depth=1 절단 → inner가 otherBytes로",
      !!tm1Sub && tm1Sub.children.length === 0 && tm1Sub.otherBytes === 300 * KB,
      tm1Sub ? `other=${tm1Sub.otherBytes}` : "sub 없음",
    );
    // 드릴다운 — rel="sub"를 루트로.
    const tmDrill = await cdp.invoke("disk_treemap", { rel: "sub", depth: 2 }, { timeoutMs: 10000 });
    r.check(
      "treemap: 드릴다운(rel=sub) 루트 500K·직속 b.bin(200K)",
      tmDrill.bytes === 500 * KB && tmDrill.ownBytes === 200 * KB,
      `bytes=${tmDrill.bytes} own=${tmDrill.ownBytes}`,
    );

    // ── 경로 가드: ".." 탈출 거부 ──
    const esc = await cdp.try("disk_children", { rel: "../.." }, { timeoutMs: 5000 });
    r.check("가드: '..' 탈출 거부", !esc.ok && esc.code !== "E2E_TIMEOUT", `${esc.code || ""}`);

    // ── 미존재 폴더 ──
    const missing = await cdp.try("disk_children", { rel: "no-such-dir" }, { timeoutMs: 5000 });
    r.check("가드: 스캔 결과에 없는 폴더 거부", !missing.ok && missing.code !== "E2E_TIMEOUT");

    // ── 취소 — 재스캔 직후 취소해도 상태가 종결(cancelled 또는 done)로 수렴해야 한다 ──
    const ch2 = await progressChannel(cdp, "__gpvDiskProg2");
    await cdp.invoke("disk_scan_start", { path: root, onProgress: ch2.ref }, { timeoutMs: 10000 });
    await cdp.invoke("disk_scan_cancel", {}, { timeoutMs: 5000 });
    const after = await waitDone(cdp, 10000);
    r.check(
      "취소: 종결 상태로 수렴(cancelled|done)",
      after.phase === "cancelled" || after.phase === "done",
      `phase=${after.phase}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
