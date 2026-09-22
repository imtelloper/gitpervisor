//! DB 탐색기·diff·리포트·LLM 채팅 오류 문구 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.

use std::fmt::Display;

use super::{lang, Lang};

// ---- db.rs: 연결·키체인 ----

/// `state::save_json`의 `what` — "{what} 저장 실패"의 대상 이름.
pub fn db_connections_save_label() -> &'static str {
    match lang() {
        Lang::Ko => "연결",
        Lang::En => "DB connections",
    }
}

pub fn db_keychain_unavailable() -> &'static str {
    match lang() {
        Lang::Ko => "키체인 접근 실패 — 비밀번호를 저장할 수 없습니다",
        Lang::En => "Keychain access failed — cannot save the password",
    }
}

pub fn db_password_save_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("비밀번호 저장 실패: {e}"),
        Lang::En => format!("Failed to save password: {e}"),
    }
}

pub fn db_connection_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "연결을 찾을 수 없습니다",
        Lang::En => "Connection not found",
    }
}

pub fn db_not_connected() -> &'static str {
    match lang() {
        Lang::Ko => "연결되어 있지 않습니다 — 먼저 연결하세요",
        Lang::En => "Not connected — connect first",
    }
}

pub fn db_connect_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("연결 실패: {e}"),
        Lang::En => format!("Failed to connect: {e}"),
    }
}

pub fn db_connect_check_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("연결 확인 실패: {e}"),
        Lang::En => format!("Connection check failed: {e}"),
    }
}

pub fn db_connect_ping_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("연결 확인 실패(PING): {e}"),
        Lang::En => format!("Connection check failed (PING): {e}"),
    }
}

pub fn db_invalid_connection_string() -> &'static str {
    match lang() {
        Lang::Ko => "연결 문자열이 올바르지 않습니다 (호스트·옵션 확인)",
        Lang::En => "Invalid connection string (check host and options)",
    }
}

#[cfg(not(windows))]
pub fn db_mssql_integrated_auth_windows_only() -> &'static str {
    match lang() {
        Lang::Ko => "Windows 통합 인증(SSPI)은 Windows에서만 지원됩니다 — 사용자명/비밀번호로 로그인하세요",
        Lang::En => "Windows integrated authentication (SSPI) is only supported on Windows — sign in with a username and password",
    }
}

pub fn db_tcp_connect_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("TCP 연결 실패: {e}"),
        Lang::En => format!("TCP connection failed: {e}"),
    }
}

pub fn db_mssql_connect_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("SQL Server 연결/인증 실패: {e}"),
        Lang::En => format!("SQL Server connection/authentication failed: {e}"),
    }
}

pub fn db_sqlite_path_required() -> &'static str {
    match lang() {
        Lang::Ko => "SQLite는 데이터베이스 파일 경로가 필요합니다",
        Lang::En => "SQLite requires a database file path",
    }
}

// ---- db.rs: 목록·메타 조회 ----

pub fn db_list_databases_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("DB 목록 조회 실패: {e}"),
        Lang::En => format!("Failed to list databases: {e}"),
    }
}

pub fn db_collect_databases_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("DB 목록 수집 실패: {e}"),
        Lang::En => format!("Failed to read database list: {e}"),
    }
}

pub fn db_list_collections_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("컬렉션 목록 조회 실패: {e}"),
        Lang::En => format!("Failed to list collections: {e}"),
    }
}

pub fn db_list_tables_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("테이블 목록 조회 실패: {e}"),
        Lang::En => format!("Failed to list tables: {e}"),
    }
}

pub fn db_collect_tables_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("테이블 목록 수집 실패: {e}"),
        Lang::En => format!("Failed to read table list: {e}"),
    }
}

pub fn db_switch_database_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("DB 전환 실패: {e}"),
        Lang::En => format!("Failed to switch database: {e}"),
    }
}

pub fn db_meta_query_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("메타 조회 실패: {e}"),
        Lang::En => format!("Failed to query metadata: {e}"),
    }
}

pub fn db_meta_collect_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("메타 수집 실패: {e}"),
        Lang::En => format!("Failed to read metadata: {e}"),
    }
}

pub fn db_columns_query_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("컬럼 조회 실패: {e}"),
        Lang::En => format!("Failed to query columns: {e}"),
    }
}

pub fn db_table_meta_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "컬럼/키/인덱스는 SQL 엔진만 지원합니다",
        Lang::En => "Columns/keys/indexes are only available for SQL engines",
    }
}

pub fn db_table_meta_redis_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Redis는 컬럼/키/인덱스 메타가 없습니다",
        Lang::En => "Redis has no column/key/index metadata",
    }
}

pub fn db_procedures_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "저장 프로시저는 SQL 엔진만 지원합니다",
        Lang::En => "Stored procedures are only available for SQL engines",
    }
}

pub fn db_internal_error() -> &'static str {
    match lang() {
        Lang::Ko => "내부 오류",
        Lang::En => "Internal error",
    }
}

pub fn db_internal_not_sql_engine() -> &'static str {
    match lang() {
        Lang::Ko => "내부 오류: SQL 엔진이 아닙니다",
        Lang::En => "Internal error: not a SQL engine",
    }
}

// ---- db.rs: 쿼리·실행 계획 ----

pub fn db_read_only_sql_write_blocked() -> &'static str {
    match lang() {
        Lang::Ko => "읽기 전용 연결입니다 — 쓰기/DDL 문은 차단됩니다 (연결 편집에서 해제 가능)",
        Lang::En => "Read-only connection — write/DDL statements are blocked (turn it off in Edit connection)",
    }
}

pub fn db_query_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("쿼리 실패: {e}"),
        Lang::En => format!("Query failed: {e}"),
    }
}

pub fn db_collect_results_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("결과 수집 실패: {e}"),
        Lang::En => format!("Failed to read results: {e}"),
    }
}

/// 그리드 BLOB 셀 끝에 붙는 잘림 안내(앞 공백 포함).
pub fn db_blob_cell_truncated(total: usize, shown: usize) -> String {
    match lang() {
        Lang::Ko => format!(" …(전체 {total}바이트 중 {shown}바이트만 표시)"),
        Lang::En => format!(" …(showing {shown} of {total} bytes)"),
    }
}

pub fn db_explain_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "실행 계획은 SQL 엔진만 지원합니다",
        Lang::En => "Execution plans are only available for SQL engines",
    }
}

pub fn db_explain_redis_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Redis는 실행 계획을 지원하지 않습니다",
        Lang::En => "Redis does not support execution plans",
    }
}

pub fn db_plan_build_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("계획 생성 실패: {e}"),
        Lang::En => format!("Failed to generate plan: {e}"),
    }
}

pub fn db_plan_collect_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("계획 수집 실패: {e}"),
        Lang::En => format!("Failed to read plan: {e}"),
    }
}

pub fn db_plan_missing() -> &'static str {
    match lang() {
        Lang::Ko => "실행 계획을 받지 못했습니다",
        Lang::En => "No execution plan was returned",
    }
}

pub fn db_showplan_enable_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("SHOWPLAN 설정 실패: {e}"),
        Lang::En => format!("Failed to enable SHOWPLAN: {e}"),
    }
}

pub fn db_explain_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("실행 계획 실패: {e}"),
        Lang::En => format!("Failed to get execution plan: {e}"),
    }
}

// ---- db.rs: 그리드 편집·삭제·삽입 ----

pub fn db_read_only_edit_blocked() -> &'static str {
    match lang() {
        Lang::Ko => "읽기 전용 연결입니다 — 편집하려면 연결 설정에서 해제하세요",
        Lang::En => "Read-only connection — turn it off in the connection settings to edit",
    }
}

pub fn db_read_only_delete_blocked() -> &'static str {
    match lang() {
        Lang::Ko => "읽기 전용 연결입니다 — 삭제하려면 연결 설정에서 해제하세요",
        Lang::En => "Read-only connection — turn it off in the connection settings to delete",
    }
}

pub fn db_read_only_insert_blocked() -> &'static str {
    match lang() {
        Lang::Ko => "읽기 전용 연결입니다 — 삽입하려면 연결 설정에서 해제하세요",
        Lang::En => "Read-only connection — turn it off in the connection settings to insert",
    }
}

pub fn db_edit_needs_primary_key() -> &'static str {
    match lang() {
        Lang::Ko => "기본 키가 없어 안전하게 편집할 수 없습니다",
        Lang::En => "Cannot edit safely: the table has no primary key",
    }
}

pub fn db_delete_needs_primary_key() -> &'static str {
    match lang() {
        Lang::Ko => "기본 키가 없어 안전하게 삭제할 수 없습니다",
        Lang::En => "Cannot delete safely: the table has no primary key",
    }
}

pub fn db_cell_edit_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "셀 편집은 SQL 엔진만 지원합니다",
        Lang::En => "Cell editing is only available for SQL engines",
    }
}

pub fn db_cell_edit_redis_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Redis는 그리드 편집을 지원하지 않습니다 — 쿼리 콘솔을 쓰세요",
        Lang::En => "Redis does not support grid editing — use the query console",
    }
}

pub fn db_row_delete_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "행 삭제는 SQL 엔진만 지원합니다",
        Lang::En => "Row deletion is only available for SQL engines",
    }
}

pub fn db_row_delete_redis_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Redis는 그리드 삭제를 지원하지 않습니다 — DEL 명령을 쓰세요",
        Lang::En => "Redis does not support grid deletion — use the DEL command",
    }
}

pub fn db_insert_no_values() -> &'static str {
    match lang() {
        Lang::Ko => "입력할 값이 없습니다",
        Lang::En => "No values to insert",
    }
}

pub fn db_row_insert_sql_only() -> &'static str {
    match lang() {
        Lang::Ko => "행 삽입은 SQL 엔진만 지원합니다",
        Lang::En => "Row insertion is only available for SQL engines",
    }
}

pub fn db_row_insert_redis_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Redis는 그리드 삽입을 지원하지 않습니다 — SET/HSET 명령을 쓰세요",
        Lang::En => "Redis does not support grid insertion — use the SET/HSET commands",
    }
}

pub fn db_unsupported_value_type() -> &'static str {
    match lang() {
        Lang::Ko => "지원하지 않는 값 형식입니다",
        Lang::En => "Unsupported value type",
    }
}

pub fn db_not_an_integer(value: &str) -> String {
    match lang() {
        Lang::Ko => format!("정수가 아닙니다: {value}"),
        Lang::En => format!("Not an integer: {value}"),
    }
}

pub fn db_not_a_number(value: &str) -> String {
    match lang() {
        Lang::Ko => format!("숫자가 아닙니다: {value}"),
        Lang::En => format!("Not a number: {value}"),
    }
}

pub fn db_update_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("업데이트 실패: {e}"),
        Lang::En => format!("Failed to update: {e}"),
    }
}

pub fn db_update_no_matching_row() -> &'static str {
    match lang() {
        Lang::Ko => "일치하는 행이 없습니다 (이미 변경됐거나 삭제됨)",
        Lang::En => "No matching row (already changed or deleted)",
    }
}

pub fn db_update_pk_not_unique(rows: u64) -> String {
    match lang() {
        Lang::Ko => format!("{rows}개 행이 영향받음 — PK가 유일하지 않습니다(취소)"),
        Lang::En => format!("{rows} rows affected — the PK is not unique (cancelled)"),
    }
}

pub fn db_delete_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("삭제 실패: {e}"),
        Lang::En => format!("Failed to delete: {e}"),
    }
}

pub fn db_delete_no_matching_row() -> &'static str {
    match lang() {
        Lang::Ko => "일치하는 행이 없습니다 (이미 삭제됨)",
        Lang::En => "No matching row (already deleted)",
    }
}

pub fn db_delete_multiple_rows(rows: u64) -> String {
    match lang() {
        Lang::Ko => format!("{rows}개 행이 영향받음 — 취소"),
        Lang::En => format!("{rows} rows affected — cancelled"),
    }
}

pub fn db_insert_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("삽입 실패: {e}"),
        Lang::En => format!("Failed to insert: {e}"),
    }
}

pub fn db_insert_nothing_inserted() -> &'static str {
    match lang() {
        Lang::Ko => "삽입되지 않았습니다",
        Lang::En => "Nothing was inserted",
    }
}

// ---- db.rs: Redis ----

pub fn db_redis_select_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("DB 선택 실패: {e}"),
        Lang::En => format!("Failed to select database: {e}"),
    }
}

pub fn db_redis_scan_keys_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("키 조회 실패: {e}"),
        Lang::En => format!("Failed to list keys: {e}"),
    }
}

pub fn db_redis_command_required() -> &'static str {
    match lang() {
        Lang::Ko => "명령을 입력하세요 (예: GET key, HGETALL key)",
        Lang::En => "Enter a command (e.g. GET key, HGETALL key)",
    }
}

pub fn db_read_only_redis_write_blocked() -> &'static str {
    match lang() {
        Lang::Ko => "읽기 전용 연결입니다 — 쓰기 명령은 차단됩니다 (연결 편집에서 해제 가능)",
        Lang::En => "Read-only connection — write commands are blocked (turn it off in Edit connection)",
    }
}

pub fn db_redis_select_use_tree() -> &'static str {
    match lang() {
        Lang::Ko => "DB 전환은 왼쪽 트리에서 선택하세요",
        Lang::En => "Switch databases from the tree on the left",
    }
}

pub fn db_redis_command_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("명령 실패: {e}"),
        Lang::En => format!("Command failed: {e}"),
    }
}

pub fn db_redis_type_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("TYPE 실패: {e}"),
        Lang::En => format!("TYPE failed: {e}"),
    }
}

pub fn db_redis_read_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("읽기 실패: {e}"),
        Lang::En => format!("Failed to read: {e}"),
    }
}

/// 키 미리보기 그리드의 `info` 셀.
pub fn db_redis_type_preview_unsupported(key_type: &str) -> String {
    match lang() {
        Lang::Ko => format!("({key_type}) 타입 미리보기 미지원 — 쿼리 콘솔에서 명령을 입력하세요"),
        Lang::En => format!("No preview for type ({key_type}) — enter a command in the query console"),
    }
}

pub fn db_redis_unclosed_quote() -> &'static str {
    match lang() {
        Lang::Ko => "따옴표가 닫히지 않았습니다",
        Lang::En => "Unclosed quote",
    }
}

// ---- db.rs: Mongo ----

pub fn db_mongo_collection_missing() -> &'static str {
    match lang() {
        Lang::Ko => "컬렉션을 찾지 못함 — 예: db.getCollection(\"이름\").find({})",
        Lang::En => "Collection not found — e.g. db.getCollection(\"name\").find({})",
    }
}

pub fn db_mongo_aggregate_json_invalid(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("aggregate 인자 JSON 오류: {e}"),
        Lang::En => format!("Invalid JSON in aggregate argument: {e}"),
    }
}

pub fn db_mongo_aggregate_not_array() -> &'static str {
    match lang() {
        Lang::Ko => "aggregate 인자는 배열이어야 합니다",
        Lang::En => "The aggregate argument must be an array",
    }
}

pub fn db_mongo_find_json_invalid(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("find 필터 JSON 오류: {e}"),
        Lang::En => format!("Invalid JSON in find filter: {e}"),
    }
}

pub fn db_mongo_unsupported_query() -> &'static str {
    match lang() {
        Lang::Ko => "지원 형식: db.getCollection(\"이름\").find({...}) 또는 .aggregate([...])",
        Lang::En => "Supported forms: db.getCollection(\"name\").find({...}) or .aggregate([...])",
    }
}

pub fn db_mongo_write_op_blocked(op: &str) -> String {
    match lang() {
        Lang::Ko => format!("쓰기 연산 '{op}'는 읽기 전용 뷰어에서 차단됩니다"),
        Lang::En => format!("Write operation '{op}' is blocked in the read-only viewer"),
    }
}

pub fn db_mongo_server_js_blocked(op: &str) -> String {
    match lang() {
        Lang::Ko => format!("서버측 JS '{op}'는 읽기 전용 연결에서 차단됩니다"),
        Lang::En => format!("Server-side JS '{op}' is blocked on read-only connections"),
    }
}

// ---- commands/diff.rs ----

pub fn diff_file_metadata_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 정보 조회 실패: {e}"),
        Lang::En => format!("Failed to read file info: {e}"),
    }
}

pub fn diff_file_read_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 읽기 실패: {e}"),
        Lang::En => format!("Failed to read file: {e}"),
    }
}

pub fn diff_invalid_commit_hash() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 커밋 해시입니다",
        Lang::En => "Invalid commit hash",
    }
}

pub fn diff_invalid_file_path() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 파일 경로입니다",
        Lang::En => "Invalid file path",
    }
}

pub fn diff_image_file_too_large() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 큽니다 (25MB 초과)",
        Lang::En => "File is too large (over 25MB)",
    }
}

// ---- report.rs ----

pub fn report_range_format_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "기간은 YYYY-MM-DD 형식이어야 합니다",
        Lang::En => "Date range must be in YYYY-MM-DD format",
    }
}

pub fn report_range_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 기간입니다",
        Lang::En => "Invalid date range",
    }
}

pub fn report_git_log_failed() -> &'static str {
    match lang() {
        Lang::Ko => "git log 실패",
        Lang::En => "git log failed",
    }
}

pub fn report_home_dir_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "홈 디렉토리를 찾을 수 없습니다",
        Lang::En => "Home directory not found",
    }
}

pub fn report_transcript_scan_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("전사 스캔 실패: {e}"),
        Lang::En => format!("Failed to scan transcripts: {e}"),
    }
}

// ---- llm/chat.rs ----

pub fn llm_chat_busy() -> &'static str {
    match lang() {
        Lang::Ko => "다른 AI 요청이 진행 중입니다",
        Lang::En => "Another AI request is in progress",
    }
}

pub fn llm_chat_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "AI 요청을 취소했습니다",
        Lang::En => "AI request cancelled",
    }
}

pub fn llm_chat_timeout() -> &'static str {
    match lang() {
        Lang::Ko => "AI 응답 시간 초과(10분) — 서버 상태를 확인하세요",
        Lang::En => "AI response timed out (10 min) — check the server status",
    }
}

pub fn llm_chat_request_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("AI 요청 실패: {e}"),
        Lang::En => format!("AI request failed: {e}"),
    }
}

pub fn llm_chat_server_error(status: impl Display, detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("AI 서버 오류 {status}: {detail}"),
        Lang::En => format!("AI server error {status}: {detail}"),
    }
}

pub fn llm_chat_receive_failed(e: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("응답 수신 실패: {e}"),
        Lang::En => format!("Failed to receive response: {e}"),
    }
}
