import { invoke } from "@tauri-apps/api/core";

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
}

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
 */
export function openDocWindow(projectId: string, path: string): void {
  const id = crypto.randomUUID().replace(/-/g, "");
  const docs = readDocs();
  docs[id] = { projectId, path };
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
  void invoke("open_doc_window", {
    docId: id,
    title: path.split("/").pop() ?? path,
    origin: window.location.origin,
  }).catch((e) => {
    console.error("문서 창 생성 실패:", e);
  });
}

/** 이 창이 띄울 대상 — main.tsx가 라벨(`doc-<id>`)에서 뽑은 id로 부른다. */
export function docTarget(id: string): DocTarget | null {
  return readDocs()[id] ?? null;
}
