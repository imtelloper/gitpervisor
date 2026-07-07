// 알림 설정 (태스크 18) — OS 알림 모드 + Slack/SMTP. 시크릿은 셸 소유(빈 값=변경 안 함),
// onTest는 셸의 handleTest(선저장 후 발송). 시크릿 입력·테스트 버튼은 토글 켤 때만 조건 렌더.
import { Send } from "lucide-react";

import type { NotifySecret, Settings } from "../../../lib/ipc";
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
  return (
    <>
      <Hl id="notifyMode" hl={hl}>
        <Field
          label="AI 작업 완료 알림"
          hint="터미널의 Claude가 작업을 끝내면 OS 알림을 보냅니다. 상태바의 AI 칩을 클릭하면 해당 프로젝트로 이동합니다."
        >
          <select
            value={form.notifyMode || "project-inactive"}
            onChange={(e) => update("notifyMode", e.target.value as Settings["notifyMode"])}
            className={inputCls}
          >
            <option value="off">끔</option>
            <option value="project-inactive">프로젝트 단위 · 창이 비활성일 때만</option>
            <option value="terminal">터미널 단위로 매번</option>
            <option value="always">항상 (포커스 중에도)</option>
          </select>
        </Field>
      </Hl>

      <div className="text-[11px] leading-5 text-fg-muted">
        아래를 켜면 OS 알림에 더해 Slack·이메일로도 완료 알림을 보냅니다 — 원격에서도 작업 종료를 알 수
        있습니다(시크릿은 OS 키링에 저장).
      </div>

      <Hl id="slackEnabled" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.slackEnabled}
            onChange={(e) => update("slackEnabled", e.target.checked)}
            className="accent-accent"
          />
          <span>Slack 웹훅으로도 알림</span>
        </label>
      </Hl>
      {form.slackEnabled && (
        <div className="space-y-2 pl-6">
          <Hl id="slackSecret" hl={hl}>
            <input
              type="password"
              value={slackSecret}
              placeholder={
                slackHas ? "(저장됨 — 변경하려면 새 URL 입력)" : "https://hooks.slack.com/services/..."
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
            테스트 전송
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
          <span>이메일(SMTP)로도 알림</span>
        </label>
      </Hl>
      {form.emailEnabled && (
        <div className="space-y-2 pl-6">
          <div className="flex flex-wrap gap-2">
            <Hl id="smtpHost" hl={hl}>
              <input
                type="text"
                value={form.smtpHost ?? ""}
                placeholder="SMTP 호스트 (예: smtp.gmail.com)"
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
                title="포트 (465=암호화, 587=STARTTLS)"
              />
            </Hl>
          </div>
          <Hl id="smtpFrom" hl={hl}>
            <input
              type="text"
              value={form.smtpFrom ?? ""}
              placeholder="보내는 주소 (from)"
              onChange={(e) => update("smtpFrom", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpTo" hl={hl}>
            <input
              type="text"
              value={form.smtpTo ?? ""}
              placeholder="받는 주소 (to)"
              onChange={(e) => update("smtpTo", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpUsername" hl={hl}>
            <input
              type="text"
              value={form.smtpUsername ?? ""}
              placeholder="사용자명 (보통 from과 동일)"
              onChange={(e) => update("smtpUsername", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Hl>
          <Hl id="smtpSecret" hl={hl}>
            <input
              type="password"
              value={smtpSecret}
              placeholder={smtpHas ? "(저장됨 — 변경하려면 입력)" : "비밀번호 / 앱 비밀번호"}
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
              <span>TLS 암호화 사용 (권장)</span>
            </label>
          </Hl>
          <button
            onClick={() => onTest("smtp")}
            className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <Send size={12} />
            테스트 전송
          </button>
        </div>
      )}
    </>
  );
}
