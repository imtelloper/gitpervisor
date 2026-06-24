import { Sparkles } from "lucide-react";
import type { ReleaseInfo } from "@/lib/github";
import { DownloadButtons } from "@/components/DownloadButtons";
import { AppMockup } from "@/components/AppMockup";

export function Hero({ release }: { release: ReleaseInfo | null }) {
  const version = release?.version;

  return (
    <section className="relative overflow-hidden px-6 pb-16 pt-28 sm:pt-32">
      {/* background: grid + brand glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-grid bg-grid-fade absolute inset-0" />
        <div className="glow-accent absolute left-1/2 top-[-6rem] h-[36rem] w-[36rem] -translate-x-1/2 opacity-60" />
        <div className="glow-cyan absolute right-[-8rem] top-40 h-[28rem] w-[28rem] opacity-40" />
      </div>

      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        {/* badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-card/60 px-3.5 py-1.5 text-xs text-muted backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          <span className="font-mono">
            {version ? `${version}  ·  ` : ""}Free &amp; Open Source  ·  MIT License
          </span>
        </div>

        {/* headline */}
        <h1 className="font-display text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
          Your AI Coding
          <br />
          <span className="text-gradient">Command Center</span>
        </h1>

        {/* subtitle */}
        <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted">
          Manage multiple Git projects, supervise AI agents like Claude in real
          time, and monitor everything from one open-source desktop app.
        </p>

        {/* downloads */}
        <div className="mt-9">
          <DownloadButtons release={release} />
        </div>
      </div>

      {/* product mockup */}
      <div className="mx-auto mt-16 max-w-5xl">
        <AppMockup />
      </div>
    </section>
  );
}
