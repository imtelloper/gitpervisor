// 번들 도구 다운로드 — ruff·biome 네이티브 바이너리를 src-tauri/resources/tools/ 로 받는다.
// 앱 러너의 ④ 번들 폴백(tools::runner::discover)이 이걸 쓴다. 바이너리는 git에 커밋하지 않고
// 이 스크립트로 재현한다(reproducible). 릴리스 전 `npm run fetch-tools` → `npm run tauri build`.
//
// 버전 고정(pin)이 핵심 — 번들 버전을 명시해야 프로젝트 CI와의 드리프트를 통제한다.
// 사용자/프로젝트에 ruff·biome이 있으면 러너가 그걸 먼저 쓰므로(발견 우선), 번들은 폴백일 뿐.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUFF_VERSION = "0.15.20";
const BIOME_VERSION = "2.5.2";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src-tauri", "resources", "tools");
mkdirSync(OUT, { recursive: true });

const isWin = process.platform === "win32";
const exe = (n) => (isWin ? `${n}.exe` : n);

// ── 플랫폼 → 자산 이름 ──
function ruffAsset() {
  const map = {
    "win32-x64": "ruff-x86_64-pc-windows-msvc.zip",
    "win32-arm64": "ruff-aarch64-pc-windows-msvc.zip",
    "darwin-x64": "ruff-x86_64-apple-darwin.tar.gz",
    "darwin-arm64": "ruff-aarch64-apple-darwin.tar.gz",
    "linux-x64": "ruff-x86_64-unknown-linux-gnu.tar.gz",
    "linux-arm64": "ruff-aarch64-unknown-linux-gnu.tar.gz",
  };
  const key = `${process.platform}-${process.arch}`;
  const asset = map[key];
  if (!asset) throw new Error(`지원하지 않는 플랫폼(ruff): ${key}`);
  return asset;
}
function biomeAsset() {
  const map = {
    "win32-x64": "biome-win32-x64.exe",
    "win32-arm64": "biome-win32-arm64.exe",
    "darwin-x64": "biome-darwin-x64",
    "darwin-arm64": "biome-darwin-arm64",
    "linux-x64": "biome-linux-x64",
    "linux-arm64": "biome-linux-arm64",
  };
  const key = `${process.platform}-${process.arch}`;
  const asset = map[key];
  if (!asset) throw new Error(`지원하지 않는 플랫폼(biome): ${key}`);
  return asset;
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
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchRuff() {
  const asset = ruffAsset();
  const base = `https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}`;
  console.log(`[ruff ${RUFF_VERSION}] ${asset} 다운로드…`);
  const archive = await download(`${base}/${asset}`);
  // 무결성: 공개 .sha256 대조(공급망 방어 — 다운로드 변조 감지).
  // .sha256 파일 "취득 실패"만 경고 후 속행 — "불일치"는 반드시 중단(fail-fast).
  // (이전엔 둘 다 같은 try에 있어 불일치 throw가 catch에 삼켜졌다 — 적대 검증 지적으로 수정)
  let expected = null;
  try {
    expected = (await download(`${base}/${asset}.sha256`)).toString().trim().split(/\s+/)[0];
  } catch (e) {
    console.warn(`  sha256 파일 취득 실패 — 검증 건너뜀: ${e.message.slice(0, 60)}`);
  }
  if (expected) {
    const actual = sha256(archive);
    if (expected !== actual)
      throw new Error(`sha256 불일치 — 다운로드 변조 의심, 중단\n기대: ${expected}\n실제: ${actual}`);
    console.log(`  sha256 검증 OK (${actual.slice(0, 16)}…)`);
  }
  // 임시 파일로 저장 후 tar로 추출(tar는 Win10+ zip·모든 OS tar.gz 처리)
  const tmp = join(tmpdir(), `gpv-ruff-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const archivePath = join(tmp, asset);
  writeFileSync(archivePath, archive);
  // Windows는 시스템 bsdtar를 절대경로로 — Git Bash의 GNU tar는 `C:\` 를 원격 호스트로 오인한다.
  const tarCmd = isWin
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tarCmd, ["-xf", archivePath, "-C", tmp], { stdio: "inherit" });
  // 추출 결과에서 ruff 실행 파일 찾기(zip=루트, tar.gz=ruff-<triple>/ruff)
  const candidates = [
    join(tmp, exe("ruff")),
    join(tmp, asset.replace(/\.(zip|tar\.gz)$/, ""), "ruff"),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) throw new Error(`추출물에서 ruff 실행 파일을 못 찾음: ${candidates.join(", ")}`);
  const dest = join(OUT, exe("ruff"));
  writeFileSync(dest, readFileSync(src));
  if (!isWin) chmodSync(dest, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`  → ${dest}`);
}

async function fetchBiome() {
  const asset = biomeAsset();
  // 태그: @biomejs/biome@<ver> (URL에 @는 %40, 슬래시는 리터럴)
  const tag = `%40biomejs/biome%40${BIOME_VERSION}`;
  const url = `https://github.com/biomejs/biome/releases/download/${tag}/${asset}`;
  console.log(`[biome ${BIOME_VERSION}] ${asset} 다운로드… (~77MB, 시간 걸림)`);
  const bin = await download(url);
  const dest = join(OUT, exe("biome"));
  writeFileSync(dest, bin);
  if (!isWin) chmodSync(dest, 0o755);
  console.log(`  → ${dest} (${(bin.length / 1048576).toFixed(1)}MB)`);
}

const only = process.argv[2]; // "ruff" | "biome" | undefined(둘 다)
if (!only || only === "ruff") await fetchRuff();
if (!only || only === "biome") await fetchBiome();
console.log("완료.");
