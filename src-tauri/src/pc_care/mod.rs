//! 리소스 모니터 PC 관리 탭들(GoClean 분석에서 고른 기능) — 설계 DOCS/pc-care-design.md.
//! 기능마다 파일 하나, 승격(관리자 권한 실행)은 `elevate` 한 곳에서만 한다.

pub mod activex;
pub mod cleanup;
pub mod cpu_temp;
pub mod crash_history;
pub mod disk_health;
pub mod elevate;
pub mod file_locks;
pub mod gpu_temp;
pub mod installed_apps;
pub mod scheduled_tasks;
pub mod services;
pub mod startup_items;
