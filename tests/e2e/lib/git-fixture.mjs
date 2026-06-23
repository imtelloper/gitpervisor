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

export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);

  // 시드 레포: 초기 커밋 1개 + 추적 파일(수정/디프/discard 테스트용) + 원격 연결(아직 push 안 함)
  git(repo, ["init", "-b", "main"]);
  configRepo(repo);
  writeFileSync(join(repo, "README.md"), "# gitpervisor e2e fixture\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
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
