#!/usr/bin/env bash
# tauri build 후 .app 만 추려 도우미 스크립트가 들어간 최종 DMG를 만든다.
# Tauri 기본 DMG에는 격리(quarantine) 해제 도우미를 끼울 옵션이 없어 직접 만든다.
#
# 산출물: src-tauri/target/release/bundle/dmg/Gitpervisor_<버전>_aarch64.dmg
#         (Tauri가 만든 것을 덮어쓴다)

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/Gitpervisor.app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
HELPER="$ROOT/scripts/mac/quarantine-helper.command"

# package.json에서 버전을 뽑는다 (jq 의존 회피 위해 grep+sed)
VERSION="$(grep '"version"' "$ROOT/package.json" | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ARCH_TAG="aarch64" ;;
  x86_64) ARCH_TAG="x64" ;;
  *)      ARCH_TAG="$ARCH" ;;
esac
OUT_DMG="$DMG_DIR/Gitpervisor_${VERSION}_${ARCH_TAG}.dmg"
STAGING="$(mktemp -d -t gitpervisor-dmg-staging)"
RW_DMG="$(mktemp -t gitpervisor-rw -u).dmg"

cleanup() {
  rm -rf "$STAGING"
  rm -f "$RW_DMG"
  # 혹시 마운트된 채라면 강제 해제
  hdiutil info | awk -v vol="Gitpervisor" '$1 ~ /^\/dev\/disk/ {dev=$1} /image-path/ && /rw-/ {print dev}' | xargs -I{} hdiutil detach -force {} >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -d "$APP" ]; then
  echo "❌ $APP 가 없습니다. 먼저 'npm run tauri build' 를 실행하세요." >&2
  exit 1
fi
if [ ! -x "$HELPER" ]; then
  echo "❌ 도우미 스크립트가 실행 가능하지 않습니다: $HELPER" >&2
  exit 1
fi

echo "▶ 스테이징 준비: $STAGING"
cp -R "$APP" "$STAGING/Gitpervisor.app"
cp "$HELPER" "$STAGING/처음 실행 — 격리 해제.command"
chmod +x "$STAGING/처음 실행 — 격리 해제.command"
ln -s /Applications "$STAGING/Applications"

# Finder 폴더 메타(.DS_Store) 정리 — 위치 지정은 생략(기본 그리드).
mkdir -p "$DMG_DIR"
rm -f "$OUT_DMG"

# 1) 쓰기 가능 DMG 생성
echo "▶ rw DMG 생성"
hdiutil create -volname "Gitpervisor" \
  -srcfolder "$STAGING" \
  -fs HFS+ \
  -format UDRW \
  -ov \
  "$RW_DMG" >/dev/null

# 2) 압축된 최종 DMG로 변환
echo "▶ 압축 DMG로 변환"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUT_DMG" >/dev/null

echo "✅ 완료: $OUT_DMG"
ls -lh "$OUT_DMG"
