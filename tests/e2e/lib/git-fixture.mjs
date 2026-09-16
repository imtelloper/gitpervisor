// 격리 픽스처 — 임시 디렉토리에 진짜 git 레포 + bare 원격(origin)을 만든다.
// 모든 git 변경 테스트(stage/commit/discard/push/pull/fetch)는 사용자의 실제 레포가 아닌
// 이 픽스처에서만 수행된다. 원격이 로컬 bare 라 네트워크 없이 push/pull 까지 검증된다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** git 명령 실행(동기). 실패 시 stderr 를 담아 throw. */
export function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().trim();
    const err = new Error(`git ${args.join(" ")} 실패 @${cwd}: ${msg}`);
    err.stderr = msg;
    throw err;
  }
}

function configRepo(dir) {
  git(dir, ["config", "user.email", "e2e@gitpervisor.test"]);
  git(dir, ["config", "user.name", "gitpervisor-e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

/** 최소 git 레포(초기 커밋 1개, 원격 없음) — add_project/remove_project 단발 검증용. */
export function createMinimalRepo() {
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-min-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  configRepo(repo);
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return {
    repo,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      } catch (_) {
        /* noop */
      }
    },
  };
}

/** 시드 파일 — **생성과 무결성 검사·복원이 같은 출처를 쓴다.** 두 벌로 두면 한쪽만 바뀌어
 *  검사가 조용히 무력해진다(그러면 "픽스처가 멀쩡하다"는 초록이 아무것도 보장하지 않는다).
 *  전부 최초 커밋에 들어가는 **추적 파일**이라, 사라졌다면 `git clean` 류가 아니라 누군가
 *  능동적으로 지운 것이다. */
export const FIXTURE_SEEDS = {
  "README.md": "# gitpervisor e2e fixture\n",
  "src/app.txt": "line1\nline2\nline3\n",
  ".gitignore": "ignored.txt\n",
};

/**
 * 비-UTF8 인코딩 픽스처 — **바이트를 하드코딩한다.**
 *
 * 문자열로 두고 Node 에게 인코딩을 맡기면(`writeFileSync(p, s, "binary")` 류) 이 파일 자신의
 * 인코딩·Node 버전·로캘에 결과가 좌우돼, 정작 검사하려는 바이트가 조용히 달라진다. 그러면
 * "인코딩이 보존됐다"는 초록이 아무것도 보장하지 않는다.
 *
 * `enc/` 밑에 두는 이유: 루트 목록·status 개수를 단언하는 기존 스위트(02·03·11·24)를
 * 흔들지 않기 위함이다. 시드가 아니라 **쓰는 스위트가 만들고 지운다**(추적되지 않는다).
 */
export const ENCODING_FIXTURES = {
  // CP949: "// 일반 사용" / "#define MAX 10" / "// 연결검사" / "int main(void) { return 0; }" (CRLF)
  // 0xC0 0xCF 0xB9 0xDD = "일반" — 사용자 사례(`.h` 주석)에서 그대로 가져온 바이트다.
  "enc/cp949.h": Buffer.from([
    0x2f, 0x2f, 0x20, 0xc0, 0xcf, 0xb9, 0xdd, 0x20, 0xbb, 0xe7, 0xbf, 0xeb, 0x0d, 0x0a, 0x23, 0x64,
    0x65, 0x66, 0x69, 0x6e, 0x65, 0x20, 0x4d, 0x41, 0x58, 0x20, 0x31, 0x30, 0x0d, 0x0a, 0x2f, 0x2f,
    0x20, 0xbf, 0xac, 0xb0, 0xe1, 0xb0, 0xcb, 0xbb, 0xe7, 0x0d, 0x0a, 0x69, 0x6e, 0x74, 0x20, 0x6d,
    0x61, 0x69, 0x6e, 0x28, 0x76, 0x6f, 0x69, 0x64, 0x29, 0x20, 0x7b, 0x20, 0x72, 0x65, 0x74, 0x75,
    0x72, 0x6e, 0x20, 0x30, 0x3b, 0x20, 0x7d, 0x0d, 0x0a,
  ]),
  // UTF-8 + BOM: "안녕 BOM 테스트\n" — 앞 3바이트가 BOM(EF BB BF).
  "enc/utf8bom.txt": Buffer.from([
    0xef, 0xbb, 0xbf, 0xec, 0x95, 0x88, 0xeb, 0x85, 0x95, 0x20, 0x42, 0x4f, 0x4d, 0x20, 0xed, 0x85,
    0x8c, 0xec, 0x8a, 0xa4, 0xed, 0x8a, 0xb8, 0x0a,
  ]),
  // UTF-16LE + BOM: "가나다 UTF-16 줄\n" — ASCII 자리마다 NUL 이 들어가 NUL 검사만으로는
  // "바이너리"로 오판된다(그게 B-K5 가 막는 것이다).
  "enc/utf16le.txt": Buffer.from([
    0xff, 0xfe, 0x00, 0xac, 0x98, 0xb0, 0xe4, 0xb2, 0x20, 0x00, 0x55, 0x00, 0x54, 0x00, 0x46, 0x00,
    0x2d, 0x00, 0x31, 0x00, 0x36, 0x00, 0x20, 0x00, 0x04, 0xc9, 0x0a, 0x00,
  ]),
  // 순수 UTF-8(BOM 없음) — "기존 파일의 동작이 바이트 단위로 같다"의 회귀 반증용.
  "enc/utf8.txt": Buffer.from("한글 UTF-8 줄\nsecond line\n", "utf8"),
};

/** 이 픽스처를 쓰고 있는 러너의 PID 를 적어 두는 파일 — **레포 밖**(root 바로 아래)에 둔다.
 *  `repo/` 안에 두면 git 픽스처에 낯선 파일이 섞여 status·트리 단언이 흔들린다. */
export const OWNER_FILE = ".gpv-owner";

export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-"));
  // 동시에 도는 다른 러너가 이 픽스처를 "잔여물"로 보고 지우지 못하게 소유자를 남긴다
  // (run.mjs `purgeStaleFixtures` 주석 참조).
  writeFileSync(join(root, OWNER_FILE), String(process.pid));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);

  // 시드 레포: 초기 커밋 1개 + 추적 파일(수정/디프/discard 테스트용) + 원격 연결(아직 push 안 함)
  git(repo, ["init", "-b", "main"]);
  configRepo(repo);
  mkdirSync(join(repo, "src"));
  for (const [rel, body] of Object.entries(FIXTURE_SEEDS))
    writeFileSync(join(repo, ...rel.split("/")), body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init: seed fixture"]);

  git(remote.replace(/[^/\\]+$/, ""), ["init", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);

  const headSha = git(repo, ["rev-parse", "HEAD"]);

  return {
    root,
    repo,
    remote,
    headSha,
    /** repo 안에 파일 쓰기(레포 루트 상대). */
    writeFile(rel, content) {
      writeFileSync(join(repo, rel), content);
    },
    /** repo 안 파일 읽기(레포 루트 상대). */
    readFile(rel) {
      return readFileSync(join(repo, rel), "utf8");
    },
    /** repo 안 파일을 **바이트 그대로** 읽는다 — 인코딩 보존 단언은 문자열로는 못 한다
     *  (문자열로 비교하면 디코드가 손실을 이미 흡수한 뒤라 아무것도 못 잡는다). */
    readBytes(rel) {
      return readFileSync(join(repo, ...rel.split("/")));
    },
    /** 비-UTF8 픽스처를 repo 에 푼다(`enc/`). 쓰는 스위트가 끝나면 지운다. */
    writeEncodingFixtures() {
      mkdirSync(join(repo, "enc"), { recursive: true });
      for (const [rel, bytes] of Object.entries(ENCODING_FIXTURES))
        writeFileSync(join(repo, ...rel.split("/")), bytes);
    },
    /** 푼 비-UTF8 픽스처를 통째로 지운다(다른 스위트의 status·검색 단언에 새지 않게). */
    removeEncodingFixtures() {
      rmSync(join(repo, "enc"), { recursive: true, force: true, maxRetries: 3 });
    },
    /** 추적 파일의 워킹트리 변경을 되돌린다(다른 스위트로 더러움이 새지 않게). */
    revert(rel) {
      git(repo, ["checkout", "--", rel]);
    },
    /** repo 의 작업트리/인덱스 상태(porcelain) — 디스크 교차검증용. */
    status() {
      return git(repo, ["status", "--porcelain=v2", "--branch"]);
    },
    /**
     * 외부 개발자가 원격에 커밋을 푸시한 상황을 시뮬레이션 — pull/fetch ahead 검증용.
     * 앱이 먼저 push -u 로 origin/main 을 만든 뒤 호출해야 한다. 새 커밋 sha 반환.
     */
    pushExternalCommit(rel, content, message) {
      const ext = join(root, "external");
      if (!existsSync(ext)) {
        git(root, ["clone", remote, "external"]);
        configRepo(ext);
      }
      writeFileSync(join(ext, rel), content);
      git(ext, ["add", "-A"]);
      git(ext, ["commit", "-m", message]);
      git(ext, ["push", "origin", "HEAD:main"]);
      return git(ext, ["rev-parse", "HEAD"]);
    },
    /** 원격(bare)에 도달한 마지막 커밋 메시지 — push 교차검증용. */
    remoteLog() {
      try {
        return git(remote, ["log", "--format=%s", "-1", "main"]);
      } catch {
        return null;
      }
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.error("fixture cleanup 경고:", e.message);
      }
    },
  };
}
