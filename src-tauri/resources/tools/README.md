# 번들 도구 (ruff / biome)

이 폴더의 실행 파일은 **앱에 번들되는 포매터/린터 폴백**입니다. 사용자·프로젝트에 도구가
있으면 러너가 그걸 먼저 쓰고(발견 우선 — PATH/venv/node_modules), **아무것도 없을 때만
여기 번들된 것을 씁니다**(`src-tauri/src/tools/runner.rs` `discover` ④ 폴백).

## 바이너리는 git에 커밋하지 않습니다

용량이 커서(ruff ~31MB, biome ~77MB) `.gitignore` 되어 있습니다. 재현은 스크립트로:

```
npm run fetch-tools           # 현재 플랫폼의 ruff + biome 다운로드
npm run fetch-tools -- ruff   # ruff만
```

버전은 `scripts/fetch-tools.mjs`에 고정(pin)되어 있습니다(ruff·biome 버전). 번들 버전을
명시해야 프로젝트 CI와의 스타일 드리프트를 통제할 수 있습니다.

## 릴리스 절차

`npm run tauri build` **전에** `npm run fetch-tools`를 실행해 이 폴더를 채워야 합니다
(그래야 `tauri.conf.json`의 `bundle.resources`가 설치파일에 포함). 크로스 플랫폼 빌드는
각 플랫폼에서 그 플랫폼 바이너리를 받아 빌드하세요.

## 파일

- `ruff.exe` / `ruff` — 파이썬 포맷·린트 (astral-sh/ruff)
- `biome.exe` / `biome` — ts/js/json/css 포맷·린트 (biomejs/biome)
