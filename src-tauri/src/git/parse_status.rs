use super::types::{ChangeKind, FileChange, RepoStatus};

/// `git status --porcelain=v2 --branch -z` 출력 파서.
///
/// 항목은 NUL로 구분되며, rename(`2`) 항목은 경로 뒤에 NUL + 원본 경로 토큰이 하나 더 붙는다.
/// 경로에 공백이 있어도 안전하도록 각 레코드는 고정 필드 수로 splitn 한다.
pub fn parse_porcelain_v2(bytes: &[u8], status: &mut RepoStatus) {
    let mut tokens = bytes
        .split(|&b| b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned());

    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix("# ") {
            parse_header(header, status);
            continue;
        }

        let Some((tag, rest)) = token.split_once(' ') else {
            continue;
        };

        match tag {
            "1" => parse_changed(rest, status),
            "2" => {
                let orig = tokens.next(); // -z 모드: 원본 경로는 다음 토큰
                parse_renamed(rest, orig, status);
            }
            "u" => parse_unmerged(rest, status),
            "?" => status.untracked.push(FileChange {
                path: rest.to_string(),
                orig_path: None,
                kind: ChangeKind::Untracked,
                staged: false,
            }),
            _ => {} // "!"(ignored) 등은 무시
        }
    }

    // branch.oid는 항상 오므로, 브랜치가 있으면 detached가 아니다.
    if status.branch.is_some() {
        status.detached_sha = None;
    }
}

fn parse_header(header: &str, status: &mut RepoStatus) {
    if let Some(v) = header.strip_prefix("branch.head ") {
        if v != "(detached)" {
            status.branch = Some(v.to_string());
        }
    } else if let Some(v) = header.strip_prefix("branch.oid ") {
        if v != "(initial)" {
            status.detached_sha = Some(v.chars().take(8).collect());
        }
    } else if let Some(v) = header.strip_prefix("branch.upstream ") {
        status.upstream = Some(v.to_string());
    } else if let Some(v) = header.strip_prefix("branch.ab ") {
        for part in v.split(' ') {
            if let Some(n) = part.strip_prefix('+') {
                status.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                status.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — tag 제거 후 8개 필드
fn parse_changed(rest: &str, status: &mut RepoStatus) {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next().unwrap_or("");
    for _ in 0..6 {
        parts.next();
    }
    if let Some(path) = parts.next() {
        push_xy(xy, path, None, status);
    }
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` — tag 제거 후 9개 필드
fn parse_renamed(rest: &str, orig: Option<String>, status: &mut RepoStatus) {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next().unwrap_or("");
    for _ in 0..7 {
        parts.next();
    }
    if let Some(path) = parts.next() {
        push_xy(xy, path, orig, status);
    }
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — tag 제거 후 10개 필드
fn parse_unmerged(rest: &str, status: &mut RepoStatus) {
    let mut parts = rest.splitn(10, ' ');
    for _ in 0..9 {
        parts.next();
    }
    if let Some(path) = parts.next() {
        status.conflicted.push(FileChange {
            path: path.to_string(),
            orig_path: None,
            kind: ChangeKind::Conflicted,
            staged: false,
        });
    }
}

/// XY 중 X(인덱스 측)가 '.'이 아니면 staged로, Y(워크트리 측)가 '.'이 아니면 unstaged로 분류.
/// 한 파일이 양쪽에 모두 나타날 수 있다 (예: MM).
fn push_xy(xy: &str, path: &str, orig: Option<String>, status: &mut RepoStatus) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');

    if let Some(kind) = kind_of(x) {
        status.staged.push(FileChange {
            path: path.to_string(),
            orig_path: orig.clone(),
            kind,
            staged: true,
        });
    }
    if let Some(kind) = kind_of(y) {
        status.unstaged.push(FileChange {
            path: path.to_string(),
            orig_path: orig,
            kind,
            staged: false,
        });
    }
}

fn kind_of(c: char) -> Option<ChangeKind> {
    match c {
        'M' => Some(ChangeKind::Modified),
        'A' => Some(ChangeKind::Added),
        'D' => Some(ChangeKind::Deleted),
        'R' | 'C' => Some(ChangeKind::Renamed),
        'T' => Some(ChangeKind::Typechange),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> RepoStatus {
        let mut status = RepoStatus::empty("test");
        parse_porcelain_v2(input, &mut status);
        status
    }

    #[test]
    fn clean_repo_with_upstream() {
        let s = parse(
            b"# branch.oid 8234627612345678abcd\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +4 -1\x00",
        );
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 4);
        assert_eq!(s.behind, 1);
        assert_eq!(s.detached_sha, None);
        assert!(s.staged.is_empty() && s.unstaged.is_empty() && s.untracked.is_empty());
    }

    #[test]
    fn staged_unstaged_untracked() {
        let s = parse(
            b"# branch.oid abc\x00# branch.head main\x00\
1 .M N... 100644 100644 100644 1111111 2222222 src/app.py\x00\
1 A. N... 000000 100644 100644 0000000 3333333 added.txt\x00\
? untracked.bin\x00",
        );
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].path, "src/app.py");
        assert_eq!(s.unstaged[0].kind, ChangeKind::Modified);
        assert!(!s.unstaged[0].staged);

        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "added.txt");
        assert_eq!(s.staged[0].kind, ChangeKind::Added);
        assert!(s.staged[0].staged);

        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "untracked.bin");
    }

    #[test]
    fn both_staged_and_unstaged_same_file() {
        let s = parse(
            b"# branch.head main\x001 MM N... 100644 100644 100644 aaa bbb src/dual.rs\x00",
        );
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.staged[0].path, "src/dual.rs");
        assert_eq!(s.unstaged[0].path, "src/dual.rs");
    }

    #[test]
    fn rename_consumes_orig_path_token() {
        let s = parse(
            b"# branch.head main\x00\
2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new/name.rs\x00old/name.rs\x00\
? after.txt\x00",
        );
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "new/name.rs");
        assert_eq!(s.staged[0].orig_path.as_deref(), Some("old/name.rs"));
        assert_eq!(s.staged[0].kind, ChangeKind::Renamed);
        // rename의 원본 경로 토큰을 소비한 뒤에도 다음 레코드가 정상 파싱돼야 한다
        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "after.txt");
    }

    #[test]
    fn detached_head() {
        let s = parse(b"# branch.oid deadbeefcafebabe1234\x00# branch.head (detached)\x00");
        assert_eq!(s.branch, None);
        assert_eq!(s.detached_sha.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn unborn_branch() {
        let s = parse(b"# branch.oid (initial)\x00# branch.head main\x00");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.detached_sha, None);
        assert_eq!(s.ahead, 0);
    }

    #[test]
    fn conflicted_file() {
        let s = parse(
            b"# branch.head main\x00u UU N... 100644 100644 100644 100644 a1 b2 c3 both.txt\x00",
        );
        assert_eq!(s.conflicted.len(), 1);
        assert_eq!(s.conflicted[0].path, "both.txt");
        assert_eq!(s.conflicted[0].kind, ChangeKind::Conflicted);
    }

    #[test]
    fn path_with_spaces() {
        let s = parse(
            b"# branch.head main\x001 .M N... 100644 100644 100644 x1 y2 my dir/my file.txt\x00",
        );
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].path, "my dir/my file.txt");
    }
}
