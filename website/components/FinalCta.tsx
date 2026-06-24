import { type ReleaseInfo } from "@/lib/github";
import { DownloadCta } from "@/components/DownloadButtons";

export function FinalCta({ release }: { release: ReleaseInfo | null }) {
  return (
    <section id="download" className="relative scroll-mt-20 overflow-hidden px-6 py-28">
      <div className="glow-accent pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 opacity-50" />
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Ready to take control?
        </h2>
        <p className="mt-4 text-muted">
          Download Gitpervisor for free. No sign-up required.
        </p>
        <div className="mt-9">
          <DownloadCta release={release} />
        </div>
      </div>
    </section>
  );
}
