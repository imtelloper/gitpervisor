import type { ProcSortKey } from "../../lib/ipc";

/**
 * 리소스 모니터 설정(gp:sysmon) — 창들이 같은 origin이라 localStorage를 공유한다.
 * 라벨 "sysmon"은 싱글턴이라 파라미터를 실을 수 없으므로(쿼리스트링 불가), 타이틀바가
 * 클릭한 지표를 여기 써두고 팝업이 부팅 시 읽는 핸드오프 채널로 쓴다 (태스크 05 §3.6).
 * 부수 효과로 사용자의 마지막 정렬·그룹 설정이 재오픈 시 유지된다.
 */
const LS_KEY = "gp:sysmon";

/** 팝업의 표시 뷰 — 프로세스 목록 ⇄ 디스크 용량 분석(disk-usage-analyzer 설계 §3.4)
 *  ⇄ 시스템 정보(태스크 31 §3.3). */
export type SysmonView = "proc" | "disk" | "info";

export interface SysmonPrefs {
  sortBy: ProcSortKey;
  groupByName: boolean;
  view: SysmonView;
}

export function loadSysmonPrefs(): SysmonPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SysmonPrefs>;
      const sortBy: ProcSortKey =
        p.sortBy === "ram" || p.sortBy === "gpu" || p.sortBy === "disk"
          ? p.sortBy
          : "cpu";
      return {
        sortBy,
        groupByName: !!p.groupByName,
        view: p.view === "disk" || p.view === "info" ? p.view : "proc",
      };
    }
  } catch {
    // 손상된 값은 기본값으로
  }
  return { sortBy: "cpu", groupByName: false, view: "proc" };
}

export function saveSysmonPrefs(prefs: SysmonPrefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    // 저장 실패는 무해 — 다음 오픈이 기본값으로 뜰 뿐
  }
}

/** 타이틀바 지표 클릭 → 초기 정렬 핸드오프. 그룹 토글 등 나머지 설정은 보존한다.
 *  CPU/RAM 등 프로세스 지표 클릭은 뷰도 프로세스로 되돌린다(디스크 뷰에 눌러앉음 방지). */
export function writeSysmonSortKey(sortBy: ProcSortKey) {
  saveSysmonPrefs({ ...loadSysmonPrefs(), sortBy, view: "proc" });
}

/** 타이틀바 SSD 클릭 → 디스크 분석 뷰 핸드오프(디스크 설계 §3.4). */
export function writeSysmonView(view: SysmonView) {
  saveSysmonPrefs({ ...loadSysmonPrefs(), view });
}
