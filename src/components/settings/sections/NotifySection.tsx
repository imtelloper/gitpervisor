// 알림 설정 (태스크 18) — OS 알림 모드 + Slack/SMTP. 시크릿은 셸 소유(빈 값=변경 안 함),
// onTest는 셸의 handleTest(선저장 후 발송). 시크릿 입력·테스트 버튼은 토글 켤 때만 조건 렌더.
import { Send } from "lucide-react";

import { useMessages } from "../../../i18n/ui-language";
import type { NotifySecret, Settings } from "../../../lib/ipc";
import { useHealthMute } from "../../../stores/health";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export interface NotifySectionProps extends SectionProps {
  slackSecret: string;
  setSlackSecret: (v: string) => void;
  smtpSecret: string;
  setSmtpSecret: (v: string) => void;
  slackHas: boolean;
  smtpHas: boolean;
  onTest: (channel: NotifySecret) => void;
}

export function NotifySection({
  form,
  update,
  hl,
  slackSecret,
  setSlackSecret,
  smtpSecret,
  setSmtpSecret,
  slackHas,
  smtpHas,
  onTest,
}: NotifySectionProps) {
  const msg = useMessages();
  const healthMuted = useHealthMute((st) => st.muted);
  const setHealthMuted = useHealthMute((st) => st.setMuted);
  return (
    <>
      <Hl id="notifyMode" hl={hl}>
        <Field label={msg.settings.notify.modeLabel} hint={msg.settings.notify.modeHint}>
          <select
            value={form.notifyMode || "project-inactive"}
            onChange={(e) => update("notifyMode", e.target.value as Settings["notifyMode"])}
            className={inputCls}
          >
            <option value="off">{msg.settings.notify.modeOff}</option>
            <option value="project-inactive">{msg.settings.notify.modeProjectInactive}</option>
            <option value="terminal">{msg.settings.notify.modeTerminal}</option>
            <option value="always">{msg.settings.notify.modeAlways}</option>
          </select>
        </Field>
      </Hl>

      <div className="text-[11px] leading-5 text-fg-muted">{msg.settings.notify.externalIntro}</div>

      <Hl id="slackEnabled" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.slackEnabled}
            onChange={(e) => update("slackEnabled", e.target.checked)}
            className="accent-accent"
          />
          <span>{msg.settings.notify.slackEnabled}</span>
        </label>
      </Hl>
      {form.slackEnabled && (
        <div className="space-y-2 pl-6">
          <Hl id="slackSecret" hl={hl}>
            <input
              type="password"
              value={slackSecret}
              placeholder={
                slackHas
                  ? msg.settings.notify.slackSecretSaved
                  : "https://hooks.slack.com/services/..."
              }
              onChange={(e) => setSlackSecret(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <button
            onClick={() => onTest("slack")}
            className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <Send size={12} />
            {msg.settings.notify.testSend}
          </button>
        </div>
      )}

      <Hl id="emailEnabled" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.emailEnabled}
            onChange={(e) => update("emailEnabled", e.target.checked)}
            className="accent-accent"
          />
          <span>{msg.settings.notify.emailEnabled}</span>
        </label>
      </Hl>
      {form.emailEnabled && (
        <div className="space-y-2 pl-6">
          <div className="flex flex-wrap gap-2">
            <Hl id="smtpHost" hl={hl}>
              <input
                type="text"
                value={form.smtpHost ?? ""}
                placeholder={msg.settings.notify.smtpHostPlaceholder}
                onChange={(e) => update("smtpHost", e.target.value)}
                className={`${inputCls} min-w-[200px] flex-1 font-mono`}
              />
            </Hl>
            <Hl id="smtpPort" hl={hl}>
              <input
                type="number"
                value={form.smtpPort || 587}
                onChange={(e) => update("smtpPort", Number(e.target.value))}
                className={`${inputCls} w-20`}
                title={msg.settings.notify.smtpPortTitle}
              />
            </Hl>
          </div>
          <Hl id="smtpFrom" hl={hl}>
            <input
              type="text"
              value={form.smtpFrom ?? ""}
              placeholder={msg.settings.notify.smtpFromPlaceholder}
              onChange={(e) => update("smtpFrom", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpTo" hl={hl}>
            <input
              type="text"
              value={form.smtpTo ?? ""}
              placeholder={msg.settings.notify.smtpToPlaceholder}
              onChange={(e) => update("smtpTo", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpUsername" hl={hl}>
            <input
              type="text"
              value={form.smtpUsername ?? ""}
              placeholder={msg.settings.notify.smtpUsernamePlaceholder}
              onChange={(e) => update("smtpUsername", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpSecret" hl={hl}>
            <input
              type="password"
              value={smtpSecret}
              placeholder={
                smtpHas
                  ? msg.settings.notify.smtpSecretSaved
                  : msg.settings.notify.smtpSecretPlaceholder
              }
              onChange={(e) => setSmtpSecret(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpTls" hl={hl}>
            <label className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={form.smtpTls}
                onChange={(e) => update("smtpTls", e.target.checked)}
                className="accent-accent"
              />
              <span>{msg.settings.notify.smtpTls}</span>
            </label>
          </Hl>
          <button
            onClick={() => onTest("smtp")}
            className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <Send size={12} />
            {msg.settings.notify.testSend}
          </button>
        </div>
      )}

      {/* 경보 카드의 "이 알림 다시 보지 않기"를 되돌리는 유일한 자리. 백엔드 Settings가 아니라
          localStorage 토글이라 form/update가 아닌 스토어를 직접 읽는다(업데이트 자동 확인과 동일). */}
      <Hl id="healthAlert" hl={hl}>
        <div className="border-t border-edge pt-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={!healthMuted}
              onChange={(e) => setHealthMuted(!e.target.checked)}
              className="accent-accent"
            />
            <span>{msg.settings.notify.healthAlert}</span>
          </label>
          <div className="mt-1 pl-6 text-[11px] leading-5 text-fg-dim">
            {msg.settings.notify.healthAlertHint}
          </div>
        </div>
      </Hl>
    </>
  );
}
