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

      {/* 즐겨찾기 폴더는 **타이틀바 [폴더] 드롭다운이 관리 UI**다(태스크 66) — 등록·삭제·이름
          바꾸기가 거기 있다. 여기에 자리를 두는 이유는 두 가지다: 설정 검색으로 이 기능을 찾을 수
          있어야 하고, `SETTINGS_INDEX` 완전성 가드(e2e 29 ⑤)가 모든 Settings 키에 항목을 요구한다. */}
      <Hl id="favoriteFolders" hl={hl}>
        <Field
          label="즐겨찾기 폴더"
          hint="타이틀바의 [폴더] 버튼에서 등록·삭제합니다. 등록한 폴더만 앱이 읽을 수 있습니다"
        >
          <div className="text-fg-muted">
            {form.favoriteFolders?.length
              ? form.favoriteFolders.map((f) => f.name).join(" · ")
              : "등록된 폴더 없음"}
          </div>
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
