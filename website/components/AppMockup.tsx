import { GitBranch, Cpu } from "lucide-react";

/* Static, decorative product mockup shown in the hero. Non-interactive. */

const PROJECTS: { name: string; active?: boolean; ai?: boolean }[] = [
  { name: "gitpervisor", active: true, ai: true },
  { name: "my-saas-app" },
  { name: "design-system" },
  { name: "api-gateway", ai: true },
  { name: "docs-site" },
];

type Line = { text: string; tone?: "prompt" | "ok" | "run" | "dim" | "muted" };

const PANE_CLAUDE: Line[] = [
  { text: "~/gitpervisor $ claude", tone: "prompt" },
  { text: "⠋ Working on task...", tone: "run" },
  { text: "Reading src/main.rs", tone: "muted" },
  { text: "Analyzing dependencies...", tone: "muted" },
  { text: "✓ Fixed import ordering", tone: "ok" },
  { text: "✓ Updated Cargo.toml", tone: "ok" },
  { text: " " },
  { text: "~/gitpervisor $ █", tone: "prompt" },
];

const PANE_DEV: Line[] = [
  { text: "~/my-saas-app $ npm run dev", tone: "prompt" },
  { text: " " },
  { text: "  VITE v5.4.0  ready in 340ms", tone: "ok" },
  { text: " " },
  { text: "  ➜  Local:   http://localhost:3000/", tone: "dim" },
  { text: "  ➜  Network: http://192.168.1.42:3000/", tone: "dim" },
  { text: " " },
  { text: "[HMR] connected", tone: "muted" },
];

const TONE: Record<NonNullable<Line["tone"]>, string> = {
  prompt: "text-ink",
  ok: "text-green",
  run: "text-cyan",
  dim: "text-accent",
  muted: "text-faint",
};

function Terminal({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-line/70 px-3 py-1.5 font-mono text-[10px] text-faint">
        {title}
      </div>
      <div className="flex-1 space-y-0.5 p-3 font-mono text-[11px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre ${l.tone ? TONE[l.tone] : "text-muted"}`}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-green/30 bg-green/10 px-1.5 py-0.5 text-[9px] font-medium text-green">
      <span className="h-1.5 w-1.5 rounded-full bg-green animate-pulse-dot" />
      AI
    </span>
  );
}

export function AppMockup() {
  return (
    <div
      aria-hidden="true"
      className="ring-gradient overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/60"
    >
      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-line bg-base/60 px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red/80" />
          <span className="h-3 w-3 rounded-full bg-yellow/80" />
          <span className="h-3 w-3 rounded-full bg-green/80" />
        </span>
        <span className="flex-1 text-center font-mono text-[11px] text-faint">
          Gitpervisor — ~/projects
        </span>
        <span className="w-12" />
      </div>

      <div className="flex h-[300px] sm:h-[340px]">
        {/* sidebar (hidden on phones to avoid crushing the terminals) */}
        <div className="hidden w-44 shrink-0 flex-col border-r border-line bg-base/40 sm:flex">
          <div className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
            Projects
          </div>
          <div className="flex-1 space-y-0.5 px-2">
            {PROJECTS.map((p) => (
              <div
                key={p.name}
                className={[
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]",
                  p.active
                    ? "bg-card-2 text-ink shadow-[inset_2px_0_0] shadow-accent"
                    : "text-muted",
                ].join(" ")}
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="flex-1 truncate font-mono">{p.name}</span>
                {p.ai && <AiBadge />}
              </div>
            ))}
          </div>

          {/* GPU monitor card */}
          <div className="m-2 rounded-lg border border-line bg-card/60 p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <Cpu className="h-3 w-3 text-cyan" />
              <span className="font-mono">GPU · RTX 4070</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan to-accent"
                style={{ width: "42%" }}
              />
            </div>
            <div className="mt-1 font-mono text-[9px] text-faint">
              42% · VRAM 4.2/12 GB
            </div>
          </div>
        </div>

        {/* main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* tabs */}
          <div className="flex items-center gap-1 border-b border-line bg-base/30 px-2 py-1.5 text-[11px]">
            <span className="rounded-md bg-card-2 px-2.5 py-1 font-medium text-ink">
              Terminal
            </span>
            <span className="px-2.5 py-1 text-faint">API Client</span>
            <span className="px-2.5 py-1 text-faint">Browser</span>
          </div>

          {/* split terminal panes (second pane hidden on small screens) */}
          <div className="flex flex-1 divide-x divide-line">
            <Terminal title="claude · src/main.rs" lines={PANE_CLAUDE} />
            <div className="hidden min-w-0 flex-1 md:flex">
              <Terminal title="dev server" lines={PANE_DEV} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
