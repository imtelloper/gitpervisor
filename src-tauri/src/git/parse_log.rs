use super::types::{ChangeKind, Commit, CommitFile, LocalBranch, RemoteBranch};

/// 필드 구분자 (Unit Separator). 로그/브랜치 포맷에서 필드 사이에 넣는다.
const US: char = '\u{1f}';

/// `git log -z --pretty=format:%H<US>%P<US>%an<US>%ae<US>%aI<US>%s<US>%b<US>%D` 파서.
///
/// 커밋은 NUL(`-z`), 필드는 US(0x1f)로 구분한다. %b(본문)가 개행을 포함해도
/// 필드 구분이 US라 안전하다. 첫 필드(sha) 앞에 붙을 수 있는 개행은 trim으로 흡수.
pub fn parse_log(bytes: &[u8]) -> Vec<Commit> {
    bytes
        .split(|&b| b == 0)
        .filter(|chunk| !chunk.is_empty())
        .filter_map(parse_commit_record)
        .collect()
}

fn parse_commit_record(chunk: &[u8]) -> Option<Commit> {
    let text = String::from_utf8_lossy(chunk);
    let mut fields = text.split(US);

    let sha = fields.next()?.trim().to_string();
    if sha.is_empty() {
        return None;
    }
    let parents = fields.next().unwrap_or("");
    let author_name = fields.next().unwrap_or("").to_string();
    let author_email = fields.next().unwrap_or("").to_string();
    let authored_at = fields.next().unwrap_or("").trim().to_string();
    let subject = fields.next().unwrap_or("").to_string();
    let body = fields.next().unwrap_or("").trim_end().to_string();
    let refs = fields.next().unwrap_or("");

    Some(Commit {
        sha,
        parents: parents.split_whitespace().map(String::from).collect(),
        subject,
        body,
        author_name,
        author_email,
        authored_at,
        refs: parse_refs(refs),
    })
}

/// `%D` 데코레이션: "HEAD -> main, origin/main, tag: v1.0" — ", "로 분리.
fn parse_refs(d: &str) -> Vec<String> {
    d.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// `for-each-ref --format=%(refname:short)<US>%(upstream:short)<US>%(upstream:track) refs/heads`
pub fn parse_local_branches(stdout: &str) -> Vec<LocalBranch> {
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut f = line.split(US);
            let name = f.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let upstream = f.next().unwrap_or("").trim();
            let (ahead, behind) = parse_track(f.next().unwrap_or(""));
            Some(LocalBranch {
                name,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead,
                behind,
            })
        })
        .collect()
}

/// `%(upstream:track)`: "[ahead 4, behind 1]" → (4, 1). "[gone]"/"" → (0, 0).
fn parse_track(track: &str) -> (u32, u32) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// `for-each-ref --format=%(refname:short) refs/remotes` — "origin/HEAD" 심볼릭은 제외.
pub fn parse_remote_branches(stdout: &str) -> Vec<RemoteBranch> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .map(|l| RemoteBranch { name: l.to_string() })
        .collect()
}

/// `diff-tree --no-commit-id -r -M --root --name-status -z <sha>` 파서.
///
/// 토큰은 NUL 구분: `<status>\0<path>` 반복, rename/copy(`R100`/`C75`)는
/// `<status>\0<old>\0<new>`로 경로가 둘이다.
pub fn parse_commit_files(bytes: &[u8]) -> Vec<CommitFile> {
    let mut tokens = bytes
        .split(|&b| b == 0)
        .filter(|t| !t.is_empty())
        .map(|t| String::from_utf8_lossy(t).into_owned());

    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let first = status.chars().next();
        let kind = status_kind(first);
        if matches!(first, Some('R') | Some('C')) {
            let orig = tokens.next();
            let Some(path) = tokens.next() else { break };
            files.push(CommitFile {
                path,
                orig_path: orig,
                kind,
            });
        } else {
            let Some(path) = tokens.next() else { break };
            files.push(CommitFile {
                path,
                orig_path: None,
                kind,
            });
        }
    }
    files
}

fn status_kind(first: Option<char>) -> ChangeKind {
    match first {
        Some('A') => ChangeKind::Added,
        Some('D') => ChangeKind::Deleted,
        Some('R') | Some('C') => ChangeKind::Renamed,
        Some('T') => ChangeKind::Typechange,
        _ => ChangeKind::Modified, // 'M' 및 기타
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_two_commits_with_body_and_refs() {
        // %x1f = US(0x1f), 커밋 사이 NUL. 두 번째 커밋엔 다중 부모(머지)와 본문 개행 포함.
        let input = b"abc123\x1fp1\x1fAlice\x1falice@x.com\x1f2026-06-10T12:00:00+09:00\x1f\xea\xb8\xb0\xeb\x8a\xa5 \xec\xb6\x94\xea\xb0\x80\x1f\x1fHEAD -> main, origin/main\x00\
def456\x1fp1 p2\x1fBob\x1fbob@x.com\x1f2026-06-09T08:30:00+09:00\x1f\xeb\xa8\xb8\xec\xa7\x80\x1f\xeb\xb3\xb8\xeb\xac\xb8 \xec\xb2\xab\xec\xa4\x84\n\xeb\x91\x98\xec\xa7\xb8\xec\xa4\x84\x1f\x00";
        let commits = parse_log(input);
        assert_eq!(commits.len(), 2);

        assert_eq!(commits[0].sha, "abc123");
        assert_eq!(commits[0].parents, vec!["p1"]);
        assert_eq!(commits[0].author_name, "Alice");
        assert_eq!(commits[0].authored_at, "2026-06-10T12:00:00+09:00");
        assert_eq!(commits[0].body, "");
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "origin/main"]);

        assert_eq!(commits[1].sha, "def456");
        assert_eq!(commits[1].parents, vec!["p1", "p2"]); // 머지 커밋
        assert_eq!(commits[1].body, "본문 첫줄\n둘째줄");
        assert!(commits[1].refs.is_empty());
    }

    #[test]
    fn log_empty_output() {
        assert!(parse_log(b"").is_empty());
        assert!(parse_log(b"\x00").is_empty());
    }

    #[test]
    fn local_branches_track_parsing() {
        let out = "main\x1forigin/main\x1f[ahead 4, behind 1]\n\
feature\x1f\x1f\n\
release\x1forigin/release\x1f[behind 2]\n\
gone-br\x1forigin/gone\x1f[gone]\n";
        let b = parse_local_branches(out);
        assert_eq!(b.len(), 4);
        assert_eq!(b[0].name, "main");
        assert_eq!(b[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!((b[0].ahead, b[0].behind), (4, 1));
        assert_eq!(b[1].name, "feature");
        assert_eq!(b[1].upstream, None);
        assert_eq!((b[1].ahead, b[1].behind), (0, 0));
        assert_eq!((b[2].ahead, b[2].behind), (0, 2));
        assert_eq!((b[3].ahead, b[3].behind), (0, 0)); // gone
    }

    #[test]
    fn remote_branches_skip_head_symref() {
        let out = "origin/HEAD\norigin/main\norigin/feature\n";
        let r = parse_remote_branches(out);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "origin/main");
        assert_eq!(r[1].name, "origin/feature");
    }

    #[test]
    fn commit_files_modify_add_rename() {
        // M\0a.txt \0 A\0b.txt \0 R100\0old.txt\0new.txt \0 D\0gone.txt
        let input = b"M\x00a.txt\x00A\x00b.txt\x00R100\x00old.txt\x00new.txt\x00D\x00gone.txt\x00";
        let files = parse_commit_files(input);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].kind, ChangeKind::Modified);
        assert_eq!(files[1].kind, ChangeKind::Added);
        assert_eq!(files[2].path, "new.txt");
        assert_eq!(files[2].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(files[2].kind, ChangeKind::Renamed);
        assert_eq!(files[3].path, "gone.txt");
        assert_eq!(files[3].kind, ChangeKind::Deleted);
    }
}
