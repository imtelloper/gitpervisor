# 다국어 용어집 (한국어 → 영어)

> DOCS/i18n-design.md §7. 번역은 **이 표를 따른다** — 도메인마다 따로 번역하면 같은 기능이 화면마다 다른
> 이름으로 불린다(가장 흔한 실패). 새 용어가 생기면 번역보다 먼저 여기 한 줄을 더한다.
> TS 카탈로그(`src/i18n/text-*.ts`)와 Rust 문구(`i18n.rs` 계열)가 같은 표를 쓴다.

## 1. 앱 고유 기능

| 한국어 | 영어 | 뜻·주의 |
|---|---|---|
| 모아보기 | Aggregate view | 여러 프로젝트의 터미널을 한 화면에 모은 벽 |
| 모아보기 창 (float 모드) | Aggregate window | 모아보기를 별도 OS 창으로 띄운 것. 플로팅 터미널 창과 다르다 |
| 패널 분리 / 분리된 터미널 | Pop out / Floating terminal | 터미널 하나를 새 OS 창으로 떼는 것. 되돌리기는 "Dock back" |
| 탭 모으기 | Group by project | 모아보기 칩 바의 프로젝트 묶음 토글 |
| 자동배치 | Auto layout | 모아보기 셀을 고르게 배치 |
| 히스토리(프롬프트 컬럼) | Prompt history | 터미널 옆 프롬프트 기록 컬럼 |
| 메모장 | Notes | 타이틀바 전역 메모. 프로젝트 메모는 "Project notes" |
| 잔디 | Activity heatmap | GitHub식 날짜별 활동 칸 |
| 리포트 | Report | 작업 리포트 화면 |
| 요약 / 종합 카드 | Summary / Combined summary | 여러 프로젝트를 한 카드로 요약한 것이 종합 |
| 일간 · 주간 · 월간 | Daily · Weekly · Monthly | |
| 즐겨찾기 폴더 | Favorite folders | 타이틀바 [폴더] |
| 리소스 모니터 | Resource monitor | |
| 화면 캡쳐 | Screen capture | |
| 뷰어 / 편집기 | Viewer / Editor | |
| 워크스페이스 | Workspace | 프로젝트를 고르면 보이는 탭 영역 |
| 로컬 LLM · AI | Local LLM · AI | 모델 이름은 번역하지 않는다 |
| 메모리 경보 | Memory alert | health 배너 |

## 1-1. 영상·자막 (태스크 72)

| 한국어 | 영어 | 뜻·주의 |
|---|---|---|
| 자막 / 자막 줄 | Captions / Caption line | 컨테이너 트랙을 말할 때만 "subtitle track" |
| 자막 만들기 | Generate captions | |
| 음성 인식 | Speech recognition | 설정 경로는 "Settings › AI › Speech recognition" |
| 다시 인식 | Re-transcribe | |
| 대본 / 대본 편집본 | Transcript / Transcript edit | |
| 원본 시각 / 편집본 시각 | Source timing / Transcript edit timing | |
| 자막 입힌 영상 | Captioned video | |
| 번인 / 소프트 자막 | Burn-in / Soft captions | |
| 무음 줄이기 | Silence trimming | |
| 쉼 · 추임새 | Pause · Fillers | |
| 번역 자막 | Translated captions | |
| 용어 힌트 | Vocabulary hint | |
| 자막 문서 | Caption document | |
| 설정 › 코드 도구 | Settings › Code tools | |

## 2. Git — Git 공식 영어를 따른다

| 한국어 | 영어 |
|---|---|
| 변경 | Changes |
| 스테이지 · 스테이지 해제 | Stage · Unstage |
| 되돌리기 · 롤백 | Discard |
| 추적 안 됨 | Untracked |
| 충돌 | Conflicts |
| 커밋 · 커밋 수정 | Commit · Amend |
| 푸시 · 풀 · 페치 | Push · Pull · Fetch |
| 원격 새로고침 | Remote refresh (배경 fetch) |
| 브랜치 · 원격 브랜치 | Branch · Remote branch |
| 중첩(임베디드) 저장소 | Nested repository |
| 히스토리(git 로그) | History |

## 3. 문체 규칙

- 버튼·메뉴: 동사 원형, 첫 글자만 대문자 — `Save`, `Discard changes`, `Open in new window`.
- 제목·필드 라벨: 명사구, 첫 글자만 대문자 — `Remote refresh interval`.
- 확인 대화상자: 질문형 + 결과 — `Discard changes to 'a.ts'? This cannot be undone.`
- 마침표는 완결 문장에만. 버튼·라벨에는 찍지 않는다.
- 숫자·용량·날짜는 카탈로그 문자열에 박지 말고 형식 헬퍼로(`fmtInt` 등, 설계 §4.2).
- 한국어 "~합니다/~하세요" 체의 안내문은 영어에서 명령형으로 줄인다 — `Set it up in Settings › AI`.
