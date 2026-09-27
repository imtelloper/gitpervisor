import { currentMessages } from "../i18n/ui-language";
import { useUi } from "../stores/ui";
import { errorMessage, ipc } from "./ipc";
import type { LaunchSpec } from "./terminal";

// "OpenCode 세션으로 새 터미널" — 사용자 설치 없이 앱이 받은 OpenCode(commands/opencode.rs)를 띄운다.
// 모델은 정하지 않는다: 인증이 없으면 OpenCode가 무료 모델만 남겨 바로 쓴다. 대신 코드가 외부로
// 나가므로 **첫 다운로드 전에** 그 사실을 알리고 확인을 받는다(다운로드 동의를 겸한다).

/** 준비 중 중복 클릭 — 같은 확인창·토스트가 겹쳐 뜨지 않게 진행 중인 약속을 공유한다. */
let pending: Promise<LaunchSpec | null> | null = null;

function confirmFirstUse(sizeBytes: number, localModel: boolean): Promise<boolean> {
  const mb = Math.max(1, Math.round(sizeBytes / (1024 * 1024)));
  return new Promise((resolve) => {
    const t = currentMessages().lib.openCode;
    const req = {
      title: t.firstRunTitle,
      // 로컬 모델이면 "코드가 외부로 나간다" 경고가 사실이 아니다 — 문구를 가른다.
      message: localModel ? t.firstRunMessageLocal(mb) : t.firstRunMessage(mb),
      confirmLabel: t.firstRunConfirm,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    };
    useUi.getState().askConfirm(req);
    // 다른 확인창이 이 창을 **대체**하면(askConfirm은 덮어쓴다) onCancel이 불리지 않는다 — 그대로면
    // `pending`이 영영 안 풀려 이 메뉴가 재시작 전까지 죽는다. 사라지면 취소로 친다. 확인·취소
    // 콜백은 창을 닫기 **전에** 불리므로(ConfirmDialog) 먼저 정해진 결과가 이긴다.
    const unsub = useUi.subscribe((s) => {
      if (s.confirm !== req) {
        unsub();
        resolve(false);
      }
    });
  });
}

async function prepare(): Promise<LaunchSpec | null> {
  const { pushToast, updateToast, dismissToast } = useUi.getState();
  const t = currentMessages().lib.openCode;
  let status;
  try {
    status = await ipc.opencodeStatus();
  } catch (e) {
    pushToast("error", t.statusFailed(errorMessage(e)));
    return null;
  }
  if (!status.supported) {
    pushToast("error", t.unsupportedPlatform);
    return null;
  }
  if (!status.installed && !(await confirmFirstUse(status.downloadSize, status.localModel))) return null;

  // 이미 설치돼 있으면 설정 파일만 쓰고 곧장 돌아온다 — 그때는 토스트를 띄우지 않는다.
  const toastId = status.installed
    ? null
    : pushToast("info", t.downloading, undefined, { durationMs: null });
  try {
    const launch = await ipc.opencodeEnsure((p) => {
      if (toastId == null) return;
      if (p.phase === "download" && p.percent != null)
        updateToast(toastId, t.downloadingPercent(p.percent));
      else if (p.phase === "verify") updateToast(toastId, t.verifying);
      else if (p.phase === "extract") updateToast(toastId, t.installing);
    });
    return { exe: launch.exe, env: { OPENCODE_CONFIG: launch.config } };
  } catch (e) {
    pushToast("error", t.prepareFailed(errorMessage(e)));
    return null;
  } finally {
    if (toastId != null) dismissToast(toastId);
  }
}

/** 실행 정보를 준비한다(필요하면 안내·다운로드). 취소·실패면 null — 호출자는 터미널을 열지 않는다. */
export function prepareOpenCode(): Promise<LaunchSpec | null> {
  pending ??= prepare().finally(() => {
    pending = null;
  });
  return pending;
}
