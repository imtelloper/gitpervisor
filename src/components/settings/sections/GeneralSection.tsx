// 일반 설정 (태스크 18) — 원격 새로고침·확인 다이얼로그·git 경로. gitCheck 상태는 자체 쿼리.
import { useGitCheck } from "../../../queries";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function GeneralSection({ form, update, hl }: SectionProps) {
  const { data: gitCheck } = useGitCheck();
  return (
    <>
      <Hl id="remoteRefreshMinutes" hl={hl}>
        <Field
          label="원격 새로고침 주기 (분)"
          hint="0 = 끔 · 기본 5분. 배경 fetch로 pull 받을 커밋(↓)을 자동 감지합니다"
        >
          <input
            type="number"
            min={0}
            value={form.remoteRefreshMinutes}
            onChange={(e) => update("remoteRefreshMinutes", Number(e.target.value))}
            className={inputCls}
          />
        </Field>
      </Hl>

      <Hl id="confirmDiscard" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.confirmDiscard}
            onChange={(e) => update("confirmDiscard", e.target.checked)}
            className="accent-accent"
          />
          <span>변경 되돌리기·파일 삭제 전 확인 다이얼로그</span>
        </label>
      </Hl>

      <Hl id="gitPath" hl={hl}>
        <Field label="git 실행 파일 경로" hint="비우면 PATH에서 자동 탐색 (변경은 다음 git 작업부터 적용)">
          <input
            type="text"
            value={form.gitPath ?? ""}
            placeholder="(자동 탐색)"
            onChange={(e) => update("gitPath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <div className="text-[11px] text-fg-dim">
        현재:{" "}
        {gitCheck?.found ? (
          <span className="font-mono text-fg-muted">
            {gitCheck.path} · {gitCheck.version}
          </span>
        ) : (
          <span className="text-danger">git을 찾지 못함</span>
        )}
      </div>
    </>
  );
}
