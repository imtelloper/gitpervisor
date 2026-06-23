import { ShieldAlert } from "lucide-react";

import { statusColor } from "../../lib/method-color";
import { usePanelWidth } from "../../lib/use-panel-width";
import type { ApiResponse } from "../../stores/apiclient";
import { useApiClient } from "../../stores/apiclient";
import { ResizeHandle } from "../common/ResizeHandle";
import { KeyValueEditor } from "./KeyValueEditor";
import { MonacoBox } from "./MonacoBox";

type BodyFmt = "pretty" | "raw" | "preview";

/** 바이트 → 사람이 읽는 크기. */
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** contentType → monaco language. */
function langOf(ct: string | null): string {
  if (!ct) return "plaintext";
  if (/json/i.test(ct)) return "json";
  if (/html|xml/i.test(ct)) return "xml";
  if (/javascript/i.test(ct)) return "javascript";
  if (/css/i.test(ct)) return "css";
  return "plaintext";
}

/** pretty-print JSON(실패 시 원문). */
function prettyJson(text: string, ct: string | null): string {
  if (!ct || !/json/i.test(ct)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 응답 패널(§8.5) — 우측 패널(usePanelWidth side="left").
 * StatusBar(상태색/ms/KB) + 서브탭(Body/Headers/Cookies) + Body 뷰토글(Pretty/Raw/Preview).
 */
export function ResponsePanel({ tabId }: { tabId: string }) {
  const response = useApiClient((s) => s.responses[tabId]);
  const sending = useApiClient((s) => s.sending[tabId] ?? false);
  const view = useApiClient((s) => s.items[tabId]?.responseView ?? "body");
  const setResponseView = useApiClient((s) => s.setResponseView);
  const bodyFmt = useApiClient((s) => s.items[tabId]?.bodyFmt ?? "pretty");
  const setBodyFmt = useApiClient((s) => s.setBodyFmt);
  const { width, startResize } = usePanelWidth(
    "gp:apiclient-response-width",
    480,
    320,
    900,
    "left",
  );

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-edge bg-base"
    >
      <ResizeHandle onMouseDown={startResize} side="left" />

      <StatusBar response={response} sending={sending} />

      {sending && (
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-dim">
          요청 전송 중…
        </div>
      )}

      {!sending && !response && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-fg-dim">
          Send를 눌러 요청을 보내세요
        </div>
      )}

      {!sending && response && response.error && response.status === 0 && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-danger">
          {response.error}
        </div>
      )}

      {!sending && response && !(response.error && response.status === 0) && (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-xs">
            <SubTab
              active={view === "body"}
              label="Body"
              onClick={() => setResponseView(tabId, "body")}
            />
            <SubTab
              active={view === "headers"}
              label="Headers"
              count={response.headers.length}
              onClick={() => setResponseView(tabId, "headers")}
            />
            <SubTab
              active={view === "cookies"}
              label="Cookies"
              count={response.cookies.length}
              onClick={() => setResponseView(tabId, "cookies")}
            />
            {view === "body" && (
              <div className="ml-auto flex items-center gap-1">
                {(["pretty", "raw", "preview"] as BodyFmt[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setBodyFmt(tabId, f)}
                    className={`rounded px-1.5 py-0.5 text-[11px] capitalize ${
                      bodyFmt === f
                        ? "bg-raised text-fg"
                        : "text-fg-muted hover:bg-raised/60 hover:text-fg"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {view === "headers" && (
              <KeyValueEditor rows={response.headers} readOnly />
            )}
            {view === "cookies" && (
              <KeyValueEditor rows={response.cookies} readOnly />
            )}
            {view === "body" && <BodyView response={response} fmt={bodyFmt} />}
          </div>
        </>
      )}
    </aside>
  );
}

function StatusBar({
  response,
  sending,
}: {
  response: ApiResponse | undefined;
  sending: boolean;
}) {
  if (sending)
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] text-fg-dim">
        전송 중…
      </div>
    );
  if (!response)
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] text-fg-dim">
        응답 없음
      </div>
    );
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] text-fg-dim">
      <span
        className={`shrink-0 rounded px-1 text-[10px] leading-4 ${statusColor(
          response.status,
        )}`}
      >
        {response.status === 0
          ? "ERR"
          : `${response.status} ${response.statusText}`}
      </span>
      <span>{Math.round(response.durationMs)}ms</span>
      <span>{fmtSize(response.sizeBytes)}</span>
      {response.remoteAddr && (
        <span className="text-fg-dim" title="실제 접속 IP:port">
          {response.remoteAddr}
        </span>
      )}
      {response.truncated && (
        <span className="text-warn" title="maxBodyBytes 초과로 본문이 잘렸습니다">
          잘림
        </span>
      )}
      {!response.verifyTls && (
        <span
          className="flex items-center gap-0.5 text-warn"
          title="TLS 인증서 검증이 꺼진 채로 요청되었습니다"
        >
          <ShieldAlert size={11} /> TLS 검증 꺼짐
        </span>
      )}
      {response.redirects.length > 0 && (
        <span className="text-mod" title="리다이렉트 hop 수">
          ↪ {response.redirects.length}
        </span>
      )}
    </div>
  );
}

function SubTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-1 ${
        active
          ? "bg-raised text-fg"
          : "text-fg-muted hover:bg-raised/60 hover:text-fg"
      }`}
    >
      {label}
      {count != null && count > 0 && (
        <span className="rounded bg-accent/20 px-1 text-[10px] leading-4 text-accent">
          {count}
        </span>
      )}
    </button>
  );
}

function BodyView({
  response,
  fmt,
}: {
  response: ApiResponse;
  fmt: BodyFmt;
}) {
  const ct = response.contentType;

  if (fmt === "preview") {
    if (ct && /^image\//i.test(ct)) {
      return (
        <div className="flex h-full items-center justify-center p-3">
          <img
            src={`data:${ct};base64,${response.bodyBase64}`}
            alt="응답 미리보기"
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }
    if (ct && /html/i.test(ct)) {
      return (
        <iframe
          title="응답 미리보기"
          sandbox=""
          srcDoc={response.bodyText}
          className="h-full w-full border-0 bg-white"
        />
      );
    }
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-fg-dim">
        이 콘텐츠 타입은 미리보기를 지원하지 않습니다 ({ct ?? "unknown"})
      </div>
    );
  }

  if (fmt === "raw") {
    return (
      <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] text-fg">
        {response.bodyText || "(본문 없음 또는 바이너리)"}
      </pre>
    );
  }

  // pretty — monaco read-only
  if (!response.bodyText) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-fg-dim">
        텍스트 본문 없음 (바이너리는 Preview 탭에서 확인)
      </div>
    );
  }
  return (
    <MonacoBox
      readOnly
      language={langOf(ct)}
      value={prettyJson(response.bodyText, ct)}
    />
  );
}
