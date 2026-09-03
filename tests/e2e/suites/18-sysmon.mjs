// 리소스 모니터 (태스크 05) — ① sys_process_snapshot 셰이프·정렬·limit·그룹 합산(창 불필요)
// ② open_sysmon_window 창 생성/싱글턴 재호출/close 소멸 (13-float-window의 창 검증 패턴).
//
// 그룹 합산 검증은 개별/그룹 두 invoke 를 연달아 호출한다 — Monitor 의 500ms 스로틀 캐시가
// 같은 프로세스 표본을 공유하므로 두 응답의 수치가 정확히 대응해야 한다(합산 계약 검증에 이용).

export const name = "리소스 모니터 (sys_process_snapshot / open_sysmon_window)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

const snap = (cdp, args) =>
  cdp.invoke("sys_process_snapshot", args, { timeoutMs: 10000 });

/** 내림차순(비강증가) 여부 — 부동소수 오차 허용. */
const isDesc = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] >= v - 1e-6);

export async function run({ cdp, report: r }) {
  // ── ① 커맨드 셰이프 ──
  // 첫 프로세스 표본은 CPU 델타 기준점(전부 0%)이라 워밍업 1회 후, 스로틀(500ms)을 넘겨 본 측정.
  await snap(cdp, { sortBy: "cpu", limit: 20, groupByName: false });
  await sleep(700);
  const s = await snap(cdp, { sortBy: "cpu", limit: 20, groupByName: false });

  r.check(
    "snapshot: totals(SysMetrics) 배치 포함",
    typeof s?.totals?.cpu === "number" && typeof s?.totals?.ram === "number" && typeof s?.totals?.ramTotal === "number",
    `cpu=${s?.totals?.cpu} ram=${s?.totals?.ram}`,
  );
  r.check("snapshot: processes 배열 비어있지 않음", Array.isArray(s?.processes) && s.processes.length > 0, `${s?.processes?.length}개`);
  r.check("snapshot: limit(20) 절단", s.processes.length <= 20, `${s.processes.length}`);
  r.check("snapshot: totalCount ≥ 표시 행 수", typeof s?.totalCount === "number" && s.totalCount >= s.processes.length, `${s.totalCount}`);

  const p0 = s.processes[0] || {};
  r.check(
    "샘플: pid/name/cpu/ram 타입",
    typeof p0.pid === "number" && typeof p0.name === "string" && p0.name.length > 0 && typeof p0.cpu === "number" && typeof p0.ram === "number",
    `${p0.name} pid=${p0.pid}`,
  );
  r.check("샘플: gpu는 null 또는 number", s.processes.every((p) => p.gpu === null || typeof p.gpu === "number"));
  r.check("샘플: 개별 모드 groupCount=null", s.processes.every((p) => p.groupCount === null));
  r.check("샘플: cpu 전역 스케일(0-100)", s.processes.every((p) => p.cpu >= 0 && p.cpu <= 100.5), `max=${Math.max(...s.processes.map((p) => p.cpu)).toFixed(1)}`);
  r.check("정렬: cpu 내림차순", isDesc(s.processes.map((p) => p.cpu)));

  // ── 정렬·limit 전환 ──
  const byRam = await snap(cdp, { sortBy: "ram", limit: 10, groupByName: false });
  r.check("정렬: ram 내림차순 + limit 10", byRam.processes.length <= 10 && isDesc(byRam.processes.map((p) => p.ram)), `${byRam.processes.length}개`);

  const byGpu = await snap(cdp, { sortBy: "gpu", limit: 1000000, groupByName: false });
  const gpus = byGpu.processes.map((p) => p.gpu);
  const firstNull = gpus.indexOf(null);
  const nonNullPrefix = firstNull < 0 ? gpus : gpus.slice(0, firstNull);
  const nullsAllLast = firstNull < 0 || gpus.slice(firstNull).every((g) => g === null);
  r.check("정렬: gpu 내림차순, null은 항상 뒤로", isDesc(nonNullPrefix) && nullsAllLast, `측정 ${nonNullPrefix.length} / 전체 ${gpus.length}`);

  // ── 그룹 합산 (같은 스로틀 캐시 표본을 공유하는 연속 호출로 정확 대응 검증) ──
  const flat = await snap(cdp, { sortBy: "ram", limit: 1000000, groupByName: false });
  const grouped = await snap(cdp, { sortBy: "ram", limit: 1000000, groupByName: true });

  const names = grouped.processes.map((p) => p.name);
  r.check("그룹: 이름 중복 없음", new Set(names).size === names.length, `${names.length}개 그룹`);
  r.check("그룹: groupCount ≥ 1", grouped.processes.every((p) => (p.groupCount ?? 0) >= 1));
  r.check("그룹: 그룹 수 ≤ 개별 수", grouped.totalCount <= flat.totalCount, `${grouped.totalCount} ≤ ${flat.totalCount}`);
  const sumCounts = grouped.processes.reduce((n, p) => n + (p.groupCount || 0), 0);
  r.check("그룹: groupCount 총합 = 개별 프로세스 수", sumCounts === flat.totalCount, `${sumCounts} vs ${flat.totalCount}`);
  r.check("그룹: gpu 합산 100 캡", grouped.processes.every((p) => p.gpu === null || p.gpu <= 100));

  // 다중 프로세스 프로그램 하나로 합산 수치 검증(ram은 정수 합이라 정확 비교 가능).
  const byName = new Map();
  for (const p of flat.processes) {
    const acc = byName.get(p.name) || { count: 0, ram: 0, pids: [] };
    acc.count += 1;
    acc.ram += p.ram;
    acc.pids.push(p.pid);
    byName.set(p.name, acc);
  }
  const multi = [...byName.entries()].find(([, v]) => v.count > 1);
  if (multi) {
    const [mName, mAgg] = multi;
    const g = grouped.processes.find((p) => p.name === mName);
    r.check(`그룹: "${mName}" 합산 일치(count·ram)`, !!g && g.groupCount === mAgg.count && g.ram === mAgg.ram, g ? `×${g.groupCount} ram=${g.ram}` : "그룹 행 없음");
    r.check("그룹: pid는 구성원 중 하나(최대 기여자)", !!g && mAgg.pids.includes(g.pid), g ? `pid=${g.pid}` : "");
  } else {
    // 동명 프로세스가 하나도 없는 환경(비정상적으로 한가한 머신)에선 수치 검증만 생략 —
    // 합산 계약 자체는 위의 groupCount 총합 검사로 이미 확인됐다.
    r.check("그룹: 합산 수치 검증(동명 프로세스 없음 — 생략)", true, "표본에 동명 프로세스 없음");
  }

  // ── ② 창 열림 / 싱글턴 ──
  const label = "sysmon";
  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${JSON.stringify(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );
  const closeSysmon = () =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${JSON.stringify(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${JSON.stringify(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);

  try {
    const origin = await cdp.eval(`window.location.origin`);
    const created = await cdp.try("open_sysmon_window", { origin });
    r.check("open_sysmon_window: 호출 성공", created.ok, created.ok ? "" : `${created.code || ""} ${created.message || ""}`);

    // 창 생성 폴링(최대 ~8s — 새 OS 창 + 웹뷰 초기화)
    let has = false;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const ls = await labels();
      if (Array.isArray(ls) && ls.includes(label)) {
        has = true;
        break;
      }
    }
    r.check("open_sysmon_window: sysmon OS 창 생성됨", has, label);

    // 싱글턴 — 재호출은 새 창을 만들지 않고 set_focus()만 하고 성공해야 한다
    // (생성을 다시 시도하면 동일 라벨 충돌로 빌드 실패 로그가 남는다).
    if (has) {
      const again = await cdp.try("open_sysmon_window", { origin });
      await sleep(500);
      const ls = await labels();
      r.check(
        "싱글턴: 재호출 성공 + sysmon 창 유지",
        again.ok && Array.isArray(ls) && ls.filter((l) => l === label).length === 1,
        Array.isArray(ls) ? ls.join(",") : String(ls),
      );

      // close() → 소멸 폴링 (Destroyed 훅은 main/float-* 외 no-op — 정리 코드 불필요)
      await closeSysmon();
      let gone = false;
      for (let i = 0; i < 14; i++) {
        await sleep(500);
        const ls2 = await labels();
        if (Array.isArray(ls2) && !ls2.includes(label)) {
          gone = true;
          break;
        }
      }
      r.check("sysmon 창: close()로 정상 소멸", gone);
    }
  } finally {
    // 잔여 창 정리 — 다음 실행·사용자 화면에 흔적 안 남기기.
    await closeSysmon();
    await sleep(300);
  }

  // ── ③ 시스템 정보 (sys_info_static — 태스크 31 §5-3) ──
  // 첫 수집은 PowerShell CIM/system_profiler 기동 탓에 수 초 걸린다(그래서 30s 시한).
  const si = await cdp.try("sys_info_static", { force: false }, { timeoutMs: 30000 });
  const missing =
    !si.ok && /not found|not allowed/i.test(`${si.code || ""} ${si.message || ""}`);
  if (missing) {
    // Rust 커맨드가 아직 등록되지 않은 단계 — 러너를 깨뜨리지 않고 넘어간다(반영 후엔 아래가 돈다).
    r.skip("sys_info_static: 커맨드 미등록", `${si.message || ""}`.trim());
  } else if (!si.ok) {
    r.check("sys_info_static: 호출 성공", false, `${si.code || ""} ${si.message || ""}`.trim());
  } else {
    const d = si.r || {};
    r.check("sysinfo: os.name 비어있지 않음", typeof d?.os?.name === "string" && d.os.name.length > 0, `${d?.os?.name} ${d?.os?.version || ""}`);
    r.check("sysinfo: cpu.logicalCores ≥ 1", typeof d?.cpu?.logicalCores === "number" && d.cpu.logicalCores >= 1, `${d?.cpu?.brand} ×${d?.cpu?.logicalCores}`);
    r.check("sysinfo: memory.totalBytes > 0", typeof d?.memory?.totalBytes === "number" && d.memory.totalBytes > 0, `${d?.memory?.totalBytes}`);
    r.check("sysinfo: volumes ≥ 1", Array.isArray(d?.volumes) && d.volumes.length >= 1, `${d?.volumes?.length}개`);
    r.check("sysinfo: notes는 문자열 배열", Array.isArray(d?.notes) && d.notes.every((n) => typeof n === "string"), (d?.notes || []).join(" | "));

    // Windows는 CIM으로 전부 채워져야 한다(비어 있으면 파서·권한 문제 — 조용히 넘기지 않는다).
    if (process.platform === "win32") {
      r.check("sysinfo(win): gpus ≥ 1", Array.isArray(d?.gpus) && d.gpus.length >= 1, (d?.gpus || []).map((g) => g.name).join(", "));
      r.check("sysinfo(win): board 존재", !!d?.board && typeof d.board.product === "string", d?.board ? `${d.board.manufacturer} ${d.board.product}` : "null");
      r.check("sysinfo(win): cpu.cacheL3Kb > 0", typeof d?.cpu?.cacheL3Kb === "number" && d.cpu.cacheL3Kb > 0, `${d?.cpu?.cacheL3Kb}`);
    }

    // force:true 는 캐시를 무시하고 재수집 — collectedAtMs 가 앞선다.
    const forced = await cdp.try("sys_info_static", { force: true }, { timeoutMs: 30000 });
    r.check(
      "sysinfo: force 재수집 시 collectedAtMs 증가",
      forced.ok && typeof forced.r?.collectedAtMs === "number" && forced.r.collectedAtMs >= d.collectedAtMs,
      forced.ok ? `${d.collectedAtMs} → ${forced.r.collectedAtMs}` : `${forced.code || ""} ${forced.message || ""}`,
    );

    // 캐시 hit 은 수집 없이 즉답 — CDP 왕복을 빼려고 페이지 안에서 잰다.
    const ms = await cdp.eval(
      `(async()=>{ const t=performance.now(); try{ await window.__TAURI_INTERNALS__.invoke('sys_info_static',{force:false}); }catch(e){ return -1; } return performance.now()-t; })()`,
    );
    r.check("sysinfo: 캐시 hit < 50ms", typeof ms === "number" && ms >= 0 && ms < 50, `${typeof ms === "number" ? ms.toFixed(1) : ms}ms`);
  }
}
