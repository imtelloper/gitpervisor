import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * 터미널 패널을 별도 OS 창으로 띄운다. 창 생성은 Rust(open_float_window)가 담당한다 —
 * JS의 new WebviewWindow는 메인 창과 WebView2 환경 인자가 어긋나 웹뷰가 빈 채로 뜨기 때문.
 * 창은 index.html?float=<paneId>&project=<pid>를 로드하고 FloatingTerminal이 살아있는 PTY에
 * term_attach로 재연결한다. 창 라벨 `float-<paneId>` 는 Rust 창 닫힘 이벤트에서 PTY 종료에 쓰인다.
 */
export function openFloatingWindow(paneId: string, _projectId: string) {
  // paneId는 창 라벨(float-<paneId>)로 전달된다 — 프론트가 라벨에서 읽어 PTY에 attach한다.
  // origin은 메인 창이 로드된 곳 — 새 창도 같은 곳을 띄워 dev/prod 모두 동작한다.
  // Rust가 프리워밍 풀(숨김 창)이 있으면 그걸 claim해 즉시 띄운다(lib.rs FloatPool).
  void invoke("open_float_window", {
    paneId,
    origin: window.location.origin,
  }).catch((e) => {
    console.error("플로팅 터미널 창 생성 실패:", e);
  });
}

/** 플로팅 창 풀 프리워밍 — 분리 클릭 시 창 생성·번들 로드를 기다리지 않게 숨김 창을 미리
 *  만들어 둔다. 메인 창 부트 후 유휴 시점에 1회 호출(비어 있을 때만 실제 생성). */
export function warmFloatingWindowPool() {
  void invoke("float_pool_warm", { origin: window.location.origin }).catch(() => {});
}

/** 풀 창 자신이 claim 리스너 무장 후 호출 — 준비 신고(핸드셰이크). FloatingTerminal 전용. */
export function floatPoolReady() {
  void invoke("float_pool_ready").catch(() => {});
}

// ---- 파일 뷰어 창(doc-<id>) ----

/** 창 라벨엔 경로를 못 넣어서(문자 집합 제한) 대상을 여기 적어 두고 새 창이 자기 id로 읽는다. */
const DOC_KEY = "gp:doc-windows";
/** 보관 상한 — 창이 닫혔는지 알 방법이 없어 개수로 자른다. 항목 하나가 수십 바이트라 넉넉하다. */
const DOC_MAX = 20;

export interface DocTarget {
  projectId: string;
  path: string;
  /**
   * 뜨자마자 이미지 편집기를 연다(뷰어에서 [편집]을 한 번 더 누르지 않게).
   * **옵셔널이어야 한다** — 이 필드가 생기기 전에 적힌 localStorage 항목이 남아 있고,
   * readDocs 는 JSON 파싱만 검사하지 필드 유무는 못 본다.
   */
  edit?: boolean;
  /**
   * 있으면 이 창은 **파일 하나가 아니라 폴더**를 연다(태스크 66 — 즐겨찾기 폴더 창).
   * 값은 그 폴더의 절대경로. 이때 `projectId` 는 빈 문자열이고 `path` 는 같은 절대경로다
   * (창 제목·기존 코드 경로가 `path` 를 읽으므로 비워 두지 않는다).
   * `edit` 과 같은 이유로 **옵셔널이어야 한다** — 이 필드 이전에 적힌 항목이 남아 있다.
   */
  folder?: string;
}

/**
 * 이 창이 파일 하나짜리 문서 창(`doc-<id>`)인가. 편집기가 모달 카드 대신 창을 꽉 채워야 할지,
 * [편집] 버튼이 새 창을 열지 이 창에서 열지를 이걸로 가른다.
 *
 * props 가 아니라 모듈 상수인 이유: 같은 판별이 ImageEditor 와 ImageView 양쪽에 필요한데
 * ImageView 는 DiffViewer 를 관통해야 prop 이 닿는다. `IS_FLOAT_UI`(stores/ui.ts)·
 * `IS_AGGREGATE_WINDOW`(stores/terminals.ts) 와 같은 패턴이다.
 */
export const IS_DOC_WINDOW = (() => {
  try {
    return getCurrentWebviewWindow().label.startsWith("doc-");
  } catch {
    return false;
  }
})();

function readDocs(): Record<string, DocTarget> {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, DocTarget>) : {};
  } catch {
    return {}; // 손상 — 새로 시작한다(잃는 것은 "다음에 열 창의 대상"뿐이다)
  }
}

/**
 * 파일 하나를 읽기용 별도 창으로 띄운다(파일트리 우클릭 → 새 창으로 열기).
 *
 * 대상은 **같은 origin의 localStorage**로 넘긴다 — 창 라벨에 경로를 실을 수 없고(공백·한글·`.`),
 * 별도 창이라 메인의 zustand 스토어를 볼 수도 없다. 이 앱이 창 간 상태를 넘기던 기존 방식과 같다
 * (`gp:browser`·`gp:viewer-tabs`).
 *
 * `opts.size`는 창 크기 요청(기본은 Rust의 900×760). 이미지처럼 그 창 안에서 편집기까지 여는
 * 대상은 넓게 연다 — 편집기 우측 패널이 고정 폭이라 좁은 창에서는 stage가 눌린다.
 * `opts.edit`이면 그 창이 뜨자마자 편집기를 연다(뷰어 단계를 건너뛴다).
 */
export function openDocWindow(
  projectId: string,
  path: string,
  opts?: { size?: [number, number]; edit?: boolean },
): void {
  const id = crypto.randomUUID().replace(/-/g, "");
  const docs = readDocs();
  docs[id] = { projectId, path, edit: opts?.edit };
  const keys = Object.keys(docs); // 문자열 키라 삽입 순서가 유지된다 → 뒤쪽이 최신
  const kept =
    keys.length > DOC_MAX
      ? Object.fromEntries(keys.slice(-DOC_MAX).map((k) => [k, docs[k]]))
      : docs;
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(kept));
  } catch {
    /* 용량 초과 — 창은 그래도 띄운다(대상을 못 찾으면 그 창이 안내한다) */
  }
  // `size`는 Rust가 창 내부 크기로 받는다(`lib.rs` open_doc_window — 생략하면 900×760,
  // 값은 420..3000으로 클램프된다: 화면 밖으로 나간 커스텀 타이틀바는 움직일 수도 닫을 수도 없다).
  void invoke("open_doc_window", {
    docId: id,
    title: path.split("/").pop() ?? path,
    origin: window.location.origin,
    size: opts?.size,
  }).catch((e) => {
    console.error("문서 창 생성 실패:", e);
  });
}

/** 이 창이 띄울 대상 — main.tsx가 라벨(`doc-<id>`)에서 뽑은 id로 부른다. */
export function docTarget(id: string): DocTarget | null {
  return readDocs()[id] ?? null;
}

/** 경로 → 창 id. **결정적이어야 한다** — 같은 폴더를 다시 누르면 같은 라벨(`doc-<id>`)이 나와야
 *  Rust 가 새 창 대신 기존 창에 포커스만 준다(lib.rs open_doc_window 의 싱글턴 분기).
 *  crypto.randomUUID 를 쓰면 누를 때마다 창이 하나씩 늘어난다.
 *  FNV-1a 32bit 를 정·역방향으로 두 번 돌려 16자를 만든다 — 라벨 문자 집합(영숫자·`-`)에 맞고,
 *  충돌해도 결과는 "다른 폴더가 같은 창을 쓴다"가 아니라 그냥 그 창이 재사용될 뿐이다
 *  (창이 뜬 뒤 실제로 무엇을 여는지는 localStorage 의 항목이 정한다 — 그건 매번 덮어쓴다). */
function folderWindowId(path: string): string {
  const fnv = (s: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const rev = path.split("").reverse().join("");
  return fnv(path) + fnv(rev);
}

/**
 * 즐겨찾기 폴더를 **별도 OS 창**으로 연다(태스크 66).
 *
 * 파일 뷰어 창(`doc-*`)의 인프라를 그대로 탄다 — 새 라벨도, 새 캡처빌리티도, 새 창 커맨드도
 * 필요 없다. 차이는 localStorage 에 적는 항목에 `folder` 가 있다는 것뿐이고, `DocWindow` 가
 * 그걸 보고 뷰어 대신 `FolderWindow` 를 그린다.
 */
export function openFolderWindow(path: string): void {
  const id = folderWindowId(path);
  const docs = readDocs();
  docs[id] = { projectId: "", path, folder: path };
  const keys = Object.keys(docs);
  const kept =
    keys.length > DOC_MAX
      ? Object.fromEntries(keys.slice(-DOC_MAX).map((k) => [k, docs[k]]))
      : docs;
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(kept));
  } catch {
    /* 용량 초과 — 창은 그래도 띄운다(대상을 못 찾으면 그 창이 안내한다) */
  }
  // 파일 뷰어(900×760)보다 넓게 — 썸네일 그리드가 한 줄에 여러 장 들어가야 쓸 만하다.
  // Rust 가 420..3000 으로 클램프한다.
  void invoke("open_doc_window", {
    docId: id,
    title: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    origin: window.location.origin,
    size: [1100, 760],
  }).catch((e) => {
    console.error("폴더 창 생성 실패:", e);
  });
}
