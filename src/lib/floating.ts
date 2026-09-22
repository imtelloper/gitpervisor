import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { currentMessages } from "../i18n/ui-language";
import { isPdf } from "./language-map";

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
  /**
   * 있으면 이 창은 파일도 폴더도 아닌 **작업 리포트 뷰**를 띄운다(태스크 67).
   * `projectId` 는 빈 문자열이고 `path` 는 창 안 제목용 문자열이다.
   * `edit`·`folder` 와 같은 이유로 **옵셔널이어야 한다** — 이 필드 이전에 적힌 항목이 남아 있다.
   */
  report?: true;
  /**
   * 있으면 이 창은 그 프로젝트의 **git 로그 뷰**를 띄운다(사이드바 프로젝트 우클릭 → git log).
   * 값은 그 프로젝트 id 이고 `projectId` 에도 같은 값이 들어간다(창 안 쿼리가 그걸 읽는다).
   * `path` 는 창 제목용 프로젝트 이름이다.
   * 위 필드들과 같은 이유로 **옵셔널이어야 한다** — 이 필드 이전에 적힌 항목이 남아 있다.
   */
  log?: string;
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
    // PDF는 크기를 안 주는 호출부(트리·탭 우클릭)도 넓게 — 900×760에선 A4 한 쪽이 너무 작다.
    size: opts?.size ?? (isPdf(path) ? [1180, 860] : undefined),
  }).catch((e) => {
    console.error("문서 창 생성 실패:", e);
  });
}

/** 이 창이 띄울 대상 — main.tsx가 라벨(`doc-<id>`)에서 뽑은 id로 부른다. */
export function docTarget(id: string): DocTarget | null {
  return readDocs()[id] ?? null;
}

/** 문자열 → 16자 hex. **결정적이어야 한다** — 폴더 창은 이 값이 곧 창 id 라, 같은 폴더를 다시
 *  누르면 같은 라벨(`doc-<id>`)이 나와야 Rust 가 새 창 대신 기존 창에 포커스만 준다
 *  (lib.rs open_doc_window 의 싱글턴 분기). crypto.randomUUID 를 쓰면 누를 때마다 창이 하나씩 늘어난다.
 *  FNV-1a 32bit 를 정·역방향으로 두 번 돌려 16자를 만든다 — 라벨 문자 집합(영숫자·`-`)에 맞고,
 *  충돌해도 결과는 "다른 폴더가 같은 창을 쓴다"가 아니라 그냥 그 창이 재사용될 뿐이다
 *  (창이 뜬 뒤 실제로 무엇을 여는지는 localStorage 의 항목이 정한다 — 그건 매번 덮어쓴다).
 *  리포트 종합 카드의 저장 키(`lib/report.ts scopeKey`)도 같은 해시를 쓴다(태스크 67). */
export function fnv16(s: string): string {
  const fnv = (v: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < v.length; i++) {
      h ^= v.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const rev = s.split("").reverse().join("");
  return fnv(s) + fnv(rev);
}

/**
 * 즐겨찾기 폴더를 **별도 OS 창**으로 연다(태스크 66).
 *
 * 파일 뷰어 창(`doc-*`)의 인프라를 그대로 탄다 — 새 라벨도, 새 캡처빌리티도, 새 창 커맨드도
 * 필요 없다. 차이는 localStorage 에 적는 항목에 `folder` 가 있다는 것뿐이고, `DocWindow` 가
 * 그걸 보고 뷰어 대신 `FolderWindow` 를 그린다.
 */
export function openFolderWindow(path: string): void {
  const id = fnv16(path);
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

/**
 * 작업 리포트를 **별도 OS 창**으로 연다(타이틀바 [리포트] 우클릭 → 새 창으로 열기, 태스크 67).
 *
 * 폴더 창(66)과 같은 `doc-*` 경로를 그대로 탄다 — Rust 변경이 없다. 다른 점은 id 가 **고정
 * 문자열**이라는 것뿐이다: 라벨이 `doc-report` 하나뿐이라 두 번 눌러도 Rust 가 기존 창에 포커스만
 * 준다(lib.rs open_doc_window 의 싱글턴 분기). 리포트는 읽기 데이터라 창이 하나면 충분하다.
 */
export function openReportWindow(): void {
  const docs = readDocs();
  const title = currentMessages().lib.reportWindowTitle;
  docs["report"] = { projectId: "", path: title, report: true };
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
  // 카드 + 우측 채팅 패널(§3.2)이 함께 들어가는 창이라 폴더 창보다 넓게 연다.
  // Rust 가 420..3000 으로 클램프한다.
  void invoke("open_doc_window", {
    docId: "report",
    title,
    origin: window.location.origin,
    size: [1240, 820],
  }).catch((e) => {
    console.error("리포트 창 생성 실패:", e);
  });
}

/**
 * 프로젝트의 git 로그를 **별도 OS 창**으로 연다(사이드바 프로젝트 우클릭 → git log).
 *
 * 폴더·리포트 창과 같은 `doc-*` 경로다 — Rust·캡처빌리티 변경이 없다. id 는 프로젝트마다
 * 결정적(`fnv16("log:"+projectId)`)이라 **프로젝트당 창 하나**이고, 다시 누르면 Rust 싱글턴
 * 분기가 기존 창에 포커스만 준다. 리포트처럼 고정 id 를 쓰면 다른 프로젝트를 열 때 한 창이
 * 재사용돼 "옛 프로젝트 로그가 그 창에 덮인다".
 */
export function openLogWindow(projectId: string, name: string): void {
  const id = fnv16(`log:${projectId}`);
  const docs = readDocs();
  docs[id] = { projectId, path: name, log: projectId };
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
  // 브랜치 | 커밋 목록 | 상세 | diff 4단이라 리포트 창과 같은 폭으로 연다(Rust 가 420..3000 클램프).
  void invoke("open_doc_window", {
    docId: id,
    title: `${name} — git log`,
    origin: window.location.origin,
    size: [1240, 820],
  }).catch((e) => {
    console.error("로그 창 생성 실패:", e);
  });
}
