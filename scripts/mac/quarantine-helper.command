#!/bin/bash
# Gitpervisor 처음 실행 도우미
# macOS Gatekeeper의 격리 속성(com.apple.quarantine)을 해제하고 앱을 실행합니다.
# 미서명 앱은 격리 속성 때문에 첫 실행이 차단되는데, 이 스크립트가 그걸 풀어줍니다.
# 한 번만 실행하면 그 다음부터는 평소처럼 Spotlight/Launchpad/Finder로 실행됩니다.

set -e

APP="/Applications/Gitpervisor.app"

cat <<'EOF'

╔══════════════════════════════════════════════════════════════╗
║              Gitpervisor 첫 실행 도우미                      ║
║   macOS 격리 속성을 해제해 첫 실행 차단을 우회합니다.        ║
╚══════════════════════════════════════════════════════════════╝

EOF

if [ ! -d "$APP" ]; then
  echo "❌ $APP 을 찾을 수 없습니다."
  echo ""
  echo "   먼저 DMG 창에서 Gitpervisor 아이콘을 왼쪽의 Applications 폴더로"
  echo "   드래그한 다음, 이 파일을 다시 더블클릭해주세요."
  echo ""
  echo "   (창을 닫으려면 엔터)"
  read _
  exit 1
fi

echo "🔓 격리 속성 제거 중…"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "🚀 Gitpervisor 실행 중…"
open "$APP"

cat <<'EOF'

✅ 완료!

   이제 Spotlight(Cmd+Space) 또는 Launchpad / Applications 폴더에서
   Gitpervisor를 평소처럼 더블클릭으로 실행하실 수 있습니다.
   이 도우미는 다시 실행하실 필요 없습니다.

   (이 창은 닫아도 됩니다)

EOF
sleep 3
