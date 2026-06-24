import { getLatestRelease } from "@/lib/github";
import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Features } from "@/components/Features";
import { OpenSource } from "@/components/OpenSource";
import { FinalCta } from "@/components/FinalCta";
import { Footer } from "@/components/Footer";

export const revalidate = 3600;

export default async function Home() {
  const release = await getLatestRelease();

  return (
    <>
      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:border-line focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      >
        Skip to content
      </a>
      <Nav />
      <main id="top" tabIndex={-1}>
        <Hero release={release} />
        <Features />
        <OpenSource />
        <FinalCta release={release} />
      </main>
      <Footer />
    </>
  );
}
