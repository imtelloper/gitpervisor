fn main() {
    // 아이콘(icon.ico) 변경 시 빌드 스크립트가 리소스를 다시 임베드하도록 재실행 트리거
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
