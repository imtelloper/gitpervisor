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
  /**
   * 확정된 줄들을 기록. 직전과 같은 줄이면 시각만 갱신한다(반복 실행이 목록을 채우지 않게).
   * **배열로 받는 이유**: 붙여넣기 한 번이 수백 줄을 동시에 확정할 수 있는데(bracketed paste가
   * 꺼진 셸), 줄마다 부르면 그 횟수만큼 localStorage를 파싱·직렬화해 입력이 멈춘다.
   */
  record: (termId: string, texts: string[]) => void;
  /** 이 터미널의 기록을 통째로 지운다(세션 종료·사용자 지우기). */
  clear: (termId: string) => void;
}

export const usePromptHistory = create<PromptHistoryState>((set, get) => ({
  byTerminal: load(),

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

  clear: (termId) => {
    set((s) => {
      if (!(termId in s.byTerminal)) return s;
      const rest = { ...s.byTerminal };
      delete rest[termId];
      return { byTerminal: rest };
    });
    persist(termId, null);
  },
}));

// 다른 창(모아보기 별도 창 ↔ 메인)이 기록을 남기면 따라간다 — storage 이벤트는 **다른 창**에서만
// 발화한다. 이쪽 창의 기록은 이미 write-through 됐으므로 방금 읽은 스냅샷에도 들어 있다.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY || !e.newValue) return;
  try {
    usePromptHistory.setState({ byTerminal: parseLog(JSON.parse(e.newValue)) });
  } catch {
    /* 손상된 값 무시 */
  }
});
