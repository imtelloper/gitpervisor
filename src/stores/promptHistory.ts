// 터미널별 "내가 입력해 Enter로 확정한 줄" 기록 — 모아보기 셀 우측 상단에서 펼쳐 본다.
// 수집은 lib/prompt-capture.ts(ptyWrite 훅), 이 스토어는 보관·영속·창 간 공유만 맡는다.
import { create } from "zustand";

export interface PromptEntry {
  id: string;
  text: string;
  /** epoch ms — 목록에 상대시간으로 표시 */
  at: number;
}

/** termId(=paneId) → 오래된 순 기록 */
export type PromptLog = Record<string, PromptEntry[]>;

const KEY = "gp:prompt-history";
// 셀 우측 프롬프트 컬럼(사이드 패널)의 열림 상태 — termId 단위. 기록과 키를 분리해
// 서로의 쓰기(기록은 Enter마다, 열림은 토글할 때만)가 상대 스냅샷을 갈아치우지 않게 한다.
const PANEL_KEY = "gp:prompt-panel-open";
// 한 터미널당 보관 개수 / 한 줄 최대 길이 / 추적할 터미널 수.
const MAX_PER_TERM = 200;
const MAX_TEXT = 4000;
const MAX_TERMS = 60;
// **직렬화 바이트 상한.** 개수 상한만으로는 최악 200줄 × 4000자 × 60터미널 = 수십 MB라
// 아무 보호가 안 된다. localStorage 5MB는 **origin 전체가 나눠 쓰는** 예산이라, 이 키가
// 부풀면 gp:terminals(탭·분할 레이아웃)·gp:viewer-tabs·gp:aggregate-tracks 저장이 전부
// QuotaExceeded로 조용히 실패한다 — 앱을 껐다 켜면 탭이 사라지는데 원인이 여기라는 걸
// 아무도 못 찾는 유형이다. 그래서 개수와 별개로 실제 바이트로 한 번 더 조인다.
const MAX_BYTES = 512_000;

let seq = 0;

/** 저장된 스냅샷을 PromptLog로 정규화 — 배열이 아닌 값은 버린다.
 *  손상된 항목 하나가 아래 프루닝(.length 접근)을 태우면 그 뒤 저장이 통째로 죽는다. */
function parseLog(raw: unknown): PromptLog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PromptLog = {};
  for (const [id, list] of Object.entries(raw as Record<string, unknown>))
    if (Array.isArray(list)) out[id] = list as PromptEntry[];
  return out;
}

function load(): PromptLog {
  try {
    const raw = localStorage.getItem(KEY);
    return parseLog(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

/** termId → true 맵으로 정규화 — 손상 값은 버린다. */
function parsePanels(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, true> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>))
    if (v === true) out[id] = true;
  return out;
}

function loadPanels(): Record<string, true> {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    return parsePanels(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

/** 패널 열림 상태 반영 — 기록(persist)과 같은 이유로 termId 단위 읽고-고쳐-쓰기. */
function persistPanel(termId: string, open: boolean): void {
  try {
    const cur = loadPanels();
    if (open) cur[termId] = true;
    else delete cur[termId];
    localStorage.setItem(PANEL_KEY, JSON.stringify(cur));
  } catch {
    /* localStorage 불가 — 열림 상태는 메모리에만 남는다 */
  }
}

/**
 * 디스크(localStorage) 반영 — **읽고-고쳐-쓰기**로 한 termId만 갈아끼운다.
 *
 * 터미널 스토어와 달리 여기선 메인 창만 저장할 수 없다: 모아보기 별도 창이 열리면 그 창이
 * xterm을 소유해 입력도 그 창에서 캡처된다(PTY 출력 소비자가 하나뿐이라 — lib/aggregate-window.ts).
 * 창마다 자기가 소유한 터미널의 기록을 쓰므로, 스냅샷을 통째로 덮어쓰면 상대 창의 기록이 날아간다.
 * termId별 소유자는 언제나 한 창뿐이라 이 방식이면 서로를 지우지 않는다.
 */
function persist(termId: string, list: PromptEntry[] | null): void {
  try {
    const cur = load();
    if (list) cur[termId] = list;
    else delete cur[termId];

    // 방금 쓴 터미널을 뺀 나머지를 "마지막 기록이 오래된 순"으로 — 버릴 후보 순서다.
    const staleFirst = () =>
      Object.keys(cur)
        .filter((id) => id !== termId)
        .map((id) => [id, cur[id][cur[id].length - 1]?.at ?? 0] as const)
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id);

    const over = Object.keys(cur).length - MAX_TERMS;
    if (over > 0) staleFirst().slice(0, over).forEach((id) => delete cur[id]);

    let json = JSON.stringify(cur);
    if (json.length > MAX_BYTES) {
      // ① 오래된 터미널부터 통째로 버린다(방금 쓴 것은 끝까지 남긴다).
      for (const id of staleFirst()) {
        delete cur[id];
        json = JSON.stringify(cur);
        if (json.length <= MAX_BYTES) break;
      }
      // ② 남은 한 터미널만으로도 넘치면(긴 프롬프트를 200줄) 그 터미널의 오래된 절반을 버린다.
      while (json.length > MAX_BYTES && (cur[termId]?.length ?? 0) > 1) {
        cur[termId] = cur[termId].slice(Math.ceil(cur[termId].length / 2));
        json = JSON.stringify(cur);
      }
    }
    localStorage.setItem(KEY, json);
  } catch {
    /* localStorage 불가·용량 초과 — 기록은 메모리에만 남는다(기능 자체는 계속 동작) */
  }
}

interface PromptHistoryState {
  byTerminal: PromptLog;
  /** 셀 우측 프롬프트 컬럼이 열려 있는 터미널들 — 세션이 닫힐 때(clear)까지 기억. */
  openPanels: Record<string, true>;
  /**
   * 확정된 줄들을 기록. 직전과 같은 줄이면 시각만 갱신한다(반복 실행이 목록을 채우지 않게).
   * **배열로 받는 이유**: 붙여넣기 한 번이 수백 줄을 동시에 확정할 수 있는데(bracketed paste가
   * 꺼진 셸), 줄마다 부르면 그 횟수만큼 localStorage를 파싱·직렬화해 입력이 멈춘다.
   */
  record: (termId: string, texts: string[]) => void;
  /** 셀 우측 프롬프트 컬럼 켜기/끄기. */
  togglePanel: (termId: string) => void;
  /** 여러 터미널의 컬럼을 한꺼번에 펼치기/접기(타이틀바 마스터 토글). */
  setPanels: (termIds: string[], open: boolean) => void;
  /** 이 터미널의 기록·패널 상태를 통째로 지운다(세션 종료·사용자 지우기). */
  clear: (termId: string) => void;
}

export const usePromptHistory = create<PromptHistoryState>((set, get) => ({
  byTerminal: load(),
  openPanels: loadPanels(),

  record: (termId, texts) => {
    if (texts.length === 0) return;
    const at = Date.now();
    const list = [...(get().byTerminal[termId] ?? [])];
    for (const text of texts) {
      const trimmed = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
      const last = list[list.length - 1];
      if (last && last.text === trimmed) list[list.length - 1] = { ...last, at };
      else list.push({ id: `${at}-${++seq}`, text: trimmed, at });
    }
    const capped =
      list.length > MAX_PER_TERM ? list.slice(list.length - MAX_PER_TERM) : list;
    set((s) => ({ byTerminal: { ...s.byTerminal, [termId]: capped } }));
    persist(termId, capped);
  },

  togglePanel: (termId) => {
    const open = !get().openPanels[termId];
    set((s) => {
      const next = { ...s.openPanels };
      if (open) next[termId] = true;
      else delete next[termId];
      return { openPanels: next };
    });
    persistPanel(termId, open);
  },

  setPanels: (termIds, open) => {
    set((s) => {
      const next = { ...s.openPanels };
      for (const id of termIds) {
        if (open) next[id] = true;
        else delete next[id];
      }
      return { openPanels: next };
    });
    // 일괄 반영 — termId마다 persistPanel을 부르면 N번 읽고-쓰기라, 같은 RMW 규칙으로 한 번에 쓴다.
    try {
      const cur = loadPanels();
      for (const id of termIds) {
        if (open) cur[id] = true;
        else delete cur[id];
      }
      localStorage.setItem(PANEL_KEY, JSON.stringify(cur));
    } catch {
      /* localStorage 불가 — 메모리에만 남는다 */
    }
  },

  clear: (termId) => {
    set((s) => {
      if (!(termId in s.byTerminal) && !(termId in s.openPanels)) return s;
      const rest = { ...s.byTerminal };
      delete rest[termId];
      const panels = { ...s.openPanels };
      delete panels[termId];
      return { byTerminal: rest, openPanels: panels };
    });
    persist(termId, null);
    persistPanel(termId, false);
  },
}));

// 다른 창(모아보기 별도 창 ↔ 메인)이 기록/패널 상태를 바꾸면 따라간다 — storage 이벤트는
// **다른 창**에서만 발화한다. 이쪽 창의 쓰기는 이미 write-through 됐으므로 스냅샷에 들어 있다.
window.addEventListener("storage", (e) => {
  if (!e.newValue) return;
  try {
    if (e.key === KEY)
      usePromptHistory.setState({ byTerminal: parseLog(JSON.parse(e.newValue)) });
    else if (e.key === PANEL_KEY)
      usePromptHistory.setState({ openPanels: parsePanels(JSON.parse(e.newValue)) });
  } catch {
    /* 손상된 값 무시 */
  }
});
