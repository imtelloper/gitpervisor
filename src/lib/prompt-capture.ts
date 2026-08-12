import { usePromptHistory } from "../stores/promptHistory";

/**
 * "내가 터미널에 입력해 Enter로 확정한 줄"을 PTY 송신 바이트열에서 복원한다.
 *
 * 캡처 지점은 terminal-engine의 `ptyWrite` 하나다 — 키 입력·IME 확정 문자열(WebKitGTK
 * compositionend / macOS 델타)·붙여넣기가 전부 그 함수를 지나므로, 여기 한 곳만 물면
 * 플랫폼별 입력 경로를 따로 좇지 않아도 된다.
 *
 * **어려운 지점은 "무엇이 사용자 입력이 아닌가"다.** `term.onData`에는 키 입력만이 아니라
 * xterm의 자동응답(커서 위치 `\x1b[..R`, DA `\x1b[?..c`, 포커스 `\x1b[I`/`\x1b[O`, 마우스
 * 리포트)이 상시 흐른다 — TUI(Claude Code 등)는 초당 수십 번 질의한다. 그래서
 *  - 이스케이프 시퀀스는 **텍스트로 취급하지도, 버퍼를 비우지도 않고** 통째로 건너뛴다.
 *    (여기서 버퍼를 비우면 자동응답이 올 때마다 타이핑 중인 줄이 날아간다.)
 *  - 예외는 ↑/↓뿐 — 히스토리 호출은 셸/TUI가 입력 줄을 통째로 갈아끼우므로 우리 복원본이
 *    무효가 된다. 이때만 버퍼를 버린다(잘못 기록하느니 안 기록한다).
 *
 * 완벽한 복원은 불가능하다(Tab 완성·좌우 커서 이동 후 삽입은 셸만 아는 상태다). 목표는
 * "무엇을 시켰는지 돌아보는 목록"이지 셸 히스토리의 대체가 아니다.
 */

/** 한 터미널의 입력 복원 상태 — 아직 Enter로 확정되지 않은 현재 줄. */
export interface InputScan {
  buf: string;
}

// 한 줄이 이보다 길어지면 **뒤를 버린다**(앞을 남긴다) — 거대 붙여넣기로 메모리가 부풀지 않게.
// 앞을 남기는 이유는 두 가지다:
//  ① 기록에 남는 값은 어차피 앞 MAX_TEXT자다(promptHistory) — 뒤를 남기면 시작이 잘린
//     중간 토막이 "…"까지 붙어 기록돼 무엇을 시켰는지 알아볼 수 없다.
//  ② 한도에 닿는 순간 이어붙이기를 멈출 수 있어 비용이 O(1)이 된다. 뒤를 남기려면 글자마다
//     8KB를 재복사해야 해서, 수백 KB 붙여넣기 한 번이 입력 스레드를 초 단위로 멈춘다.
const MAX_BUF = 8192;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** 코드포인트 단위로 마지막 한 글자를 지운다(한글 1음절·이모지 = 1코드포인트 취급). */
function dropLast(s: string): string {
  const a = Array.from(s);
  a.pop();
  return a.join("");
}

/**
 * `data[i]`가 ESC일 때 그 이스케이프 시퀀스가 끝나는 다음 인덱스를 돌려준다.
 * 청크 경계에서 잘린 시퀀스는 끝까지 삼킨다(다음 청크에 남은 꼬리가 텍스트로 새는 것보다 낫다).
 */
function escEnd(data: string, i: number): number {
  const c1 = data[i + 1];
  if (c1 === undefined) return data.length;
  // CSI — 파라미터/중간 바이트를 지나 최종 바이트(0x40~0x7e)에서 끝난다.
  if (c1 === "[") {
    for (let j = i + 2; j < data.length; j++) {
      const code = data.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return j + 1;
    }
    return data.length;
  }
  // OSC — BEL 또는 ST(ESC \)로 끝난다.
  if (c1 === "]") {
    for (let j = i + 2; j < data.length; j++) {
      if (data[j] === "\x07") return j + 1;
      if (data[j] === "\x1b" && data[j + 1] === "\\") return j + 2;
    }
    return data.length;
  }
  // DCS/SOS/PM/APC — ST로 끝난다.
  if (c1 === "P" || c1 === "X" || c1 === "^" || c1 === "_") {
    for (let j = i + 2; j < data.length; j++) {
      if (data[j] === "\x1b" && data[j + 1] === "\\") return j + 2;
    }
    return data.length;
  }
  // SS3(응용 커서키 모드의 방향키 \x1bOA·PF키)·SS2 — ESC + 지시자 + 최종 문자 **한 글자 더**.
  // 여기서 두 글자로 끊으면 최종 문자('A' 등)가 텍스트로 새어 들어간다.
  if (c1 === "O" || c1 === "N") return Math.min(i + 3, data.length);
  // Alt+키 등 — ESC + 한 글자.
  return i + 2;
}

/**
 * PTY로 나가는 `data`를 흘려넣고, 이번 청크에서 **Enter로 확정된 줄**들을 돌려준다.
 * 순수 함수(상태는 `st`에만 있음) — 단위 검증이 쉽게.
 */
export function feedInput(st: InputScan, data: string): string[] {
  const out: string[] = [];
  const append = (text: string) => {
    if (st.buf.length >= MAX_BUF) return; // 한도 도달 — 앞부분만 남기고 나머지는 버린다
    st.buf += text;
    if (st.buf.length > MAX_BUF) st.buf = st.buf.slice(0, MAX_BUF);
  };

  let i = 0;
  while (i < data.length) {
    const c = data[i];

    if (c === "\x1b") {
      // 괄호 붙여넣기 — 안쪽은 사용자가 붙여넣은 진짜 내용이라 버퍼에 담는다(Enter 전까지 미확정).
      if (data.startsWith(PASTE_START, i)) {
        const from = i + PASTE_START.length;
        const end = data.indexOf(PASTE_END, from);
        const stop = end < 0 ? data.length : end;
        // 붙여넣기는 수 MB(로그 통째로)일 수 있는데 남길 건 앞 MAX_BUF자뿐이다 —
        // 잘라내고 개행 정규화를 돌린다. 전체를 slice+정규식 하면 그 한 번에 수십 ms가 든다.
        append(data.slice(from, Math.min(stop, from + MAX_BUF)).replace(/\r\n?/g, "\n"));
        i = end < 0 ? data.length : end + PASTE_END.length;
        continue;
      }
      const end = escEnd(data, i);
      const seq = data.slice(i, end);
      // ↑/↓ = 히스토리 호출 — 줄이 통째로 갈아끼워지므로 복원본을 버린다.
      if (seq === "\x1b[A" || seq === "\x1b[B" || seq === "\x1bOA" || seq === "\x1bOB")
        st.buf = "";
      // X10 마우스 리포트는 최종 바이트 'M' **뒤에 원시 3바이트**(모두 0x20 이상이라 평문으로
      // 보인다)가 붙는다 — 함께 버리지 않으면 텍스트로 새어 들어간다. 지금 xterm은 X10(DEFAULT)
      // 인코딩만 onData가 아니라 onBinary로 보내고 이 앱은 onBinary를 구독하지 않아 여기까지
      // 오지 않지만, 그 배선이 생기는 순간 조용히 깨지는 자리라 미리 막아 둔다.
      i = seq === "\x1b[M" ? Math.min(end + 3, data.length) : end;
      continue;
    }

    if (c === "\r" || c === "\n") {
      const line = st.buf.trim();
      if (line) out.push(line);
      st.buf = "";
      i++;
      continue; // "\r\n"의 두 번째 문자는 빈 버퍼를 만나 무시된다
    }

    if (c === "\x7f" || c === "\b") {
      st.buf = dropLast(st.buf);
      i++;
      continue;
    }

    // Ctrl+C / Ctrl+U / Ctrl+D / Ctrl+Z — 입력 줄이 취소·소멸한다.
    if (c === "\x03" || c === "\x15" || c === "\x04" || c === "\x1a") {
      st.buf = "";
      i++;
      continue;
    }

    // 그 밖의 C0 제어문자(Tab 완성 등)는 무시하고 버퍼는 유지한다 — 셸이 줄을 다시 쓰는 것까지는
    // 추적할 수 없지만, 버퍼를 비우면 완성으로 끝낸 명령이 통째로 기록에서 사라진다.
    if (data.charCodeAt(i) < 0x20) {
      i++;
      continue;
    }

    // 평문은 **구간 통째로** 붙인다. 글자마다 append를 타면 수 MB 붙여넣기(로그를 통째로
    // 에이전트에 던지는 흔한 사용)에서 문자열 조작이 글자 수만큼 반복돼 입력이 눈에 띄게 밀린다.
    let j = i + 1;
    while (j < data.length) {
      const cc = data.charCodeAt(j);
      if (cc < 0x20 || cc === 0x7f) break; // 제어문자를 만나면 위 분기들이 처리하도록 되돌아간다
      j++;
    }
    append(data.slice(i, j));
    i = j;
  }
  return out;
}

// 터미널별 복원 상태. xterm 인스턴스와 같은 수명(dispose/detach 시 정리).
const scans = new Map<string, InputScan>();

/**
 * PTY 송신 바이트를 흘려넣는다 — 확정된 줄이 나오면 프롬프트 기록에 남긴다.
 *
 * **여기서 던지면 그 키 입력이 PTY로 나가지 못한다** — `ptyWrite`의 첫 줄이라 예외가
 * `term_write` 호출 자체를 건너뛰게 만든다. 부가 기능이 입력을 먹는 건 어떤 이유로도
 * 용납되지 않으므로 통째로 감싼다(기록 스토어는 zustand set → React 렌더까지 동기로 탄다).
 */
export function capturePtyInput(termId: string, data: string): void {
  try {
    let st = scans.get(termId);
    if (!st) {
      st = { buf: "" };
      scans.set(termId, st);
    }
    const lines = feedInput(st, data);
    // 줄마다 부르지 않는다 — 비-bracketed 멀티라인 붙여넣기는 한 청크에서 수백 줄을 확정하는데,
    // record 한 번마다 localStorage를 통째로 파싱·직렬화하므로 그대로 두면 붙여넣기가 멈춘다.
    if (lines.length > 0) usePromptHistory.getState().record(termId, lines);
  } catch {
    /* 기록 실패는 무시 — 입력 경로를 막지 않는 것이 우선이다 */
  }
}

/** 복원 상태만 버린다(기록은 남긴다) — 창 간 분리(detach)·세션 종료 공통. */
export function forgetPtyInput(termId: string): void {
  scans.delete(termId);
}
