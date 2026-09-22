// 일반 설정 (태스크 18) — 원격 새로고침·확인 다이얼로그·git 경로. gitCheck 상태는 자체 쿼리.
import { useMessages } from "../../../i18n/ui-language";
import { useGitCheck } from "../../../queries";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function GeneralSection({ form, update, hl }: SectionProps) {
  const { data: gitCheck } = useGitCheck();
  const msg = useMessages();
  return (
    <>
      <Hl id="uiLanguage" hl={hl}>
        <Field label={msg.language.fieldLabel} hint={msg.language.fieldHint}>
          <select
            data-gpv="settings-ui-language"
            value={form.uiLanguage}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "system" || v === "ko" || v === "en") update("uiLanguage", v);
            }}
            className={inputCls}
          >
            <option value="system">{msg.language.optionSystem}</option>
            <option value="ko">{msg.language.optionKorean}</option>
            <option value="en">{msg.language.optionEnglish}</option>
          </select>
        </Field>
      </Hl>

      <Hl id="remoteRefreshMinutes" hl={hl}>
        <Field
          label={msg.settings.general.remoteRefreshLabel}
          hint={msg.settings.general.remoteRefreshHint}
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
          label={msg.settings.general.favoriteFoldersLabel}
          hint={msg.settings.general.favoriteFoldersHint}
        >
          <div className="text-fg-muted">
            {form.favoriteFolders?.length
              ? form.favoriteFolders.map((f) => f.name).join(" · ")
              : msg.settings.general.favoriteFoldersNone}
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
          <span>{msg.settings.general.confirmDiscard}</span>
        </label>
      </Hl>

      <Hl id="gitPath" hl={hl}>
        <Field label={msg.settings.general.gitPathLabel} hint={msg.settings.general.gitPathHint}>
          <input
            type="text"
            value={form.gitPath ?? ""}
            placeholder={msg.settings.autoDetectPlaceholder}
            onChange={(e) => update("gitPath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <div className="text-[11px] text-fg-dim">
        {msg.settings.general.gitCurrent}{" "}
        {gitCheck?.found ? (
          <span className="font-mono text-fg-muted">
            {gitCheck.path} · {gitCheck.version}
          </span>
        ) : (
          <span className="text-danger">{msg.settings.general.gitNotFound}</span>
        )}
      </div>
    </>
  );
}
