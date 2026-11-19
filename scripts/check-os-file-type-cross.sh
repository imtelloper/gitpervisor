#!/usr/bin/env bash
# 폴더 창 OS 파일 유형 아이콘의 macOS·Linux 구현(src-tauri/src/commands/os_file_type_{macos,linux}.rs)을
# **이 기기에서** 대상 OS 로 형식 검사한다. 두 파일은 크레이트에 기대지 않게 써 두었으므로, 그 파일만 끌어오는 작은
# 검사 크레이트를 임시 폴더에 만들어 `cargo check --target` 한다(링크는 안 하니 SDK·GTK 라이브러리가 없어도 된다).
#   필요: rustup target add aarch64-apple-darwin x86_64-unknown-linux-gnu
#   사용: bash scripts/check-os-file-type-cross.sh
# 버전은 앱의 Cargo.lock 을 그대로 복사해 맞춘다. 실기 동작(아이콘이 실제로 그려지는가)은 각 OS 에서 봐야 한다.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
repo="$(cd "$(dirname "$0")/.." && pwd)"
src="$repo/src-tauri/src/commands"
# Windows(Git Bash)에선 rustc 가 /f/… 꼴을 못 읽는다 — C:/… 꼴로.
command -v cygpath >/dev/null && src="$(cygpath -m "$src")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

deps_macos='objc2 = "0.6"
objc2-app-kit = { version = "0.3", default-features = false, features = ["std", "NSWorkspace", "NSImage", "NSImageRep", "NSBitmapImageRep", "NSGraphics", "NSGraphicsContext", "objc2-core-foundation"] }
objc2-foundation = { version = "0.3", default-features = false, features = ["std", "NSString", "NSURL", "NSDictionary", "NSData", "NSError", "NSGeometry"] }'
deps_linux='gtk = "0.18"'

check() { # $1 = macos|linux, $2 = target, $3 = deps
  local dir="$work/$1"
  mkdir -p "$dir/src"
  printf '[package]\nname = "oscheck-%s"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\n%s\n' "$1" "$3" > "$dir/Cargo.toml"
  cp "$repo/src-tauri/Cargo.lock" "$dir/Cargo.lock"
  # 앱의 os_file_type.rs 가 주는 두 타입을 같은 꼴로 두고 플랫폼 파일을 자식 모듈로 끌어온다.
  cat > "$dir/src/main.rs" <<EOF
#![allow(dead_code)]
use std::path::PathBuf;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsTypeKind { Folder, Ext, File }
#[derive(Debug, Default)]
pub struct OsTypeFound { pub type_name: Option<String>, pub icon_png: Option<Vec<u8>> }
#[path = "$src/os_file_type_$1.rs"]
mod platform;
fn main() { let _ = platform::lookup_batch(&[(PathBuf::from("/tmp/a.pdf"), OsTypeKind::Ext)], 32); }
EOF
  echo "── $1 ($2)"
  (cd "$dir" && cargo check --quiet --target "$2")
}

check macos aarch64-apple-darwin "$deps_macos"
# GTK 의 -sys 크레이트는 빌드 스크립트에서 pkg-config 로 라이브러리를 찾는다 — 형식 검사엔 필요 없어 끈다.
for k in GTK_3_0:gtk-3 GDK_3_0:gdk-3 GDK_PIXBUF_2_0:gdk_pixbuf-2.0 GIO_2_0:gio-2.0 GLIB_2_0:glib-2.0 \
         GOBJECT_2_0:gobject-2.0 CAIRO:cairo CAIRO_GOBJECT:cairo-gobject PANGO:pango-1.0 ATK:atk-1.0; do
  export "SYSTEM_DEPS_${k%%:*}_NO_PKG_CONFIG=1" "SYSTEM_DEPS_${k%%:*}_LIB=${k#*:}"
done
check linux x86_64-unknown-linux-gnu "$deps_linux"
echo "OK — macOS·Linux 구현 형식 검사 통과"
