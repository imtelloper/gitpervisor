// 레포 상대 경로(항상 `/` 구분자) 문자열 유틸 — 트리와 뷰어가 같은 규칙을 써야 해서 한 곳에 둔다.
// 파일트리가 갖고 있던 모듈 로컬 사본을 옮긴 것이다(태스크 56).

/** base 아래 name의 경로 — base가 빈 문자열(레포 루트)이면 name 그대로. */
export function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** rel 경로의 부모 디렉토리(없으면 빈 문자열=루트). */
export function parentDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}
