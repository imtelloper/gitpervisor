// LSP 언어 서버 다운로드(태스크 17 M1 수동 획득) — basedpyright npm tarball을 앱 관리 디렉토리에
// 배치한다. M2에서 이 로직이 Rust(lsp/acquire.rs)로 이관되면 이 스크립트는 개발 편의용으로 남는다.
//
// 관리 디렉토리 = Tauri app_local_data_dir(Windows: %LOCALAPPDATA%/<identifier>)/lsp/
// 버전 pin + sha512 검증(fetch-tools 관례 — 불일치 fail-fast).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const IDENTIFIER = "com.greathoon.gitpervisor";
// 서버 pin — lsp/acquire.rs 상수와 동기 유지(§4). integrity는 npm 레지스트리 pin 시점 채록.
const SERVERS = {
  basedpyright: {
    version: "1.39.9",
    // registry.npmjs.org/basedpyright/1.39.9 → dist.integrity (sha512, base64)
    integrity: "sha512-7ijtpTtV3E3r5Lvv8GV0HfOyRrtDdLOj+xA4q3vv1Mg03F8k/vIBXSVLOQ7X5oNI52kFqiMQehhr8RS0CSP59w==",
    tarball: "https://registry.npmjs.org/basedpyright/-/basedpyright-1.39.9.tgz",
  },
  // TS 서버(태스크 17 M3). tls는 tsserver를 별도로 요구(deps 0) — typescript도 함께 받는다.
  "typescript-language-server": {
    version: "5.3.0",
    integrity: "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
    tarball: "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz",
  },
  typescript: {
    version: "5.9.3",
    integrity: "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
    tarball: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
  },
};

// 네이티브 서버(npm 아님 — GitHub 릴리스 바이너리). Rust ensure_native와 버전·해시 동기.
// sha256은 Windows만 pin(다운로드 시점 채록) — 나머지 플랫폼은 검증 생략(경고).
const NATIVE = {
  clangd: {
    version: "22.1.6",
    url: (v) => `https://github.com/clangd/clangd/releases/download/${v}/clangd-${plat("clangd")}-${v}.zip`,
    inner: (v) => `clangd_${v}`, // 내부 디렉토리
    sha256: { win32: "ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1" },
    kind: "zip",
  },
  "rust-analyzer": {
    version: "2026-07-06",
    url: (v) =>
      `https://github.com/rust-lang/rust-analyzer/releases/download/${v}/rust-analyzer-${plat("rust-analyzer")}.${process.platform === "win32" ? "zip" : "gz"}`,
    inner: null, // flat
    exe: () => (process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer"),
    sha256: { win32: "b046120af10d0cb7c735bbd377a53007d97048666fe967e95ea88a9fc177fa09" },
    kind: process.platform === "win32" ? "zip" : "gzsingle",
  },
  "lua-language-server": {
    version: "3.18.2",
    url: (v) =>
      `https://github.com/LuaLS/lua-language-server/releases/download/${v}/lua-language-server-${v}-${plat("lua-language-server")}.${process.platform === "win32" ? "zip" : "tar.gz"}`,
    inner: null, // flat(bin/…)
    sha256: { win32: "a4439a8f5e8e9e6505c11f045a7bf45db602124a1e246371c1dbe34924f3cf71" },
    kind: process.platform === "win32" ? "zip" : "targz",
  },
};

function plat(name) {
  const a = process.arch === "arm64" ? "arm64" : "x64";
  if (name === "clangd") return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  if (name === "rust-analyzer") {
    const os = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${os}`;
  }
  // lua-language-server
  const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  return `${os}-${a}`;
}

function managedLspDir() {
  // Windows app_local_data_dir = %LOCALAPPDATA%/<identifier>. 그 외 OS는 XDG/Library 근사.
  const local =
    process.env.LOCALAPPDATA ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"));
  return join(local, IDENTIFIER, "lsp");
}

async function download(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** npm integrity(sha512-<base64>)를 실제 tarball로 검증. 불일치는 fail-fast(§3.3). */
function verifyIntegrity(buf, integrity) {
  const [algo, expected] = integrity.split("-");
  const actual = createHash(algo).update(buf).digest("base64");
  if (actual !== expected)
    throw new Error(`${algo} 불일치 — 변조 의심, 중단\n기대: ${expected}\n실제: ${actual}`);
  return `${algo}:${actual.slice(0, 16)}…`;
}

async function fetchServer(name) {
  const s = SERVERS[name];
  const dir = managedLspDir();
  const dest = join(dir, `${name}-${s.version}`);
  const okMarker = join(dest, ".ok");
  if (existsSync(okMarker)) {
    console.log(`[${name} ${s.version}] 이미 설치됨: ${dest}`);
    return;
  }
  console.log(`[${name} ${s.version}] ${s.tarball} 다운로드…`);
  const tgz = await download(s.tarball);
  console.log(`  integrity 검증 OK (${verifyIntegrity(tgz, s.integrity)})`);

  // temp에 해제 후 rename(원자 설치) — 해제 중 크래시가 손상본을 "설치됨"으로 오판하지 않게.
  const tmp = join(tmpdir(), `gpv-lsp-${name}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgzPath = join(tmp, "pkg.tgz");
  writeFileSync(tgzPath, tgz);
  const tarCmd =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  // npm tarball은 최상위 `package/` — tmp/package/ 로 풀린다.
  execFileSync(tarCmd, ["-xf", tgzPath, "-C", tmp], { stdio: "inherit" });
  rmSync(tgzPath, { force: true });

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // tmp/package → dest 로 이동
  execFileSync(
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
      : "sh",
    process.platform === "win32"
      ? ["/c", "move", join(tmp, "package"), dest]
      : ["-c", `mv "${join(tmp, "package")}" "${dest}"`],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(okMarker, `${s.version}\n`);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  console.log(`  → ${dest} (진입점: langserver.index.js)`);
}

async function fetchNative(name) {
  const spec = NATIVE[name];
  const dir = managedLspDir();
  const dest = join(dir, `${name}-${spec.version}`);
  if (existsSync(join(dest, ".ok"))) {
    console.log(`[${name} ${spec.version}] 이미 설치됨`);
    return;
  }
  const url = spec.url(spec.version);
  console.log(`[${name} ${spec.version}] 다운로드… ${url.split("/").pop()}`);
  const bytes = await download(url);
  const expected = spec.sha256[process.platform];
  if (expected) {
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`${name} sha256 불일치 — 중단`);
    console.log(`  sha256 검증 OK`);
  } else {
    console.warn(`  이 플랫폼 sha256 미pin — 검증 생략`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (spec.kind === "gzsingle") {
    // gz 단일 바이너리 → dest/exe로.
    const { gunzipSync } = await import("node:zlib");
    mkdirSync(dest, { recursive: true });
    const exe = spec.exe();
    writeFileSync(join(dest, exe), gunzipSync(bytes));
    if (process.platform !== "win32") chmodSync(join(dest, exe), 0o755);
  } else {
    const tmp = join(tmpdir(), `gpv-${name}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const arcPath = join(tmp, "arc");
    writeFileSync(arcPath, bytes);
    const tarCmd = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tarCmd, ["-xf", arcPath, "-C", tmp], { stdio: "inherit" });
    rmSync(arcPath, { force: true });
    const src = spec.inner ? join(tmp, spec.inner(spec.version)) : tmp;
    // src를 dest로 이동(inner면 그 하위, flat이면 tmp 전체).
    if (spec.inner) {
      execFileSync(
        process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe") : "sh",
        process.platform === "win32" ? ["/c", "move", src, dest] : ["-c", `mv "${src}" "${dest}"`],
        { stdio: "inherit" },
      );
      rmSync(tmp, { recursive: true, force: true });
    } else {
      // flat — tmp를 dest로 rename.
      execFileSync(
        process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe") : "sh",
        process.platform === "win32" ? ["/c", "move", tmp, dest] : ["-c", `mv "${tmp}" "${dest}"`],
        { stdio: "inherit" },
      );
    }
  }
  writeFileSync(join(dest, ".ok"), `${spec.version}\n`);
  console.log(`  → ${dest}`);
}

const only = process.argv[2];
for (const name of Object.keys(SERVERS)) {
  if (!only || only === name) await fetchServer(name);
}
for (const name of Object.keys(NATIVE)) {
  if (!only || only === name) await fetchNative(name);
}
console.log("완료. 관리 디렉토리:", managedLspDir());
