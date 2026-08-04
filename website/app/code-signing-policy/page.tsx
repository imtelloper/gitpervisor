import type { Metadata } from "next";
import NextLink from "next/link";
import { ArrowLeft } from "lucide-react";

import { Footer } from "@/components/Footer";
import { GITHUB_URL, ISSUES_URL, REPO, RELEASES_URL, SITE_URL } from "@/lib/github";

// Required by the SignPath Foundation terms for OSS projects: the code signing
// policy must be published on the project homepage. Keep this page in sync with
// .github/workflows/release.yml — it describes what that workflow actually does.
export const metadata: Metadata = {
  title: "Code Signing Policy — Gitpervisor",
  description:
    "How Gitpervisor release binaries are built, signed, and verified: the release pipeline, signing roles, and how to check a signature yourself.",
  alternates: { canonical: `${SITE_URL}/code-signing-policy` },
};

const MAINTAINER = "imtelloper";
const WORKFLOW_URL = `${GITHUB_URL}/blob/main/.github/workflows/release.yml`;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-card-2 px-1.5 py-0.5 font-mono text-[13px] text-ink">
      {children}
    </code>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
    >
      {children}
    </a>
  );
}

export default function CodeSigningPolicy() {
  return (
    <>
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <NextLink
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Gitpervisor
        </NextLink>

        <h1 className="mt-8 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Code Signing Policy
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          Gitpervisor is an open-source desktop application distributed as
          prebuilt installers. This page documents how those installers are
          produced and signed, who is allowed to approve a signature, and how you
          can verify a download yourself without trusting this page.
        </p>

        <div className="mt-10 space-y-12">
          <Section id="scope" title="What gets signed">
            <p>
              Every release artifact is built from the public source at{" "}
              <Link href={GITHUB_URL}>{REPO}</Link> and published to{" "}
              <Link href={RELEASES_URL}>GitHub Releases</Link>. Two independent
              signatures are involved, and they serve different purposes:
            </p>
            <ul className="space-y-3 pl-5">
              <li className="list-disc marker:text-faint">
                <span className="text-ink">Authenticode (Windows).</span> The
                Windows installer <Code>Gitpervisor_&lt;version&gt;_x64-setup.exe</Code>{" "}
                carries a Windows code signature so the operating system and
                anti-malware products can attribute it to a known publisher.
              </li>
              <li className="list-disc marker:text-faint">
                <span className="text-ink">Update signatures (all platforms).</span>{" "}
                Every artifact is additionally signed with a project-held minisign
                key. The in-app updater refuses any download whose signature does
                not match the public key compiled into the application, so a
                tampered release cannot be pushed to existing installations.
              </li>
            </ul>
            <p>
              Linux packages (<Code>.deb</Code>, <Code>.rpm</Code>,{" "}
              <Code>.AppImage</Code>) and the macOS bundle carry the update
              signature only.
            </p>
          </Section>

          <Section id="pipeline" title="How releases are built">
            <p>
              Releases are never built or uploaded from a developer machine. A
              release is produced entirely by{" "}
              <Link href={WORKFLOW_URL}>a GitHub Actions workflow</Link> that is
              itself part of the versioned source tree, and it runs only on
              GitHub-hosted runners.
            </p>
            <ol className="space-y-2 pl-5">
              <li className="list-decimal marker:text-faint">
                A maintainer pushes a <Code>v*</Code> tag to the default branch.
              </li>
              <li className="list-decimal marker:text-faint">
                The workflow checks out that exact commit and builds each platform
                from source.
              </li>
              <li className="list-decimal marker:text-faint">
                The build submits the artifact for signing. The signing service
                independently verifies the origin of the request — repository,
                branch, commit, and workflow run — before a signature can be
                issued.
              </li>
              <li className="list-decimal marker:text-faint">
                Signed artifacts, their update signatures, and the update manifest
                are attached to the release.
              </li>
            </ol>
            <p>
              Because the build configuration lives in the repository, any change
              to how a release is produced is a reviewable commit in public
              history.
            </p>
          </Section>

          <Section id="roles" title="Roles and approval">
            <p>
              Gitpervisor is currently maintained by a single developer,{" "}
              <Link href={`https://github.com/${MAINTAINER}`}>{MAINTAINER}</Link>,
              who acts as author, reviewer, and approver. We state this plainly
              rather than implying a separation of duties that does not exist.
              These controls apply:
            </p>
            <ul className="space-y-2 pl-5">
              <li className="list-disc marker:text-faint">
                Multi-factor authentication is required on the GitHub account that
                can push tags and on the signing service account.
              </li>
              <li className="list-disc marker:text-faint">
                Every signing request is approved individually and manually. There
                is no unattended or bulk signing.
              </li>
              <li className="list-disc marker:text-faint">
                Signing certificates are held by the signing service and are never
                present on a developer machine, so they cannot be exfiltrated from
                one.
              </li>
              <li className="list-disc marker:text-faint">
                Only artifacts built by the release workflow from this repository
                are ever submitted for signing.
              </li>
            </ul>
            <p>
              If additional maintainers join, this page will be updated to
              separate the reviewer and approver roles.
            </p>
          </Section>

          <Section id="verify" title="Verifying a download">
            <p>
              You do not have to take any of this on trust. On Windows, check the
              signature of the installer you downloaded:
            </p>
            <pre className="overflow-x-auto rounded-lg border border-line bg-card p-4 font-mono text-[13px] leading-relaxed text-ink">
              <code>{`Get-AuthenticodeSignature .\\Gitpervisor_<version>_x64-setup.exe |
  Format-List Status, SignerCertificate`}</code>
            </pre>
            <p>
              <Code>Status</Code> must read <Code>Valid</Code>. A result of{" "}
              <Code>NotSigned</Code>, <Code>HashMismatch</Code>, or an unexpected
              signer means the file was not produced by this project&apos;s
              release pipeline — do not run it, and please report it.
            </p>
            <p>
              On every platform you can compare the file you downloaded against
              the assets listed on the{" "}
              <Link href={RELEASES_URL}>release page</Link>, and reproduce the
              build yourself from the tagged commit.
            </p>
          </Section>

          <Section id="publisher" title="Publisher name">
            <p>
              Free code signing for open-source projects is provided by
              certificate authorities and foundations that issue the certificate
              in their own name. As a result, the publisher shown by Windows may
              be the issuing foundation rather than{" "}
              <span className="text-ink">Gitpervisor</span> or{" "}
              <span className="text-ink">{MAINTAINER}</span>. This is expected and
              is not a sign of tampering. The authoritative check is that the
              signature status is valid and the file came from the release page
              linked above.
            </p>
          </Section>

          <Section id="reporting" title="Reporting misuse or vulnerabilities">
            <p>
              If you believe a signed Gitpervisor binary is malicious, has been
              tampered with, or that a signature has been misused, report it at{" "}
              <Link href={ISSUES_URL}>{REPO}/issues</Link>. For anything you would
              rather not disclose publicly, use GitHub&apos;s private security
              advisory form on the repository&apos;s Security tab.
            </p>
            <p>
              We will investigate any credible report, cooperate with the
              certificate issuer, and request revocation of an affected signature
              where warranted.
            </p>
          </Section>

          <Section id="status" title="Current status">
            <p>
              Windows Authenticode signing is being introduced. Releases up to and
              including <Code>v0.3.5</Code> are unsigned on Windows, which is why
              SmartScreen and some anti-malware products warn about them or delay
              the install while they scan. Update signatures have been present on
              all platforms since the updater shipped and are unaffected.
            </p>
            <p>
              This page will state the active signing provider and the first
              signed version once the first signed release is published.
            </p>
          </Section>
        </div>

        <p className="mt-14 border-t border-line pt-6 text-sm text-faint">
          Last updated 2026-08-04. This policy is versioned with the source; see
          its history in <Link href={GITHUB_URL}>the repository</Link>.
        </p>
      </main>
      <Footer />
    </>
  );
}
