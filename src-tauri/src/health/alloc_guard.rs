//! 메모리 할당 실패 표식 — 앱이 **로그 한 줄 없이** 사라지는 마지막 구멍을 막는다.
//!
//! Rust에서 힙 할당이 실패하면 std가 `handle_alloc_error`로 들어가 stderr에 한 줄 찍고
//! `abort()` 한다. GUI 앱은 stderr가 버려지고, abort는 패닉이 아니라 **패닉 훅도 돌지 않는다.**
//! 남는 것은 Windows 이벤트 로그의 예외 코드 0xC0000409뿐인데, 그건 fastfail 전반을 뜻해
//! "메모리였다"를 확정하지 못한다. 그래서 실패한 그 순간 파일 하나를 남긴다.
//!
//! **여기서 할 수 있는 일은 극단적으로 제한된다.** 할당이 이미 실패한 상태이므로
//! 할당·`format!`·뮤텍스·`log::` 매크로는 전부 금지다(그 안에서 다시 할당하면 재귀하거나
//! 그대로 죽는다). 그래서:
//!   - 경로는 `install()`이 시작 시점에 미리 UTF-16/바이트로 만들어 누출시켜 둔다.
//!   - 숫자는 스택 버퍼에 수동으로 찍는다.
//!   - 쓰기는 OS 호출 한 번(CreateFileW/WriteFile, unix는 open/write)으로 끝낸다.
//!   - `AtomicBool` CAS로 **딱 한 번만** 시도한다(재진입 차단).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

/// System 할당기에 널 검사만 덧댄 래퍼. 성공 경로는 분기 하나가 전부다.
pub struct Guarded;

unsafe impl GlobalAlloc for Guarded {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if p.is_null() {
            note_failure(layout.size());
        }
        p
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if p.is_null() {
            note_failure(layout.size());
        }
        p
    }

    #[inline]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if p.is_null() {
            note_failure(new_size);
        }
        p
    }

    #[inline]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOC: Guarded = Guarded;

/// 한 번만 쓴다. 표식을 쓰는 도중 또 할당이 실패해도 재진입하지 않는다.
static FIRED: AtomicBool = AtomicBool::new(false);

/// 미리 만들어 둔 표식 파일 경로(널 종료). 실패 시점에 경로를 조립하면 할당이 필요하다.
#[cfg(windows)]
static PATH: AtomicPtr<u16> = AtomicPtr::new(std::ptr::null_mut());
#[cfg(unix)]
static PATH: AtomicPtr<u8> = AtomicPtr::new(std::ptr::null_mut());

/// 표식 경로를 확정한다. `session::begin()`에서 로그 경로가 정해지자마자 1회 호출.
/// 버퍼는 의도적으로 누출시킨다 — 프로세스 수명 내내 살아 있어야 하고, 해제할 일이 없다.
pub fn install(log_dir: &std::path::Path) {
    let path = log_dir.join(super::session::ALLOC_FAIL);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut w: Vec<u16> = path.as_os_str().encode_wide().collect();
        w.push(0);
        PATH.store(
            Box::into_raw(w.into_boxed_slice()).cast(),
            Ordering::Release,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut b: Vec<u8> = path.as_os_str().as_bytes().to_vec();
        b.push(0);
        PATH.store(
            Box::into_raw(b.into_boxed_slice()).cast(),
            Ordering::Release,
        );
    }
}

/// 할당 실패를 파일 한 줄로 남긴다. **할당·포맷·뮤텍스·로그 매크로 금지**(모듈 주석).
pub(crate) fn note_failure(size: usize) {
    if FIRED.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut buf = [0u8; 48];
    let n = render(size, &mut buf);
    write_marker(&buf[..n]);
}

/// `alloc-fail bytes=<size>\n` 을 스택 버퍼에 직접 찍는다(`format!`은 할당한다).
fn render(size: usize, out: &mut [u8; 48]) -> usize {
    const HEAD: &[u8] = b"alloc-fail bytes=";
    out[..HEAD.len()].copy_from_slice(HEAD);
    let mut n = HEAD.len();
    // 10진수를 뒤에서부터 만들고 되짚어 쓴다. usize 최대 20자리.
    let mut d = [0u8; 20];
    let mut i = 0usize;
    let mut v = size;
    loop {
        d[i] = b'0' + (v % 10) as u8;
        v /= 10;
        i += 1;
        if v == 0 {
            break;
        }
    }
    while i > 0 {
        i -= 1;
        out[n] = d[i];
        n += 1;
    }
    out[n] = b'\n';
    n + 1
}

// `std::fs::File::create`를 쓸 수 없다 — 경로를 UTF-16으로 바꾸느라 **할당한다.**
// 그래서 미리 만들어 둔 버퍼로 CreateFileW를 직접 부른다.
//
// windows-sys 0.59는 CreateFileW를 `Win32_Security` feature 뒤에 숨겨 두는데(인자에
// SECURITY_ATTRIBUTES가 있어서다) 이 저장소는 그 feature를 켜지 않는다. 함수 하나 때문에
// feature를 늘리는 대신 직접 선언한다 — kernel32.lib은 MSVC 타깃이 기본으로 링크한다.
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const core::ffi::c_void,
        disposition: u32,
        flags: u32,
        template: *mut core::ffi::c_void,
    ) -> *mut core::ffi::c_void;
}

#[cfg(windows)]
fn write_marker(data: &[u8]) {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const CREATE_ALWAYS: u32 = 2;
    const FILE_ATTRIBUTE_NORMAL: u32 = 128;

    let path = PATH.load(Ordering::Acquire);
    if path.is_null() {
        return;
    }
    // SAFETY: install()이 넣어 둔 널 종료 UTF-16 버퍼(누출됨 = 항상 유효)를 그대로 넘긴다.
    let h = unsafe {
        CreateFileW(
            path,
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if h.is_null() || h as isize == -1 {
        return;
    }
    // File로 감싸면 write_all(내부적으로 WriteFile)과 CloseHandle(Drop)을 std가 맡는다 —
    // 둘 다 할당하지 않는다. 실패해도 할 수 있는 게 없으므로 결과는 버린다.
    // SAFETY: 방금 연 핸들의 소유권을 그대로 넘긴다(이후 우리가 직접 닫지 않는다).
    let mut f = unsafe { std::fs::File::from_raw_handle(h.cast()) };
    let _ = f.write_all(data);
}

#[cfg(unix)]
fn write_marker(data: &[u8]) {
    let path = PATH.load(Ordering::Acquire);
    if path.is_null() {
        return;
    }
    // SAFETY: install()이 넣어 둔 널 종료 바이트 버퍼(누출됨 = 항상 유효).
    unsafe {
        let fd = libc::open(
            path.cast(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            0o644 as libc::c_uint,
        );
        if fd < 0 {
            return;
        }
        libc::write(fd, data.as_ptr().cast(), data.len());
        libc::close(fd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 래퍼가 정상 할당을 그대로 위임하는지 — 여기가 깨지면 앱 전체가 못 뜬다.
    #[test]
    fn wrapper_delegates_normal_allocations() {
        let v: Vec<u64> = (0..10_000).collect();
        assert_eq!(v.len(), 10_000);
        assert_eq!(v[9_999], 9_999);
        let mut s = String::new();
        for i in 0..1_000 {
            s.push_str(&i.to_string()); // realloc 경로
        }
        assert!(s.len() > 2_000);
        assert_eq!(*Box::new(42u8), 42);
    }

    /// 숫자 찍기(수동 itoa) 검증 — 여기가 틀리면 표식의 바이트 수가 거짓말이 된다.
    #[test]
    fn renders_marker_line() {
        let mut b = [0u8; 48];
        let n = render(0, &mut b);
        assert_eq!(&b[..n], b"alloc-fail bytes=0\n");
        let n = render(1_073_741_824, &mut b);
        assert_eq!(&b[..n], b"alloc-fail bytes=1073741824\n");
    }

    /// 실제 할당 실패는 만들 수 없으니 실패 경로를 직접 부른다.
    /// **이 테스트는 프로세스당 한 번만 의미가 있다**(FIRED가 1회용) — 그래서 하나뿐이다.
    #[test]
    fn note_failure_writes_marker_once() {
        let dir = tempfile::tempdir().expect("임시 디렉터리");
        install(dir.path());
        note_failure(1_234_567);

        let marker = dir.path().join(crate::health::session::ALLOC_FAIL);
        let text = std::fs::read_to_string(&marker).expect("표식 파일이 없다");
        assert_eq!(text, "alloc-fail bytes=1234567\n");

        // 재진입 차단 — 두 번째 호출은 파일을 덮어쓰지 않아야 한다.
        note_failure(999);
        let again = std::fs::read_to_string(&marker).expect("표식 파일이 사라졌다");
        assert_eq!(again, text, "두 번째 호출이 표식을 덮어썼다");
    }
}
