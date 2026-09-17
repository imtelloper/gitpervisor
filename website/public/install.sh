#!/bin/bash
# Gitpervisor installer for macOS
#
#   curl -fsSL https://gitpervisor.aickyway.com/install.sh | bash
#
# Release builds aren't Apple-notarized, so a .dmg downloaded through a browser
# carries com.apple.quarantine and Gatekeeper blocks the first launch (macOS 15+
# removed the right-click → Open bypass). curl doesn't set that attribute, so an
# app installed by this script opens with a plain double-click.
#
# It installs the exact bundle the in-app updater uses — the darwin entry of the
# release's latest.json — not a separate build.
#
# GITPERVISOR_INSTALL_DIR overrides the destination (default: /Applications,
# or ~/Applications when /Applications isn't writable).

set -euo pipefail

REPO="imtelloper/gitpervisor"
MANIFEST_URL="https://github.com/$REPO/releases/latest/download/latest.json"
APP_NAME="Gitpervisor.app"

fail() {
  printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2
  exit 1
}

# Everything runs inside main, called on the last line: if the download of this
# script is cut off mid-pipe, bash never executes a half-written installer.
main() {
  [ "$(uname -s)" = "Darwin" ] ||
    fail "This installer is for macOS. Other platforms: https://github.com/$REPO/releases/latest"

  local key
  case "$(uname -m)" in
    arm64) key="darwin-aarch64" ;;
    x86_64) key="darwin-x86_64" ;;
    *) fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  local dest_dir="${GITPERVISOR_INSTALL_DIR:-/Applications}"
  dest_dir="${dest_dir%/}"
  if [ -z "${GITPERVISOR_INSTALL_DIR:-}" ] && [ ! -w "$dest_dir" ]; then
    dest_dir="$HOME/Applications"
  fi
  mkdir -p "$dest_dir"
  local dest="$dest_dir/$APP_NAME"

  # Swapping the bundle out from under a running app breaks it — the updater in
  # Settings › Updates is the way to update while it's open.
  if ps -Axo comm= | grep -qxF "$dest/Contents/MacOS/gitpervisor"; then
    fail "Gitpervisor is running from $dest. Quit it first (or update from Settings › Updates)."
  fi

  local tmp
  tmp="$(mktemp -d -t gitpervisor-install)"
  # shellcheck disable=SC2064  # expand now: $tmp is local and gone by EXIT
  trap "rm -rf '$tmp'" EXIT

  curl -fsSL "$MANIFEST_URL" -o "$tmp/latest.json" ||
    fail "Couldn't fetch the release manifest from GitHub."

  # plutil reads JSON; the `raw` format needs macOS 12+.
  local version url
  version="$(plutil -extract version raw -o - "$tmp/latest.json" 2>/dev/null)" ||
    fail "Couldn't read the release manifest (macOS 12 or later is required). Download the .dmg instead: https://github.com/$REPO/releases/latest"
  url="$(plutil -extract "platforms.$key.url" raw -o - "$tmp/latest.json" 2>/dev/null)" ||
    fail "The latest release ($version) has no macOS build."

  # Only ever fetch an app archive from this repo's own releases.
  case "$url" in
    "https://github.com/$REPO/releases/download/"*.app.tar.gz) ;;
    *) fail "Unexpected download URL in the manifest: $url" ;;
  esac

  printf '\033[1m▶ Downloading Gitpervisor %s\033[0m\n' "$version"
  curl -fL --progress-bar "$url" -o "$tmp/app.tar.gz" || fail "Download failed: $url"

  mkdir "$tmp/extract"
  tar -xzf "$tmp/app.tar.gz" -C "$tmp/extract" || fail "Couldn't extract the downloaded archive."
  local new_app="$tmp/extract/$APP_NAME"
  [ -x "$new_app/Contents/MacOS/gitpervisor" ] ||
    fail "The downloaded archive doesn't contain $APP_NAME."

  # curl doesn't quarantine, but a quarantining parent process could still pass
  # the flag down — clear it so the first launch is a plain double-click.
  xattr -dr com.apple.quarantine "$new_app" 2>/dev/null || true

  printf '\033[1m▶ Installing to %s\033[0m\n' "$dest"
  # Rename the old bundle aside within the same folder, so a failed move can put
  # it back instead of leaving no app at all.
  local old=""
  if [ -e "$dest" ]; then
    old="$dest_dir/.Gitpervisor.app.replaced-$$"
    mv "$dest" "$old" || fail "Couldn't replace $dest (permission denied?)."
  fi
  if ! mv "$new_app" "$dest"; then
    [ -n "$old" ] && mv "$old" "$dest"
    fail "Couldn't install into $dest_dir."
  fi
  if [ -n "$old" ]; then
    rm -rf "$old" 2>/dev/null || printf 'note: leftover old copy at %s\n' "$old"
  fi

  printf '\033[32m✓ Gitpervisor %s installed.\033[0m From now on, open it from Launchpad, Spotlight or Finder.\n' "$version"
  open "$dest" 2>/dev/null || true
}

main "$@"
