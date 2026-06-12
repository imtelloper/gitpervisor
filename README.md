# Gitpervisor

여러 로컬 프로젝트의 git 상태를 한 화면에서 감시하고, diff 확인 → 커밋 → 푸시까지 끝내는 멀티 레포 Git 대시보드 데스크톱 앱 (Tauri 2 + React 19).

설계 문서: [DOCS/DESIGN.md](DOCS/DESIGN.md) · UI 시안: `designs/main-screen-v2.png`

## 요구 사항

- Node.js 18+ / npm
- Rust (stable) — <https://rustup.rs>
- **git ≥ 2.35가 PATH에 존재** (앱이 시스템 git CLI를 사용)

## 개발 실행

```sh
npm install
npm run tauri dev
```

## 빌드

```sh
npm run tauri build
```

## 테스트

```sh
cd src-tauri && cargo test   # porcelain v2 파서 픽스처 테스트
npm run build                # tsc 타입체크 + vite 번들
```

## 현재 구현 범위 — M1 코어 뷰어 + M2 커밋 워크플로우

**M1 코어 뷰어**
- 프로젝트 추가/제거 + `projects.json` 영속화 (폴더 선택 → 레포 루트 자동 정규화, 중복 거부)
- 사이드바 상태 뱃지: 상태 점(초록 clean / 노랑 변경·ahead·behind / 빨강 충돌·merge 중 / 회색 오류), 브랜치, ↑↓, 변경 카운트
- Changes 패널: Conflicts / Unstaged / Staged / Untracked 그룹
- Side-by-side diff 뷰어 (Monaco, 인덱스 ↔ 워킹 트리, 변경 없는 영역 접기, 바이너리/1.5MB 가드)
- git 미설치 감지 게이트

**M2 커밋 워크플로우**
- 체크박스 스테이징 토글 (stage/unstage, unborn 브랜치 폴백 포함)
- discard: unstaged 변경 되돌리기·untracked 삭제 (확인 다이얼로그, autocrlf 안전)
- Commit / Commit and Push + Amend (메시지는 stdin 전달)
- Fetch / Pull / Push 버튼 — 진행 스트리밍(`repo://op-progress`), 업스트림 없으면 `-u` 확인, AUTH_FAILED 분류
- **notify 파일 감시 자동 갱신**: 외부 에디터 저장 → 400ms 디바운스 → 사이드바·Changes 실시간 반영
- 레포당 쓰기 작업 1개 직렬화(OP_IN_PROGRESS), 변경 커맨드는 IPC 자동 재시도 금지

다음 단계: M3 히스토리 (Log 패널, 커밋별 diff) — 로드맵은 설계 문서 §14 참조.
