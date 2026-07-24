use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use futures::stream::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Decimal128, Document};
use mongodb::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
// sqlx 트레이트 메서드(.try_get/.columns/.name/.type_info/.is_null)만 익명(as _)으로 들여온다 —
// 로컬 `Column` 구조체와 이름 충돌을 피하면서 AnyRow/AnyColumn의 메서드를 쓰기 위함.
use sqlx::{Column as _, Row as _, TypeInfo as _, ValueRef as _};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use tiberius::{AuthMethod, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::error::{ErrorCode, IpcError};

/// SQL Server(TDS) 클라이언트 — 단일 연결이라 &mut가 필요해 tokio Mutex로 감싼다.
type MssqlClient = tiberius::Client<Compat<TcpStream>>;

/// 활성 연결 핸들. Mongo Client는 풀이라 clone 가능, MSSQL은 단일 연결이라 Arc<Mutex>.
/// Sql(AnyPool)은 PostgreSQL/MySQL/SQLite 공용 — Any 드라이버가 URL 스킴으로 분기한다.
/// 어느 엔진인지(메타·EXPLAIN·식별자 인용 분기)는 DbEngine을 함께 들고 다닌다.
#[derive(Clone)]
enum DbClient {
    Mongo(Client),
    Mssql(Arc<tokio::sync::Mutex<MssqlClient>>),
    Sql(sqlx::AnyPool, DbEngine),
    /// Redis(키-값) — ConnectionManager는 Clone 가능(내부 Arc, 자동 재연결).
    Redis(redis::aio::ConnectionManager),
}

const CONN_FILE: &str = "connections.json";
const CONN_KEY: &str = "connections";
const KEYRING_SERVICE: &str = "gitpervisor-db";
const ROW_LIMIT: i64 = 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Mongodb,
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
    Redis,
}

/// 연결 메타 — 비밀번호는 포함하지 않는다(OS 키체인 저장).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    pub id: String,
    pub name: String,
    pub engine: DbEngine,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: String,
    /// URI 옵션 (예: "authSource=admin&tls=true")
    #[serde(default)]
    pub options: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub type_name: Option<String>,
}

/// 통합 결과 — SQL/Mongo 공통. 셀은 타입 보존 JSON.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Json>>,
    pub row_count: usize,
}

// ---- 오브젝트 탐색기 메타(SQL 엔진) ----
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub pk: bool,
    /// IDENTITY 컬럼(자동 증가) — INSERT에서 제외
    pub identity: bool,
    /// 기본값 제약 있음 — INSERT에서 생략 가능
    pub has_default: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    /// "PRIMARY KEY" | "UNIQUE" | "FOREIGN KEY"
    pub kind: String,
    pub columns: Vec<String>,
    /// FK일 때 참조 대상 "schema.table(col)"
    pub references: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// "CLUSTERED" | "NONCLUSTERED" 등
    pub kind: String,
    pub unique: bool,
    pub columns: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    /// "CHECK" | "DEFAULT"
    pub kind: String,
    /// DEFAULT는 대상 컬럼
    pub column: Option<String>,
    pub definition: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// "INSERT, UPDATE" 등
    pub events: String,
    pub disabled: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnInfo>,
    pub keys: Vec<KeyInfo>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
}

pub struct DbState {
    connections: RwLock<Vec<DbConnection>>,
    /// 활성 연결 (connId → 엔진별 클라이언트).
    clients: Mutex<HashMap<String, DbClient>>,
}

impl DbState {
    pub fn new(connections: Vec<DbConnection>) -> Self {
        Self {
            connections: RwLock::new(connections),
            clients: Mutex::new(HashMap::new()),
        }
    }
}

// ---- 영속화 ----
pub fn load_connections(app: &AppHandle) -> Vec<DbConnection> {
    let Ok(store) = app.store(CONN_FILE) else {
        return Vec::new();
    };
    let Some(v) = store.get(CONN_KEY) else {
        return Vec::new();
    };
    serde_json::from_value(v).unwrap_or_default()
}

fn save_connections(app: &AppHandle, conns: &[DbConnection]) -> Result<(), IpcError> {
    let store = app
        .store(CONN_FILE)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("스토어 열기 실패: {e}")))?;
    store.set(CONN_KEY, serde_json::json!(conns));
    store
        .save()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("연결 저장 실패: {e}")))
}

// ---- 키체인 ----
fn keyring_entry(conn_id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, conn_id).ok()
}
fn store_password(conn_id: &str, password: &str) -> Result<(), IpcError> {
    let entry =
        keyring_entry(conn_id).ok_or_else(|| err("키체인 접근 실패 — 비밀번호를 저장할 수 없습니다"))?;
    entry
        .set_password(password)
        .map_err(|e| err(format!("비밀번호 저장 실패: {e}")))
}
fn read_password(conn_id: &str) -> Option<String> {
    keyring_entry(conn_id).and_then(|e| e.get_password().ok())
}
fn delete_password(conn_id: &str) {
    if let Some(entry) = keyring_entry(conn_id) {
        // NoEntry(이미 없음)는 정상 — 그 외 실패는 고아 자격증명을 남기므로 경고
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(e) => eprintln!("[db] 키체인 자격증명 삭제 실패 {conn_id}: {e}"),
        }
    }
}

fn err(msg: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::Io, msg)
}

// ---- 커맨드: 연결 관리 ----
#[tauri::command]
pub fn db_list_connections(state: State<'_, DbState>) -> Vec<DbConnection> {
    state.connections.read().unwrap().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnection {
    pub connection: DbConnection,
    /// 빈 문자열/None이면 기존 비밀번호 유지
    pub password: Option<String>,
}

#[tauri::command]
pub fn db_save_connection(
    app: AppHandle,
    state: State<'_, DbState>,
    payload: SaveConnection,
) -> Result<DbConnection, IpcError> {
    let conn = payload.connection;
    if let Some(pw) = payload.password.filter(|p| !p.is_empty()) {
        store_password(&conn.id, &pw)?;
    }
    // 편집 시 기존 활성 클라이언트를 버려 다음 조회가 새 설정/비밀번호로 재연결되게 한다
    state.clients.lock().unwrap().remove(&conn.id);
    {
        let mut conns = state.connections.write().unwrap();
        if let Some(existing) = conns.iter_mut().find(|c| c.id == conn.id) {
            *existing = conn.clone();
        } else {
            conns.push(conn.clone());
        }
    }
    save_connections(&app, &state.connections.read().unwrap())?;
    Ok(conn)
}

#[tauri::command]
pub fn db_delete_connection(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), IpcError> {
    state.connections.write().unwrap().retain(|c| c.id != id);
    state.clients.lock().unwrap().remove(&id);
    delete_password(&id);
    save_connections(&app, &state.connections.read().unwrap())
}

// ---- 커맨드: 연결/조회 ----
#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, id: String) -> Result<(), IpcError> {
    let conn = state
        .connections
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "연결을 찾을 수 없습니다"))?;

    let password = read_password(&conn.id);
    let client = match conn.engine {
        DbEngine::Mongodb => {
            let c = build_mongo_client(&conn, password).await?;
            // 연결 확인 — ping (listDatabases 권한 불필요; 인증은 핸드셰이크에서 검증).
            c.database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(|e| err(format!("연결 실패: {e}")))?;
            DbClient::Mongo(c)
        }
        DbEngine::Mssql => {
            // connect 성공 = 로그인/인증 성공 (TDS 핸드셰이크에서 검증).
            let c = build_mssql_client(&conn, password).await?;
            DbClient::Mssql(Arc::new(tokio::sync::Mutex::new(c)))
        }
        DbEngine::Postgres | DbEngine::Mysql | DbEngine::Sqlite => {
            let pool = build_sql_client(&conn, password, conn.engine).await?;
            // 연결 확인 — 가벼운 쿼리(인증/파일열기 검증).
            sqlx::query("SELECT 1")
                .fetch_optional(&pool)
                .await
                .map_err(|e| err(format!("연결 확인 실패: {e}")))?;
            DbClient::Sql(pool, conn.engine)
        }
        DbEngine::Redis => {
            let mut cm = build_redis_client(&conn, password).await?;
            // 연결 확인 — PING.
            redis::cmd("PING")
                .query_async::<String>(&mut cm)
                .await
                .map_err(|e| err(format!("연결 확인 실패(PING): {e}")))?;
            DbClient::Redis(cm)
        }
    };

    state.clients.lock().unwrap().insert(id, client);
    Ok(())
}

#[tauri::command]
pub fn db_disconnect(state: State<'_, DbState>, id: String) {
    state.clients.lock().unwrap().remove(&id);
}

#[tauri::command]
pub async fn db_databases(
    state: State<'_, DbState>,
    id: String,
) -> Result<Vec<String>, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mongo(c) => c
            .list_database_names()
            .await
            .map_err(|e| err(format!("DB 목록 조회 실패: {e}"))),
        DbClient::Mssql(c) => mssql_databases(&c).await,
        DbClient::Sql(pool, engine) => sql_databases(&pool, engine).await,
        DbClient::Redis(mut cm) => redis_databases(&mut cm).await,
    }
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbState>,
    id: String,
    database: String,
) -> Result<Vec<String>, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mongo(c) => c
            .database(&database)
            .list_collection_names()
            .await
            .map_err(|e| err(format!("컬렉션 목록 조회 실패: {e}"))),
        DbClient::Mssql(c) => mssql_tables(&c, &database).await,
        DbClient::Sql(pool, engine) => sql_tables(&pool, engine, &database).await,
        DbClient::Redis(mut cm) => redis_tables(&mut cm, &database).await,
    }
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    id: String,
    database: String,
    query: String,
    limit: Option<i64>,
) -> Result<DbResult, IpcError> {
    // 연결의 읽기 전용 플래그 — 쓰기/서버JS 차단 판정에 쓴다
    let read_only = state
        .connections
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.read_only)
        .unwrap_or(false);
    let limit = limit.unwrap_or(ROW_LIMIT).clamp(1, ROW_LIMIT);
    match client_of(&state, &id)? {
        DbClient::Mongo(c) => mongo_query(&c, &database, &query, limit, read_only).await,
        DbClient::Mssql(c) => mssql_query(&c, &database, &query, limit, read_only).await,
        DbClient::Sql(pool, engine) => {
            sql_query(&pool, engine, &query, limit, read_only).await
        }
        DbClient::Redis(mut cm) => {
            redis_query(&mut cm, &database, &query, limit, read_only).await
        }
    }
}

/// 테이블의 컬럼/키/인덱스 메타 (SQL 엔진 전용 — 오브젝트 탐색기).
#[tauri::command]
pub async fn db_table_meta(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
) -> Result<TableMeta, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_table_meta(&c, &database, &table).await,
        DbClient::Sql(pool, engine) => sql_table_meta(&pool, engine, &table).await,
        DbClient::Mongo(_) => Err(err("컬럼/키/인덱스는 SQL 엔진만 지원합니다")),
        DbClient::Redis(_) => Err(err("Redis는 컬럼/키/인덱스 메타가 없습니다")),
    }
}

/// 예상 실행 계획(ShowPlan XML) — 쿼리를 실행하지 않고 계획만 받는다 (SQL 엔진 전용).
#[tauri::command]
pub async fn db_explain(
    state: State<'_, DbState>,
    id: String,
    database: String,
    query: String,
) -> Result<String, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_explain(&c, &database, &query).await,
        DbClient::Sql(pool, engine) => sql_explain(&pool, engine, &query).await,
        DbClient::Mongo(_) => Err(err("실행 계획은 SQL 엔진만 지원합니다")),
        DbClient::Redis(_) => Err(err("Redis는 실행 계획을 지원하지 않습니다")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkCell {
    pub col: String,
    pub value: Json,
}

/// 그리드 셀 직접 편집 — PK로 한 행을 UPDATE (SQL 엔진, read_only 아닐 때만).
#[tauri::command]
pub async fn db_update_cell(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
    pk: Vec<PkCell>,
    set_col: String,
    set_value: Json,
) -> Result<(), IpcError> {
    let read_only = state
        .connections
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.read_only)
        .unwrap_or(false);
    if read_only {
        return Err(err("읽기 전용 연결입니다 — 편집하려면 연결 설정에서 해제하세요"));
    }
    if pk.is_empty() {
        return Err(err("기본 키가 없어 안전하게 편집할 수 없습니다"));
    }
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => {
            mssql_update_cell(&c, &database, &table, &pk, &set_col, &set_value).await
        }
        DbClient::Sql(pool, engine) => {
            sql_update_cell(&pool, engine, &table, &pk, &set_col, &set_value).await
        }
        DbClient::Mongo(_) => Err(err("셀 편집은 SQL 엔진만 지원합니다")),
        DbClient::Redis(_) => Err(err("Redis는 그리드 편집을 지원하지 않습니다 — 쿼리 콘솔을 쓰세요")),
    }
}

/// 그리드 행 삭제 — PK로 한 행을 DELETE (SQL 엔진, read_only 아닐 때만).
#[tauri::command]
pub async fn db_delete_row(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
    pk: Vec<PkCell>,
) -> Result<(), IpcError> {
    if read_only_of(&state, &id) {
        return Err(err("읽기 전용 연결입니다 — 삭제하려면 연결 설정에서 해제하세요"));
    }
    if pk.is_empty() {
        return Err(err("기본 키가 없어 안전하게 삭제할 수 없습니다"));
    }
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_delete_row(&c, &database, &table, &pk).await,
        DbClient::Sql(pool, engine) => sql_delete_row(&pool, engine, &table, &pk).await,
        DbClient::Mongo(_) => Err(err("행 삭제는 SQL 엔진만 지원합니다")),
        DbClient::Redis(_) => Err(err("Redis는 그리드 삭제를 지원하지 않습니다 — DEL 명령을 쓰세요")),
    }
}

/// 그리드 행 삽입 — 제공된 컬럼만 INSERT (identity/기본값은 생략 가능).
#[tauri::command]
pub async fn db_insert_row(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
    values: Vec<PkCell>,
) -> Result<(), IpcError> {
    if read_only_of(&state, &id) {
        return Err(err("읽기 전용 연결입니다 — 삽입하려면 연결 설정에서 해제하세요"));
    }
    if values.is_empty() {
        return Err(err("입력할 값이 없습니다"));
    }
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_insert_row(&c, &database, &table, &values).await,
        DbClient::Sql(pool, engine) => sql_insert_row(&pool, engine, &table, &values).await,
        DbClient::Mongo(_) => Err(err("행 삽입은 SQL 엔진만 지원합니다")),
        DbClient::Redis(_) => Err(err("Redis는 그리드 삽입을 지원하지 않습니다 — SET/HSET 명령을 쓰세요")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcParam {
    pub name: String,
    pub type_name: String,
    pub output: bool,
    pub has_default: bool,
}

/// DB의 저장 프로시저 목록 (schema.proc).
#[tauri::command]
pub async fn db_procedures(
    state: State<'_, DbState>,
    id: String,
    database: String,
) -> Result<Vec<String>, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_procedures(&c, &database).await,
        // PG/MySQL/SQLite 프로시저 탐색은 v1 범위 밖 — 빈 목록(테이블/쿼리 기능엔 영향 없음).
        DbClient::Sql(_, _) | DbClient::Redis(_) => Ok(Vec::new()),
        DbClient::Mongo(_) => Err(err("저장 프로시저는 SQL 엔진만 지원합니다")),
    }
}

/// 저장 프로시저의 파라미터 목록 (EXEC 템플릿 생성용).
#[tauri::command]
pub async fn db_proc_params(
    state: State<'_, DbState>,
    id: String,
    database: String,
    proc: String,
) -> Result<Vec<ProcParam>, IpcError> {
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_proc_params(&c, &database, &proc).await,
        DbClient::Sql(_, _) | DbClient::Redis(_) => Ok(Vec::new()),
        DbClient::Mongo(_) => Err(err("저장 프로시저는 SQL 엔진만 지원합니다")),
    }
}

fn read_only_of(state: &State<'_, DbState>, id: &str) -> bool {
    state
        .connections
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.read_only)
        .unwrap_or(false)
}

fn client_of(state: &State<'_, DbState>, id: &str) -> Result<DbClient, IpcError> {
    state
        .clients
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "연결되어 있지 않습니다 — 먼저 연결하세요"))
}

// ---- Mongo 드라이버 ----
async fn build_mongo_client(
    conn: &DbConnection,
    password: Option<String>,
) -> Result<Client, IpcError> {
    let mut uri = String::from("mongodb://");
    if !conn.username.is_empty() {
        uri.push_str(&pct(&conn.username));
        if let Some(pw) = &password {
            uri.push(':');
            uri.push_str(&pct(pw));
        }
        uri.push('@');
    }
    uri.push_str(&conn.host);
    uri.push(':');
    uri.push_str(&conn.port.to_string());
    uri.push('/');
    if let Some(opts) = conn.options.as_ref().filter(|o| !o.trim().is_empty()) {
        uri.push('?');
        uri.push_str(opts.trim());
    }
    // 원시 드라이버 에러는 연결 URI(비밀번호 포함)를 에코할 수 있어 고정 문구로 대체(로그 유출 방지).
    Client::with_uri_str(&uri)
        .await
        .map_err(|_| err("연결 문자열이 올바르지 않습니다 (호스트·옵션 확인)".to_string()))
}

/// userinfo용 퍼센트 인코딩 (unreserved 외 인코딩)
fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---- SQL Server(TDS) 드라이버 ----

async fn build_mssql_client(
    conn: &DbConnection,
    password: Option<String>,
) -> Result<MssqlClient, IpcError> {
    let mut config = Config::new();
    config.host(&conn.host);
    config.port(conn.port);
    // Windows 통합 인증(SSPI) — 사용자명이 비었거나 trusted_connection/integrated 옵션이 있으면
    // 현재 Windows 사용자로 로그인(SQL 인증이 막힌 Windows-only 모드 서버 대응).
    let opts_lc = conn.options.as_deref().unwrap_or("").to_ascii_lowercase();
    if conn.username.trim().is_empty()
        || opts_lc.contains("trusted_connection=yes")
        || opts_lc.contains("trustedconnection=yes")
        || opts_lc.contains("integrated")
    {
        // 통합 인증(SSPI)은 tiberius 에서 Windows 전용 변종이라 Linux 빌드엔 존재하지 않는다.
        // cfg 로 가드하고, 비-Windows에서 통합인증을 요청하면 명확한 에러로 안내한다.
        #[cfg(windows)]
        {
            config.authentication(AuthMethod::Integrated);
        }
        #[cfg(not(windows))]
        {
            return Err(err(
                "Windows 통합 인증(SSPI)은 Windows에서만 지원됩니다 — 사용자명/비밀번호로 로그인하세요",
            ));
        }
    } else {
        config.authentication(AuthMethod::sql_server(
            &conn.username,
            password.as_deref().unwrap_or(""),
        ));
    }
    if let Some(db) = conn.database.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        config.database(db);
    }
    let opts = conn.options.as_deref().unwrap_or("");
    // 내부 서버는 자체서명 인증서가 흔하다 — 기본 신뢰, 옵션으로 끔(trustServerCertificate=false)
    if !opts.contains("trustServerCertificate=false") {
        config.trust_cert();
    }
    // TLS 미지원 서버는 encrypt=false 로 평문 협상
    if opts.contains("encrypt=false") {
        config.encryption(EncryptionLevel::NotSupported);
    }
    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|e| err(format!("TCP 연결 실패: {e}")))?;
    tcp.set_nodelay(true).ok();
    tiberius::Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| err(format!("SQL Server 연결/인증 실패: {e}")))
}

async fn mssql_databases(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
) -> Result<Vec<String>, IpcError> {
    let mut client = arc.lock().await;
    let rows = client
        .simple_query("SELECT name FROM sys.databases ORDER BY name")
        .await
        .map_err(|e| err(format!("DB 목록 조회 실패: {e}")))?
        .into_first_result()
        .await
        .map_err(|e| err(format!("DB 목록 수집 실패: {e}")))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<&str, _>(0).ok().flatten().map(str::to_string))
        .collect())
}

async fn mssql_tables(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
) -> Result<Vec<String>, IpcError> {
    // 3부 이름으로 대상 DB의 테이블·뷰를 한 번에 (USE 없이). schema.table 형태로 반환.
    let q = format!(
        "SELECT TABLE_SCHEMA + '.' + TABLE_NAME FROM [{}].INFORMATION_SCHEMA.TABLES \
         WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME",
        database.replace(']', "]]")
    );
    let mut client = arc.lock().await;
    let rows = client
        .simple_query(q)
        .await
        .map_err(|e| err(format!("테이블 목록 조회 실패: {e}")))?
        .into_first_result()
        .await
        .map_err(|e| err(format!("테이블 목록 수집 실패: {e}")))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<&str, _>(0).ok().flatten().map(str::to_string))
        .collect())
}

async fn mssql_query(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    query: &str,
    limit: i64,
    read_only: bool,
) -> Result<DbResult, IpcError> {
    if read_only && is_write_sql(query) {
        return Err(err(
            "읽기 전용 연결입니다 — 쓰기/DDL 문은 차단됩니다 (연결 편집에서 해제 가능)",
        ));
    }
    let mut batch = String::new();
    if !database.trim().is_empty() {
        batch.push_str(&format!("USE [{}];\n", database.replace(']', "]]")));
    }
    batch.push_str(query);

    let mut client = arc.lock().await;
    let mut stream = client
        .simple_query(batch)
        .await
        .map_err(|e| err(format!("쿼리 실패: {e}")))?;

    let mut cols: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Json>> = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| err(format!("결과 수집 실패: {e}")))?
    {
        match item {
            QueryItem::Metadata(_) => {}
            QueryItem::Row(row) => {
                if cols.is_empty() {
                    cols = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                // limit까지만 적재하되, 스트림은 끝까지 읽어 연결 상태를 유지한다
                if (rows.len() as i64) < limit {
                    let cells = (0..row.columns().len())
                        .map(|i| mssql_cell_to_json(&row, i))
                        .collect();
                    rows.push(cells);
                }
            }
        }
    }

    let row_count = rows.len();
    Ok(DbResult {
        columns: cols
            .into_iter()
            .map(|name| Column { name, type_name: None })
            .collect(),
        rows,
        row_count,
    })
}

/// SQL Server 셀 → JSON. 일치하는 첫 타입으로 변환(불일치는 Err라 다음으로 넘어간다).
fn mssql_cell_to_json(row: &tiberius::Row, i: usize) -> Json {
    use serde_json::json;
    macro_rules! attempt {
        ($t:ty => $conv:expr) => {
            match row.try_get::<$t, _>(i) {
                Ok(Some(v)) => return $conv(v),
                Ok(None) => return Json::Null,
                Err(_) => {}
            }
        };
    }
    attempt!(&str => |v: &str| json!(v));
    attempt!(i32 => |v: i32| json!(v));
    attempt!(i64 => |v: i64| json!(v));
    attempt!(i16 => |v: i16| json!(v));
    attempt!(u8 => |v: u8| json!(v));
    attempt!(bool => |v: bool| json!(v));
    attempt!(f32 => |v: f32| json!(v));
    attempt!(f64 => |v: f64| json!(v));
    attempt!(rust_decimal::Decimal => |v: rust_decimal::Decimal| json!(v.to_string()));
    attempt!(chrono::DateTime<chrono::Utc> => |v: chrono::DateTime<chrono::Utc>| json!(v.to_rfc3339()));
    attempt!(chrono::NaiveDateTime => |v: chrono::NaiveDateTime| json!(v.to_string()));
    attempt!(chrono::NaiveDate => |v: chrono::NaiveDate| json!(v.to_string()));
    attempt!(chrono::NaiveTime => |v: chrono::NaiveTime| json!(v.to_string()));
    attempt!(uuid::Uuid => |v: uuid::Uuid| json!(v.to_string()));
    attempt!(&[u8] => |v: &[u8]| json!(format!(
        "0x{}",
        v.iter().map(|b| format!("{b:02X}")).collect::<String>()
    )));
    Json::Null
}

async fn run_explain_inner(client: &mut MssqlClient, query: &str) -> Result<String, IpcError> {
    let rows = client
        .simple_query(query)
        .await
        .map_err(|e| err(format!("계획 생성 실패: {e}")))?
        .into_first_result()
        .await
        .map_err(|e| err(format!("계획 수집 실패: {e}")))?;
    rows.first()
        .and_then(|r| r.try_get::<&str, _>(0).ok().flatten())
        .map(str::to_string)
        .ok_or_else(|| err("실행 계획을 받지 못했습니다"))
}

/// JSON 값 → 타입에 맞는 SQL 리터럴(주입 안전: 숫자는 검증, 문자열은 '' 이스케이프).
fn sql_literal(v: &Json, data_type: &str) -> Result<String, IpcError> {
    if v.is_null() {
        return Ok("NULL".to_string());
    }
    let s = match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        _ => return Err(err("지원하지 않는 값 형식입니다")),
    };
    match data_type.to_ascii_lowercase().as_str() {
        "bit" => {
            let truthy = matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "t" | "y" | "yes"
            );
            Ok(if truthy { "1".into() } else { "0".into() })
        }
        "int" | "bigint" | "smallint" | "tinyint" => {
            s.trim()
                .parse::<i64>()
                .map_err(|_| err(format!("정수가 아닙니다: {s}")))?;
            Ok(s.trim().to_string())
        }
        "decimal" | "numeric" | "float" | "real" | "money" | "smallmoney" => {
            s.trim()
                .parse::<f64>()
                .map_err(|_| err(format!("숫자가 아닙니다: {s}")))?;
            Ok(s.trim().to_string())
        }
        "uniqueidentifier" => Ok(format!(
            "CAST(N'{}' AS uniqueidentifier)",
            s.replace('\'', "''")
        )),
        dt @ ("date" | "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset" | "time") => {
            Ok(format!("CAST(N'{}' AS {})", s.replace('\'', "''"), dt))
        }
        // varchar/nvarchar/char/text 등 및 기타 → 유니코드 문자열 리터럴
        _ => Ok(format!("N'{}'", s.replace('\'', "''"))),
    }
}

/// 테이블의 컬럼 → DATA_TYPE 맵.
async fn mssql_column_types(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, String>, IpcError> {
    let q = format!(
        "SELECT COLUMN_NAME, DATA_TYPE FROM [{}].INFORMATION_SCHEMA.COLUMNS \
         WHERE TABLE_SCHEMA=N'{}' AND TABLE_NAME=N'{}'",
        database.replace(']', "]]"),
        schema.replace('\'', "''"),
        table.replace('\'', "''")
    );
    let mut client = arc.lock().await;
    let rows = run_rows(&mut client, &q).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let c = gstr(r, 0);
            if c.is_empty() {
                None
            } else {
                Some((c, gstr(r, 1)))
            }
        })
        .collect())
}

async fn mssql_update_cell(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    table: &str,
    pk: &[PkCell],
    set_col: &str,
    set_value: &Json,
) -> Result<(), IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    let types = mssql_column_types(arc, database, schema, name).await?;
    let ty = |c: &str| types.get(c).map(String::as_str).unwrap_or("");
    let qcol = |c: &str| format!("[{}]", c.replace(']', "]]"));

    let set_lit = sql_literal(set_value, ty(set_col))?;
    let mut where_parts = Vec::new();
    for p in pk {
        if p.value.is_null() {
            where_parts.push(format!("{} IS NULL", qcol(&p.col)));
        } else {
            where_parts.push(format!("{} = {}", qcol(&p.col), sql_literal(&p.value, ty(&p.col))?));
        }
    }
    let sql = format!(
        "UPDATE [{}].[{}].[{}] SET {} = {} WHERE {}",
        database.replace(']', "]]"),
        schema.replace(']', "]]"),
        name.replace(']', "]]"),
        qcol(set_col),
        set_lit,
        where_parts.join(" AND ")
    );

    let mut client = arc.lock().await;
    let res = client
        .execute(sql, &[])
        .await
        .map_err(|e| err(format!("업데이트 실패: {e}")))?;
    match res.total() {
        0 => Err(err("일치하는 행이 없습니다 (이미 변경됐거나 삭제됨)")),
        1 => Ok(()),
        n => Err(err(format!("{n}개 행이 영향받음 — PK가 유일하지 않습니다(취소)"))),
    }
}

async fn mssql_delete_row(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    table: &str,
    pk: &[PkCell],
) -> Result<(), IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    let types = mssql_column_types(arc, database, schema, name).await?;
    let ty = |c: &str| types.get(c).map(String::as_str).unwrap_or("");
    let qcol = |c: &str| format!("[{}]", c.replace(']', "]]"));
    let mut where_parts = Vec::new();
    for p in pk {
        if p.value.is_null() {
            where_parts.push(format!("{} IS NULL", qcol(&p.col)));
        } else {
            where_parts.push(format!("{} = {}", qcol(&p.col), sql_literal(&p.value, ty(&p.col))?));
        }
    }
    let sql = format!(
        "DELETE FROM [{}].[{}].[{}] WHERE {}",
        database.replace(']', "]]"),
        schema.replace(']', "]]"),
        name.replace(']', "]]"),
        where_parts.join(" AND ")
    );
    let mut client = arc.lock().await;
    let res = client
        .execute(sql, &[])
        .await
        .map_err(|e| err(format!("삭제 실패: {e}")))?;
    match res.total() {
        0 => Err(err("일치하는 행이 없습니다 (이미 삭제됨)")),
        1 => Ok(()),
        n => Err(err(format!("{n}개 행이 영향받음 — 취소"))),
    }
}

async fn mssql_insert_row(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    table: &str,
    values: &[PkCell],
) -> Result<(), IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    let types = mssql_column_types(arc, database, schema, name).await?;
    let ty = |c: &str| types.get(c).map(String::as_str).unwrap_or("");
    let qcol = |c: &str| format!("[{}]", c.replace(']', "]]"));
    let cols: Vec<String> = values.iter().map(|v| qcol(&v.col)).collect();
    let mut lits = Vec::with_capacity(values.len());
    for v in values {
        lits.push(sql_literal(&v.value, ty(&v.col))?);
    }
    let sql = format!(
        "INSERT INTO [{}].[{}].[{}] ({}) VALUES ({})",
        database.replace(']', "]]"),
        schema.replace(']', "]]"),
        name.replace(']', "]]"),
        cols.join(", "),
        lits.join(", ")
    );
    let mut client = arc.lock().await;
    let res = client
        .execute(sql, &[])
        .await
        .map_err(|e| err(format!("삽입 실패: {e}")))?;
    if res.total() == 0 {
        return Err(err("삽입되지 않았습니다"));
    }
    Ok(())
}

async fn mssql_procedures(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
) -> Result<Vec<String>, IpcError> {
    let mut client = arc.lock().await;
    client
        .simple_query(format!("USE [{}]", database.replace(']', "]]")))
        .await
        .map_err(|e| err(format!("DB 전환 실패: {e}")))?
        .into_results()
        .await
        .ok();
    let rows = run_rows(
        &mut client,
        "SELECT SCHEMA_NAME(schema_id) + '.' + name FROM sys.procedures \
         WHERE is_ms_shipped = 0 ORDER BY SCHEMA_NAME(schema_id), name",
    )
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let s = gstr(r, 0);
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .collect())
}

async fn mssql_proc_params(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    proc: &str,
) -> Result<Vec<ProcParam>, IpcError> {
    let (schema, name) = proc.split_once('.').unwrap_or(("dbo", proc));
    let obj = format!(
        "[{}].[{}]",
        schema.replace(']', "]]").replace('\'', "''"),
        name.replace(']', "]]").replace('\'', "''")
    );
    let mut client = arc.lock().await;
    client
        .simple_query(format!("USE [{}]", database.replace(']', "]]")))
        .await
        .map_err(|e| err(format!("DB 전환 실패: {e}")))?
        .into_results()
        .await
        .ok();
    let q = format!(
        "SELECT pa.name, TYPE_NAME(pa.user_type_id), pa.is_output, pa.has_default_value \
         FROM sys.parameters pa WHERE pa.object_id = OBJECT_ID(N'{obj}') ORDER BY pa.parameter_id"
    );
    let rows = run_rows(&mut client, &q).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let n = gstr(r, 0);
            if n.is_empty() {
                return None;
            }
            Some(ProcParam {
                name: n,
                type_name: gstr(r, 1),
                output: r.try_get::<bool, _>(2).ok().flatten().unwrap_or(false),
                has_default: r.try_get::<bool, _>(3).ok().flatten().unwrap_or(false),
            })
        })
        .collect())
}

/// SET SHOWPLAN_XML ON으로 예상 계획 XML을 받고, 항상 OFF로 복구한다(연결 상태 유지).
async fn mssql_explain(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    query: &str,
) -> Result<String, IpcError> {
    let mut client = arc.lock().await;
    if !database.trim().is_empty() {
        client
            .simple_query(format!("USE [{}]", database.replace(']', "]]")))
            .await
            .map_err(|e| err(format!("DB 전환 실패: {e}")))?
            .into_results()
            .await
            .ok();
    }
    client
        .simple_query("SET SHOWPLAN_XML ON")
        .await
        .map_err(|e| err(format!("SHOWPLAN 설정 실패: {e}")))?
        .into_results()
        .await
        .ok();
    let result = run_explain_inner(&mut client, query).await;
    // 어떤 경우든 OFF로 복구 — 안 그러면 다음 쿼리들이 실행 대신 계획만 반환한다
    if let Ok(s) = client.simple_query("SET SHOWPLAN_XML OFF").await {
        s.into_results().await.ok();
    }
    result
}

/// 행에서 i번째 컬럼을 문자열로 (NULL/오류 → 빈 문자열).
fn gstr(r: &tiberius::Row, i: usize) -> String {
    r.try_get::<&str, _>(i)
        .ok()
        .flatten()
        .unwrap_or("")
        .to_string()
}

async fn run_rows(client: &mut MssqlClient, sql: &str) -> Result<Vec<tiberius::Row>, IpcError> {
    client
        .simple_query(sql)
        .await
        .map_err(|e| err(format!("메타 조회 실패: {e}")))?
        .into_first_result()
        .await
        .map_err(|e| err(format!("메타 수집 실패: {e}")))
}

/// SQL Server 컬럼 타입 표기 (varchar(50)·nvarchar(MAX)·decimal(18,2) 등).
fn format_sql_type(dt: &str, clen: Option<i32>, prec: Option<i32>, scale: Option<i32>) -> String {
    match dt.to_ascii_lowercase().as_str() {
        "varchar" | "char" | "varbinary" | "binary" | "nvarchar" | "nchar" => match clen {
            Some(-1) => format!("{dt}(MAX)"),
            Some(n) => format!("{dt}({n})"),
            None => dt.to_string(),
        },
        "decimal" | "numeric" => match (prec, scale) {
            (Some(p), Some(s)) => format!("{dt}({p},{s})"),
            (Some(p), None) => format!("{dt}({p})"),
            _ => dt.to_string(),
        },
        _ => dt.to_string(),
    }
}

async fn mssql_table_meta(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    table: &str,
) -> Result<TableMeta, IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    // 문자열 리터럴 이스케이프('→'') / 식별자 대괄호 이스케이프(]→]])
    let lit = |s: &str| s.replace('\'', "''");
    let (sch_l, tab_l) = (lit(schema), lit(name));
    let obj = format!(
        "[{}].[{}]",
        schema.replace(']', "]]").replace('\'', "''"),
        name.replace(']', "]]").replace('\'', "''")
    );
    let db_br = database.replace(']', "]]");

    let columns_sql = format!(
        "SELECT COLUMN_NAME, DATA_TYPE, CAST(CHARACTER_MAXIMUM_LENGTH AS int), \
         CAST(NUMERIC_PRECISION AS int), CAST(NUMERIC_SCALE AS int), IS_NULLABLE, \
         COLUMNPROPERTY(OBJECT_ID(N'{obj}'), COLUMN_NAME, 'IsIdentity'), \
         CASE WHEN COLUMN_DEFAULT IS NULL THEN 0 ELSE 1 END \
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=N'{sch_l}' AND TABLE_NAME=N'{tab_l}' \
         ORDER BY ORDINAL_POSITION"
    );
    let keys_sql = format!(
        "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, ku.COLUMN_NAME \
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
           ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=ku.TABLE_SCHEMA AND tc.TABLE_NAME=ku.TABLE_NAME \
         WHERE tc.TABLE_SCHEMA=N'{sch_l}' AND tc.TABLE_NAME=N'{tab_l}' \
           AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE') \
         ORDER BY tc.CONSTRAINT_NAME, ku.ORDINAL_POSITION"
    );
    let fk_sql = format!(
        "SELECT fk.name, cpar.name, \
           OBJECT_SCHEMA_NAME(fkc.referenced_object_id)+'.'+OBJECT_NAME(fkc.referenced_object_id), cref.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id \
         JOIN sys.columns cpar ON cpar.object_id=fkc.parent_object_id AND cpar.column_id=fkc.parent_column_id \
         JOIN sys.columns cref ON cref.object_id=fkc.referenced_object_id AND cref.column_id=fkc.referenced_column_id \
         WHERE fk.parent_object_id=OBJECT_ID(N'{obj}') ORDER BY fk.name, fkc.constraint_column_id"
    );
    let idx_sql = format!(
        "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id \
         JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id \
         WHERE i.object_id=OBJECT_ID(N'{obj}') AND i.type>0 AND i.is_hypothetical=0 AND ic.is_included_column=0 \
         ORDER BY i.name, ic.key_ordinal"
    );
    let chk_sql = format!(
        "SELECT name, definition FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'{obj}') ORDER BY name"
    );
    let def_sql = format!(
        "SELECT dc.name, c.name, dc.definition FROM sys.default_constraints dc \
         JOIN sys.columns c ON c.object_id=dc.parent_object_id AND c.column_id=dc.parent_column_id \
         WHERE dc.parent_object_id=OBJECT_ID(N'{obj}') ORDER BY dc.name"
    );
    let trg_sql = format!(
        "SELECT t.name, t.is_disabled, te.type_desc FROM sys.triggers t \
         LEFT JOIN sys.trigger_events te ON te.object_id=t.object_id \
         WHERE t.parent_id=OBJECT_ID(N'{obj}') ORDER BY t.name, te.type"
    );

    let mut client = arc.lock().await;
    // 대상 DB 컨텍스트로 전환(2부 이름·OBJECT_ID가 올바른 DB에서 해석되도록)
    client
        .simple_query(format!("USE [{db_br}]"))
        .await
        .map_err(|e| err(format!("DB 전환 실패: {e}")))?
        .into_results()
        .await
        .ok();
    let col_rows = run_rows(&mut client, &columns_sql).await?;
    let key_rows = run_rows(&mut client, &keys_sql).await?;
    let fk_rows = run_rows(&mut client, &fk_sql).await?;
    let idx_rows = run_rows(&mut client, &idx_sql).await?;
    let chk_rows = run_rows(&mut client, &chk_sql).await?;
    let def_rows = run_rows(&mut client, &def_sql).await?;
    let trg_rows = run_rows(&mut client, &trg_sql).await?;
    drop(client);

    // 키(PK/UNIQUE) + PK 컬럼 집합
    let mut keys: Vec<KeyInfo> = Vec::new();
    let mut pk_cols: HashSet<String> = HashSet::new();
    for r in &key_rows {
        let (cname, ctype, col) = (gstr(r, 0), gstr(r, 1), gstr(r, 2));
        if ctype == "PRIMARY KEY" {
            pk_cols.insert(col.clone());
        }
        match keys.iter_mut().find(|k| k.name == cname) {
            Some(k) => k.columns.push(col),
            None => keys.push(KeyInfo {
                name: cname,
                kind: ctype,
                columns: vec![col],
                references: None,
            }),
        }
    }
    // FK
    for r in &fk_rows {
        let (fkname, col, reftbl, refcol) = (gstr(r, 0), gstr(r, 1), gstr(r, 2), gstr(r, 3));
        match keys.iter_mut().find(|k| k.name == fkname) {
            Some(k) => k.columns.push(col),
            None => keys.push(KeyInfo {
                name: fkname,
                kind: "FOREIGN KEY".to_string(),
                columns: vec![col],
                references: Some(format!("{reftbl}({refcol})")),
            }),
        }
    }
    // 컬럼
    let columns = col_rows
        .iter()
        .map(|r| {
            let name = gstr(r, 0);
            let type_name = format_sql_type(
                &gstr(r, 1),
                r.try_get::<i32, _>(2).ok().flatten(),
                r.try_get::<i32, _>(3).ok().flatten(),
                r.try_get::<i32, _>(4).ok().flatten(),
            );
            ColumnInfo {
                pk: pk_cols.contains(&name),
                nullable: gstr(r, 5) == "YES",
                identity: r.try_get::<i32, _>(6).ok().flatten().unwrap_or(0) == 1,
                has_default: r.try_get::<i32, _>(7).ok().flatten().unwrap_or(0) == 1,
                name,
                type_name,
            }
        })
        .collect();
    // 인덱스
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &idx_rows {
        let iname = gstr(r, 0);
        if iname.is_empty() {
            continue;
        }
        let unique = r.try_get::<bool, _>(1).ok().flatten().unwrap_or(false);
        let kind = gstr(r, 3);
        let col = gstr(r, 4);
        match indexes.iter_mut().find(|x| x.name == iname) {
            Some(x) => x.columns.push(col),
            None => indexes.push(IndexInfo {
                name: iname,
                kind,
                unique,
                columns: vec![col],
            }),
        }
    }
    // 제약(CHECK/DEFAULT)
    let mut constraints: Vec<ConstraintInfo> = Vec::new();
    for r in &chk_rows {
        constraints.push(ConstraintInfo {
            name: gstr(r, 0),
            kind: "CHECK".to_string(),
            column: None,
            definition: gstr(r, 1),
        });
    }
    for r in &def_rows {
        let col = gstr(r, 1);
        constraints.push(ConstraintInfo {
            name: gstr(r, 0),
            kind: "DEFAULT".to_string(),
            column: if col.is_empty() { None } else { Some(col) },
            definition: gstr(r, 2),
        });
    }
    // 트리거(이벤트 묶음)
    let mut triggers: Vec<TriggerInfo> = Vec::new();
    for r in &trg_rows {
        let name = gstr(r, 0);
        if name.is_empty() {
            continue;
        }
        let disabled = r.try_get::<bool, _>(1).ok().flatten().unwrap_or(false);
        let ev = gstr(r, 2);
        match triggers.iter_mut().find(|t| t.name == name) {
            Some(t) => {
                if !ev.is_empty() && !t.events.split(", ").any(|e| e == ev) {
                    if t.events.is_empty() {
                        t.events = ev;
                    } else {
                        t.events.push_str(", ");
                        t.events.push_str(&ev);
                    }
                }
            }
            None => triggers.push(TriggerInfo {
                name,
                events: ev,
                disabled,
            }),
        }
    }

    Ok(TableMeta {
        columns,
        keys,
        indexes,
        constraints,
        triggers,
    })
}

// ============================================================================
// PostgreSQL / MySQL / SQLite — sqlx Any 드라이버 (단일 코드경로)
//
// Any가 URL 스킴(postgres://·mysql://·sqlite:)으로 드라이버를 고른다. 플레이스홀더는 백엔드
// 네이티브 그대로 통과하므로(PG=$1, MySQL/SQLite=?) 엔진별로 맞춰 만든다.
// 타입 충실도 주의: Any는 기본형(정수/실수/불리언/문자열/blob)만 디코드한다. PG/MySQL의
// 날짜·decimal·uuid 등은 NULL로 떨어질 수 있다(SQLite는 동적 타이핑이라 충실). 탐색 용도엔 충분.
// ============================================================================

/// Any 드라이버 등록은 프로세스당 1회.
fn ensure_sql_drivers() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(sqlx::any::install_default_drivers);
}

async fn build_sql_client(
    conn: &DbConnection,
    password: Option<String>,
    engine: DbEngine,
) -> Result<sqlx::AnyPool, IpcError> {
    ensure_sql_drivers();
    let url = match engine {
        DbEngine::Sqlite => {
            let path = conn
                .database
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| err("SQLite는 데이터베이스 파일 경로가 필요합니다"))?;
            let mode = if conn.read_only { "ro" } else { "rwc" };
            // 역슬래시→슬래시(SQLite 수용). scheme은 `sqlite:`(단일) — `//`는 authority라 `C:`가
            // 호스트로 잘못 잡힌다.
            format!("sqlite:{}?mode={}", path.replace('\\', "/"), mode)
        }
        DbEngine::Postgres | DbEngine::Mysql => {
            let scheme = if engine == DbEngine::Postgres {
                "postgres"
            } else {
                "mysql"
            };
            let mut url = format!("{scheme}://");
            if !conn.username.is_empty() {
                url.push_str(&pct(&conn.username));
                if let Some(pw) = &password {
                    url.push(':');
                    url.push_str(&pct(pw));
                }
                url.push('@');
            }
            url.push_str(&conn.host);
            url.push(':');
            url.push_str(&conn.port.to_string());
            url.push('/');
            if let Some(db) = conn
                .database
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                url.push_str(db);
            }
            if let Some(opts) = conn
                .options
                .as_deref()
                .map(str::trim)
                .filter(|o| !o.is_empty())
            {
                url.push('?');
                url.push_str(opts);
            }
            url
        }
        _ => return Err(err("내부 오류: SQL 엔진이 아닙니다")),
    };
    sqlx::any::AnyPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect(&url)
        .await
        .map_err(|e| err(format!("연결 실패: {e}")))
}

/// AnyRow의 i번째 셀 → JSON. 기본형 우선(정수→실수→불리언→문자열→blob), 미지원은 NULL.
fn any_cell_to_json(row: &sqlx::any::AnyRow, i: usize) -> Json {
    use serde_json::json;
    if let Ok(v) = row.try_get_raw(i) {
        if v.is_null() {
            return Json::Null;
        }
    }
    macro_rules! attempt {
        ($t:ty => $f:expr) => {
            if let Ok(v) = row.try_get::<$t, _>(i) {
                return $f(v);
            }
        };
    }
    attempt!(i64 => |v: i64| json!(v));
    attempt!(f64 => |v: f64| json!(v));
    attempt!(bool => |v: bool| json!(v));
    attempt!(String => |v: String| json!(v));
    attempt!(Vec<u8> => |v: Vec<u8>| json!(format!(
        "0x{}",
        v.iter().map(|b| format!("{b:02X}")).collect::<String>()
    )));
    Json::Null
}

/// AnyRow 묶음 → DbResult(컬럼명/타입 + 셀).
fn sql_rows_to_result(rows: &[sqlx::any::AnyRow]) -> DbResult {
    let columns: Vec<Column> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| Column {
                    name: c.name().to_string(),
                    type_name: Some(c.type_info().name().to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    let ncols = columns.len();
    let out: Vec<Vec<Json>> = rows
        .iter()
        .map(|r| (0..ncols).map(|i| any_cell_to_json(r, i)).collect())
        .collect();
    let row_count = out.len();
    DbResult {
        columns,
        rows: out,
        row_count,
    }
}

async fn sql_databases(pool: &sqlx::AnyPool, engine: DbEngine) -> Result<Vec<String>, IpcError> {
    let sql = match engine {
        // datname은 pg `name`타입 → Any는 TEXT만 디코드하므로 ::text 캐스트.
        DbEngine::Postgres => {
            "SELECT datname::text FROM pg_database WHERE datistemplate = false ORDER BY datname"
        }
        DbEngine::Mysql => "SHOW DATABASES",
        DbEngine::Sqlite => return Ok(vec!["main".to_string()]),
        _ => return Err(err("내부 오류")),
    };
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| err(format!("DB 목록 조회 실패: {e}")))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect())
}

async fn sql_tables(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    database: &str,
) -> Result<Vec<String>, IpcError> {
    let rows = match engine {
        DbEngine::Postgres => sqlx::query(
            "SELECT (table_schema || '.' || table_name)::text FROM information_schema.tables \
             WHERE table_type IN ('BASE TABLE','VIEW') \
               AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
        )
        .fetch_all(pool)
        .await,
        DbEngine::Mysql => sqlx::query(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
        )
        .bind(database)
        .fetch_all(pool)
        .await,
        DbEngine::Sqlite => sqlx::query(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') \
             AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(pool)
        .await,
        _ => return Err(err("내부 오류")),
    }
    .map_err(|e| err(format!("테이블 목록 조회 실패: {e}")))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect())
}

async fn sql_query(
    pool: &sqlx::AnyPool,
    _engine: DbEngine,
    query: &str,
    limit: i64,
    read_only: bool,
) -> Result<DbResult, IpcError> {
    if read_only && is_write_sql(query) {
        return Err(err(
            "읽기 전용 연결입니다 — 쓰기/DDL 문은 차단됩니다 (연결 편집에서 해제 가능)",
        ));
    }
    // 스트림으로 limit행까지만 적재(거대 결과 메모리 폭발 방지). 조기 종료는 sqlx가 연결을 정리.
    let mut stream = sqlx::query(query).fetch(pool);
    let mut rows: Vec<sqlx::any::AnyRow> = Vec::new();
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|e| err(format!("쿼리 실패: {e}")))?
    {
        if (rows.len() as i64) < limit {
            rows.push(row);
        } else {
            break;
        }
    }
    Ok(sql_rows_to_result(&rows))
}

async fn sql_explain(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    query: &str,
) -> Result<String, IpcError> {
    let sql = match engine {
        DbEngine::Sqlite => format!("EXPLAIN QUERY PLAN {query}"),
        DbEngine::Postgres | DbEngine::Mysql => format!("EXPLAIN {query}"),
        _ => return Err(err("내부 오류")),
    };
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| err(format!("실행 계획 실패: {e}")))?;
    let mut out = String::new();
    for r in &rows {
        let parts: Vec<String> = (0..r.columns().len())
            .map(|i| match any_cell_to_json(r, i) {
                Json::String(s) => s,
                Json::Null => String::new(),
                v => v.to_string(),
            })
            .collect();
        out.push_str(&parts.join(" | "));
        out.push('\n');
    }
    Ok(out)
}

// ---- 식별자 인용 / placeholder (엔진별) ----
fn quote_ident(engine: DbEngine, ident: &str) -> String {
    match engine {
        DbEngine::Mysql => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")), // postgres / sqlite — 표준 더블쿼트
    }
}
fn placeholder(engine: DbEngine, n: usize) -> String {
    match engine {
        DbEngine::Postgres => format!("${n}"), // 1-based
        _ => "?".to_string(),                  // mysql / sqlite
    }
}
/// "schema.table" 또는 "table" → 인용된 정규화 식별자(엔진별).
fn quote_table(engine: DbEngine, table: &str) -> String {
    match table.split_once('.') {
        Some((s, n)) => format!("{}.{}", quote_ident(engine, s), quote_ident(engine, n)),
        None => quote_ident(engine, table),
    }
}

/// Json 값을 Any 쿼리에 바인딩(소유값 — 수명 단순화). NULL은 타입드 None.
fn bind_json<'q>(
    q: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>>,
    v: &Json,
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>> {
    match v {
        Json::Null => q.bind(None::<String>),
        Json::Bool(b) => q.bind(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else {
                q.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

async fn sql_update_cell(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    table: &str,
    pk: &[PkCell],
    set_col: &str,
    set_value: &Json,
) -> Result<(), IpcError> {
    let mut n = 0usize;
    let mut next = || {
        n += 1;
        placeholder(engine, n)
    };
    let set_ph = next();
    let mut wheres = Vec::new();
    for p in pk {
        if p.value.is_null() {
            wheres.push(format!("{} IS NULL", quote_ident(engine, &p.col)));
        } else {
            wheres.push(format!("{} = {}", quote_ident(engine, &p.col), next()));
        }
    }
    let sql = format!(
        "UPDATE {} SET {} = {} WHERE {}",
        quote_table(engine, table),
        quote_ident(engine, set_col),
        set_ph,
        wheres.join(" AND ")
    );
    let mut q = sqlx::query(&sql);
    q = bind_json(q, set_value);
    for p in pk {
        if !p.value.is_null() {
            q = bind_json(q, &p.value);
        }
    }
    let res = q
        .execute(pool)
        .await
        .map_err(|e| err(format!("업데이트 실패: {e}")))?;
    match res.rows_affected() {
        0 => Err(err("일치하는 행이 없습니다 (이미 변경됐거나 삭제됨)")),
        1 => Ok(()),
        m => Err(err(format!("{m}개 행이 영향받음 — PK가 유일하지 않습니다(취소)"))),
    }
}

async fn sql_delete_row(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    table: &str,
    pk: &[PkCell],
) -> Result<(), IpcError> {
    let mut n = 0usize;
    let mut wheres = Vec::new();
    for p in pk {
        if p.value.is_null() {
            wheres.push(format!("{} IS NULL", quote_ident(engine, &p.col)));
        } else {
            n += 1;
            wheres.push(format!(
                "{} = {}",
                quote_ident(engine, &p.col),
                placeholder(engine, n)
            ));
        }
    }
    let sql = format!(
        "DELETE FROM {} WHERE {}",
        quote_table(engine, table),
        wheres.join(" AND ")
    );
    let mut q = sqlx::query(&sql);
    for p in pk {
        if !p.value.is_null() {
            q = bind_json(q, &p.value);
        }
    }
    let res = q
        .execute(pool)
        .await
        .map_err(|e| err(format!("삭제 실패: {e}")))?;
    match res.rows_affected() {
        0 => Err(err("일치하는 행이 없습니다 (이미 삭제됨)")),
        1 => Ok(()),
        m => Err(err(format!("{m}개 행이 영향받음 — 취소"))),
    }
}

async fn sql_insert_row(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    table: &str,
    values: &[PkCell],
) -> Result<(), IpcError> {
    let cols: Vec<String> = values.iter().map(|v| quote_ident(engine, &v.col)).collect();
    let phs: Vec<String> = (1..=values.len()).map(|i| placeholder(engine, i)).collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_table(engine, table),
        cols.join(", "),
        phs.join(", ")
    );
    let mut q = sqlx::query(&sql);
    for v in values {
        q = bind_json(q, &v.value);
    }
    let res = q
        .execute(pool)
        .await
        .map_err(|e| err(format!("삽입 실패: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(err("삽입되지 않았습니다"));
    }
    Ok(())
}

// ---- 테이블 메타(컬럼/PK/인덱스/FK) — 엔진별. 제약/트리거 상세는 MSSQL 한정(여기선 빈 목록) ----
async fn sql_table_meta(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    table: &str,
) -> Result<TableMeta, IpcError> {
    match engine {
        DbEngine::Sqlite => sqlite_table_meta(pool, table).await,
        DbEngine::Postgres => pg_table_meta(pool, table).await,
        DbEngine::Mysql => mysql_table_meta(pool, table).await,
        _ => Err(err("내부 오류")),
    }
}

async fn sqlite_table_meta(pool: &sqlx::AnyPool, table: &str) -> Result<TableMeta, IpcError> {
    let name = table.rsplit('.').next().unwrap_or(table);
    let qname = format!("\"{}\"", name.replace('"', "\"\""));

    let col_rows = sqlx::query(&format!("PRAGMA table_info({qname})"))
        .fetch_all(pool)
        .await
        .map_err(|e| err(format!("컬럼 조회 실패: {e}")))?;
    let mut columns = Vec::new();
    let mut pk_cols: Vec<(i64, String)> = Vec::new();
    for r in &col_rows {
        let cname = r.try_get::<String, _>("name").unwrap_or_default();
        if cname.is_empty() {
            continue;
        }
        let ctype = r.try_get::<String, _>("type").unwrap_or_default();
        let notnull = r.try_get::<i64, _>("notnull").unwrap_or(0) != 0;
        let pkpos = r.try_get::<i64, _>("pk").unwrap_or(0);
        let has_default = r
            .try_get::<Option<String>, _>("dflt_value")
            .ok()
            .flatten()
            .is_some();
        if pkpos > 0 {
            pk_cols.push((pkpos, cname.clone()));
        }
        columns.push(ColumnInfo {
            pk: pkpos > 0,
            nullable: !notnull,
            // INTEGER PRIMARY KEY는 rowid 별칭(자동 증가) → INSERT에서 생략 가능하게 identity 처리.
            identity: pkpos > 0 && ctype.to_ascii_uppercase().contains("INT"),
            has_default,
            name: cname,
            type_name: ctype,
        });
    }
    pk_cols.sort_by_key(|(pos, _)| *pos);
    let mut keys: Vec<KeyInfo> = Vec::new();
    if !pk_cols.is_empty() {
        keys.push(KeyInfo {
            name: "PRIMARY".to_string(),
            kind: "PRIMARY KEY".to_string(),
            columns: pk_cols.into_iter().map(|(_, c)| c).collect(),
            references: None,
        });
    }

    // FK
    let fk_rows = sqlx::query(&format!("PRAGMA foreign_key_list({qname})"))
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    for r in &fk_rows {
        let id = r.try_get::<i64, _>("id").unwrap_or(0);
        let reftbl = r.try_get::<String, _>("table").unwrap_or_default();
        let from = r.try_get::<String, _>("from").unwrap_or_default();
        let to = r.try_get::<String, _>("to").unwrap_or_default();
        let kname = format!("fk_{id}");
        match keys.iter_mut().find(|k| k.name == kname) {
            Some(k) => k.columns.push(from),
            None => keys.push(KeyInfo {
                name: kname,
                kind: "FOREIGN KEY".to_string(),
                columns: vec![from],
                references: Some(format!("{reftbl}({to})")),
            }),
        }
    }

    // 인덱스
    let mut indexes: Vec<IndexInfo> = Vec::new();
    let idx_list = sqlx::query(&format!("PRAGMA index_list({qname})"))
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    for r in &idx_list {
        let iname = r.try_get::<String, _>("name").unwrap_or_default();
        if iname.is_empty() {
            continue;
        }
        let unique = r.try_get::<i64, _>("unique").unwrap_or(0) != 0;
        let qi = format!("\"{}\"", iname.replace('"', "\"\""));
        let info = sqlx::query(&format!("PRAGMA index_info({qi})"))
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        let cols = info
            .iter()
            .filter_map(|r| r.try_get::<Option<String>, _>("name").ok().flatten())
            .collect();
        indexes.push(IndexInfo {
            name: iname,
            kind: if unique { "UNIQUE" } else { "INDEX" }.to_string(),
            unique,
            columns: cols,
        });
    }

    Ok(TableMeta {
        columns,
        keys,
        indexes,
        constraints: Vec::new(),
        triggers: Vec::new(),
    })
}

async fn pg_table_meta(pool: &sqlx::AnyPool, table: &str) -> Result<TableMeta, IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("public", table));

    // 컬럼 — information_schema 도메인 타입(sql_identifier/character_data/yes_or_no)은 ::text 캐스트.
    let col_rows = sqlx::query(
        "SELECT column_name::text, data_type::text, is_nullable::text, \
                (column_default IS NOT NULL) AS has_default, is_identity::text, \
                COALESCE(column_default,'')::text AS dflt \
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await
    .map_err(|e| err(format!("컬럼 조회 실패: {e}")))?;

    let pk_rows = sqlx::query(
        "SELECT kcu.column_name::text FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema \
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY' \
         ORDER BY kcu.ordinal_position",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let pk_set: HashSet<String> = pk_rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect();

    let columns = col_rows
        .iter()
        .map(|r| {
            let cn = r.try_get::<String, _>(0).unwrap_or_default();
            let dflt = r.try_get::<String, _>("dflt").unwrap_or_default();
            let is_identity = r.try_get::<String, _>(4).unwrap_or_default() == "YES"
                || dflt.starts_with("nextval(");
            ColumnInfo {
                pk: pk_set.contains(&cn),
                nullable: r.try_get::<String, _>(2).unwrap_or_default() == "YES",
                identity: is_identity,
                has_default: r.try_get::<bool, _>("has_default").unwrap_or(false),
                type_name: r.try_get::<String, _>(1).unwrap_or_default(),
                name: cn,
            }
        })
        .collect();

    let mut keys: Vec<KeyInfo> = Vec::new();
    if !pk_set.is_empty() {
        keys.push(KeyInfo {
            name: "PRIMARY KEY".to_string(),
            kind: "PRIMARY KEY".to_string(),
            columns: pk_rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>(0).ok())
                .collect(),
            references: None,
        });
    }
    // FK
    let fk_rows = sqlx::query(
        "SELECT tc.constraint_name::text, kcu.column_name::text, \
                (ccu.table_schema || '.' || ccu.table_name)::text, ccu.column_name::text \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name \
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name \
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for r in &fk_rows {
        let fkname = r.try_get::<String, _>(0).unwrap_or_default();
        let col = r.try_get::<String, _>(1).unwrap_or_default();
        let reftbl = r.try_get::<String, _>(2).unwrap_or_default();
        let refcol = r.try_get::<String, _>(3).unwrap_or_default();
        match keys.iter_mut().find(|k| k.name == fkname) {
            Some(k) => k.columns.push(col),
            None => keys.push(KeyInfo {
                name: fkname,
                kind: "FOREIGN KEY".to_string(),
                columns: vec![col],
                references: Some(format!("{reftbl}({refcol})")),
            }),
        }
    }
    // 인덱스 (pg_catalog)
    let idx_rows = sqlx::query(
        "SELECT i.relname::text, ix.indisunique, a.attname::text \
         FROM pg_class t JOIN pg_index ix ON ix.indrelid = t.oid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey::int2[]) \
         WHERE t.relname = $2 AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) \
         ORDER BY i.relname, array_position(ix.indkey::int2[], a.attnum)",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &idx_rows {
        let iname = r.try_get::<String, _>(0).unwrap_or_default();
        if iname.is_empty() {
            continue;
        }
        let unique = r.try_get::<bool, _>(1).unwrap_or(false);
        let col = r.try_get::<String, _>(2).unwrap_or_default();
        match indexes.iter_mut().find(|x| x.name == iname) {
            Some(x) => x.columns.push(col),
            None => indexes.push(IndexInfo {
                name: iname,
                kind: if unique { "UNIQUE" } else { "INDEX" }.to_string(),
                unique,
                columns: vec![col],
            }),
        }
    }

    Ok(TableMeta {
        columns,
        keys,
        indexes,
        constraints: Vec::new(),
        triggers: Vec::new(),
    })
}

async fn mysql_table_meta(pool: &sqlx::AnyPool, table: &str) -> Result<TableMeta, IpcError> {
    let name = table.rsplit('.').next().unwrap_or(table);

    let col_rows = sqlx::query(
        "SELECT column_name, column_type, is_nullable, column_default, extra, column_key \
         FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(name)
    .fetch_all(pool)
    .await
    .map_err(|e| err(format!("컬럼 조회 실패: {e}")))?;

    let mut columns = Vec::new();
    let mut pk_cols: Vec<String> = Vec::new();
    for r in &col_rows {
        let cn = r.try_get::<String, _>(0).unwrap_or_default();
        if cn.is_empty() {
            continue;
        }
        let key = r.try_get::<String, _>("column_key").unwrap_or_default();
        let extra = r.try_get::<String, _>("extra").unwrap_or_default();
        let is_pk = key == "PRI";
        if is_pk {
            pk_cols.push(cn.clone());
        }
        columns.push(ColumnInfo {
            pk: is_pk,
            nullable: r.try_get::<String, _>(2).unwrap_or_default() == "YES",
            identity: extra.contains("auto_increment"),
            has_default: r
                .try_get::<Option<String>, _>("column_default")
                .ok()
                .flatten()
                .is_some(),
            type_name: r.try_get::<String, _>(1).unwrap_or_default(),
            name: cn,
        });
    }
    let mut keys: Vec<KeyInfo> = Vec::new();
    if !pk_cols.is_empty() {
        keys.push(KeyInfo {
            name: "PRIMARY".to_string(),
            kind: "PRIMARY KEY".to_string(),
            columns: pk_cols,
            references: None,
        });
    }
    // FK
    let fk_rows = sqlx::query(
        "SELECT constraint_name, column_name, referenced_table_name, referenced_column_name \
         FROM information_schema.key_column_usage \
         WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL \
         ORDER BY constraint_name, ordinal_position",
    )
    .bind(name)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for r in &fk_rows {
        let fkname = r.try_get::<String, _>(0).unwrap_or_default();
        let col = r.try_get::<String, _>(1).unwrap_or_default();
        let reftbl = r.try_get::<String, _>(2).unwrap_or_default();
        let refcol = r.try_get::<String, _>(3).unwrap_or_default();
        match keys.iter_mut().find(|k| k.name == fkname) {
            Some(k) => k.columns.push(col),
            None => keys.push(KeyInfo {
                name: fkname,
                kind: "FOREIGN KEY".to_string(),
                columns: vec![col],
                references: Some(format!("{reftbl}({refcol})")),
            }),
        }
    }
    // 인덱스
    let idx_rows = sqlx::query(
        "SELECT index_name, non_unique, column_name FROM information_schema.statistics \
         WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index",
    )
    .bind(name)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &idx_rows {
        let iname = r.try_get::<String, _>(0).unwrap_or_default();
        if iname.is_empty() {
            continue;
        }
        let unique = r.try_get::<i64, _>(1).unwrap_or(1) == 0;
        let col = r.try_get::<String, _>(2).unwrap_or_default();
        match indexes.iter_mut().find(|x| x.name == iname) {
            Some(x) => x.columns.push(col),
            None => indexes.push(IndexInfo {
                name: iname,
                kind: if unique { "UNIQUE" } else { "INDEX" }.to_string(),
                unique,
                columns: vec![col],
            }),
        }
    }

    Ok(TableMeta {
        columns,
        keys,
        indexes,
        constraints: Vec::new(),
        triggers: Vec::new(),
    })
}

// ============================================================================
// Redis (키-값) — redis 크레이트 + ConnectionManager
//
// 관계형 모델이 아니므로: databases=0..N, tables=키 SCAN 샘플, query=쿼리 콘솔(원시 명령).
// 컬럼/키/인덱스·실행계획·그리드 편집은 없다(쿼리 콘솔의 명령으로 대체). db 전환은 각 op 앞에
// SELECT n(연결이 단일 멀티플렉스라 탐색기 순차 사용에선 안전).
// ============================================================================

async fn build_redis_client(
    conn: &DbConnection,
    password: Option<String>,
) -> Result<redis::aio::ConnectionManager, IpcError> {
    let pw = password.filter(|p| !p.is_empty());
    let opts = conn.options.as_deref().unwrap_or("").to_ascii_lowercase();
    let scheme = if opts.contains("tls=true") || opts.contains("ssl=true") {
        "rediss"
    } else {
        "redis"
    };
    let mut url = format!("{scheme}://");
    // Redis 6 ACL 사용자명(있으면) + 비번. 사용자명 없이 비번만이면 requirepass 형식(:pass@).
    if !conn.username.trim().is_empty() {
        url.push_str(&pct(conn.username.trim()));
        if let Some(p) = &pw {
            url.push(':');
            url.push_str(&pct(p));
        }
        url.push('@');
    } else if let Some(p) = &pw {
        url.push(':');
        url.push_str(&pct(p));
        url.push('@');
    }
    url.push_str(&conn.host);
    url.push(':');
    url.push_str(&conn.port.to_string());
    let dbnum: i64 = conn
        .database
        .as_deref()
        .map(str::trim)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    url.push('/');
    url.push_str(&dbnum.to_string());
    // 원시 드라이버 에러는 연결 URL(비밀번호 포함)을 에코할 수 있어 고정 문구로 대체(로그 유출 방지).
    let client =
        redis::Client::open(url).map_err(|_| err("연결 문자열이 올바르지 않습니다 (호스트·옵션 확인)".to_string()))?;
    redis::aio::ConnectionManager::new(client)
        .await
        .map_err(|e| err(format!("연결 실패: {e}")))
}

type Cm = redis::aio::ConnectionManager;

fn rcol(name: &str) -> Column {
    Column {
        name: name.to_string(),
        type_name: None,
    }
}
fn redis_one(name: &str, v: Json) -> DbResult {
    DbResult {
        columns: vec![rcol(name)],
        rows: vec![vec![v]],
        row_count: 1,
    }
}

async fn redis_databases(cm: &mut Cm) -> Result<Vec<String>, IpcError> {
    // CONFIG GET databases → 개수(기본 16). CONFIG 비활성 서버는 16으로 폴백.
    let n: i64 = match redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<(String, String)>(cm)
        .await
    {
        Ok((_, v)) => v.parse().unwrap_or(16),
        Err(_) => 16,
    };
    Ok((0..n.max(1)).map(|i| i.to_string()).collect())
}

async fn redis_select(cm: &mut Cm, database: &str) -> Result<(), IpcError> {
    let db: i64 = database.trim().parse().unwrap_or(0);
    redis::cmd("SELECT")
        .arg(db)
        .query_async::<()>(cm)
        .await
        .map_err(|e| err(format!("DB 선택 실패: {e}")))
}

async fn redis_tables(cm: &mut Cm, database: &str) -> Result<Vec<String>, IpcError> {
    redis_select(cm, database).await?;
    const CAP: usize = 1000;
    let mut keys: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(300)
            .query_async(cm)
            .await
            .map_err(|e| err(format!("키 조회 실패: {e}")))?;
        keys.extend(batch);
        cursor = next;
        if cursor == 0 || keys.len() >= CAP {
            break;
        }
    }
    keys.truncate(CAP);
    keys.sort();
    Ok(keys)
}

async fn redis_query(
    cm: &mut Cm,
    database: &str,
    query: &str,
    limit: i64,
    read_only: bool,
) -> Result<DbResult, IpcError> {
    redis_select(cm, database).await?;
    let tokens = tokenize_redis(query)?;
    if tokens.is_empty() {
        return Err(err("명령을 입력하세요 (예: GET key, HGETALL key)"));
    }
    // 단일 토큰이고 알려진 명령이 아니면 → 키 미리보기(타입 자동 감지).
    if tokens.len() == 1 && !is_known_redis_cmd(&tokens[0]) {
        return redis_key_preview(cm, &tokens[0], limit).await;
    }
    let upper = tokens[0].to_ascii_uppercase();
    if read_only && is_write_redis(&upper) {
        return Err(err(
            "읽기 전용 연결입니다 — 쓰기 명령은 차단됩니다 (연결 편집에서 해제 가능)",
        ));
    }
    // SELECT/SWAPDB 등 연결 상태를 바꾸는 명령은 탐색기 일관성을 위해 막는다(트리에서 DB 선택).
    if matches!(upper.as_str(), "SELECT" | "SWAPDB") {
        return Err(err("DB 전환은 왼쪽 트리에서 선택하세요"));
    }
    let mut cmd = redis::cmd(&tokens[0]);
    for a in &tokens[1..] {
        cmd.arg(a);
    }
    let v: redis::Value = cmd
        .query_async(cm)
        .await
        .map_err(|e| err(format!("명령 실패: {e}")))?;
    Ok(redis_value_to_result(v, limit))
}

/// 키 1개를 타입에 맞춰 읽어 그리드로 — string=value, hash=field/value, list/set=value, zset=member/score.
async fn redis_key_preview(cm: &mut Cm, key: &str, limit: i64) -> Result<DbResult, IpcError> {
    use serde_json::json;
    let lim = limit.max(1) as usize;
    let ty: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(cm)
        .await
        .map_err(|e| err(format!("TYPE 실패: {e}")))?;
    let e = |x: redis::RedisError| err(format!("읽기 실패: {x}"));
    match ty.as_str() {
        "string" => {
            let v: Option<String> = redis::cmd("GET").arg(key).query_async(cm).await.map_err(e)?;
            Ok(redis_one("value", v.map(Json::String).unwrap_or(Json::Null)))
        }
        "hash" => {
            let pairs: Vec<(String, String)> =
                redis::cmd("HGETALL").arg(key).query_async(cm).await.map_err(e)?;
            let rows = pairs
                .into_iter()
                .take(lim)
                .map(|(f, val)| vec![json!(f), json!(val)])
                .collect::<Vec<_>>();
            let row_count = rows.len();
            Ok(DbResult { columns: vec![rcol("field"), rcol("value")], rows, row_count })
        }
        "list" => {
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(lim as i64 - 1)
                .query_async(cm)
                .await
                .map_err(e)?;
            let rows = items.into_iter().map(|x| vec![json!(x)]).collect::<Vec<_>>();
            let row_count = rows.len();
            Ok(DbResult { columns: vec![rcol("value")], rows, row_count })
        }
        "set" => {
            let items: Vec<String> =
                redis::cmd("SMEMBERS").arg(key).query_async(cm).await.map_err(e)?;
            let rows = items.into_iter().take(lim).map(|x| vec![json!(x)]).collect::<Vec<_>>();
            let row_count = rows.len();
            Ok(DbResult { columns: vec![rcol("member")], rows, row_count })
        }
        "zset" => {
            let items: Vec<(String, f64)> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(lim as i64 - 1)
                .arg("WITHSCORES")
                .query_async(cm)
                .await
                .map_err(e)?;
            let rows = items
                .into_iter()
                .map(|(m, s)| vec![json!(m), json!(s)])
                .collect::<Vec<_>>();
            let row_count = rows.len();
            Ok(DbResult { columns: vec![rcol("member"), rcol("score")], rows, row_count })
        }
        "none" => Ok(redis_one("value", Json::Null)), // 키 없음
        other => Ok(redis_one(
            "info",
            json!(format!("({other}) 타입 미리보기 미지원 — 쿼리 콘솔에서 명령을 입력하세요")),
        )),
    }
}

/// Redis 명령 reply(Value) → DbResult. 배열/맵은 행으로 펼친다.
fn redis_value_to_result(v: redis::Value, limit: i64) -> DbResult {
    use redis::Value;
    use serde_json::json;
    let lim = limit.max(1) as usize;
    let rows: Vec<Vec<Json>> = match v {
        Value::Nil => vec![vec![Json::Null]],
        Value::Int(i) => vec![vec![json!(i)]],
        Value::SimpleString(s) => vec![vec![json!(s)]],
        Value::Okay => vec![vec![json!("OK")]],
        Value::BulkString(b) => vec![vec![json!(String::from_utf8_lossy(&b).into_owned())]],
        Value::Double(d) => vec![vec![json!(d)]],
        Value::Boolean(b) => vec![vec![json!(b)]],
        Value::Array(items) | Value::Set(items) => items
            .into_iter()
            .take(lim)
            .map(|it| vec![redis_scalar(it)])
            .collect(),
        Value::Map(pairs) => pairs
            .into_iter()
            .take(lim)
            .map(|(k, vv)| vec![redis_scalar(k), redis_scalar(vv)])
            .collect(),
        other => vec![vec![json!(format!("{other:?}"))]],
    };
    let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(1);
    let columns = if ncols >= 2 {
        vec![rcol("key"), rcol("value")]
    } else {
        vec![rcol("value")]
    };
    let row_count = rows.len();
    DbResult {
        columns,
        rows,
        row_count,
    }
}

fn redis_scalar(v: redis::Value) -> Json {
    use redis::Value;
    use serde_json::json;
    match v {
        Value::Nil => Json::Null,
        Value::Int(i) => json!(i),
        Value::SimpleString(s) => json!(s),
        Value::Okay => json!("OK"),
        Value::BulkString(b) => json!(String::from_utf8_lossy(&b).into_owned()),
        Value::Double(d) => json!(d),
        Value::Boolean(b) => json!(b),
        Value::Array(a) | Value::Set(a) => {
            json!(a.into_iter().map(redis_scalar).collect::<Vec<_>>())
        }
        other => json!(format!("{other:?}")),
    }
}

/// 쉘 유사 토크나이저 — 큰따옴표 그룹 + 백슬래시 이스케이프. 따옴표 미닫힘은 오류.
fn tokenize_redis(s: &str) -> Result<Vec<String>, IpcError> {
    let mut toks = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut started = false;
    let mut it = s.trim().chars().peekable();
    while let Some(c) = it.next() {
        if in_q {
            match c {
                '"' => in_q = false,
                '\\' => {
                    if let Some(n) = it.next() {
                        cur.push(n);
                    }
                }
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_q = true;
            started = true;
        } else if c.is_whitespace() {
            if started {
                toks.push(std::mem::take(&mut cur));
                started = false;
            }
        } else {
            cur.push(c);
            started = true;
        }
    }
    if in_q {
        return Err(err("따옴표가 닫히지 않았습니다"));
    }
    if started {
        toks.push(cur);
    }
    Ok(toks)
}

/// 단일 토큰을 "키"가 아니라 "명령"으로 볼지 — 흔한 Redis 명령 집합(대소문자 무시).
fn is_known_redis_cmd(t: &str) -> bool {
    const CMDS: &[&str] = &[
        "GET", "SET", "SETEX", "SETNX", "GETSET", "GETDEL", "GETEX", "APPEND", "STRLEN", "INCR",
        "INCRBY", "INCRBYFLOAT", "DECR", "DECRBY", "MGET", "MSET", "MSETNX", "DEL", "UNLINK",
        "EXISTS", "EXPIRE", "PEXPIRE", "EXPIREAT", "TTL", "PTTL", "PERSIST", "TYPE", "KEYS", "SCAN",
        "RENAME", "RENAMENX", "RANDOMKEY", "DUMP", "RESTORE", "COPY", "MOVE", "OBJECT", "HGET",
        "HSET", "HSETNX", "HMSET", "HMGET", "HGETALL", "HDEL", "HKEYS", "HVALS", "HLEN", "HEXISTS",
        "HINCRBY", "HINCRBYFLOAT", "HSCAN", "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP",
        "LRANGE", "LLEN", "LINDEX", "LSET", "LREM", "LTRIM", "LINSERT", "SADD", "SREM", "SMEMBERS",
        "SCARD", "SISMEMBER", "SPOP", "SRANDMEMBER", "SMOVE", "SINTER", "SUNION", "SDIFF", "SSCAN",
        "ZADD", "ZREM", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZSCORE", "ZCARD", "ZRANK",
        "ZREVRANK", "ZINCRBY", "ZCOUNT", "ZSCAN", "PING", "ECHO", "DBSIZE", "INFO", "SELECT",
        "SWAPDB", "FLUSHDB", "FLUSHALL", "CONFIG", "COMMAND", "CLIENT", "MEMORY", "TIME",
        "LASTSAVE", "SETRANGE", "GETRANGE", "SETBIT", "GETBIT", "BITCOUNT", "SUBSTR", "XADD",
        "XRANGE", "XREVRANGE", "XLEN", "XINFO", "XREAD",
    ];
    let u = t.to_ascii_uppercase();
    CMDS.contains(&u.as_str())
}

/// 쓰기/파괴 명령(대문자) — read_only 연결에서 차단.
fn is_write_redis(cmd_upper: &str) -> bool {
    const W: &[&str] = &[
        "SET", "SETEX", "SETNX", "PSETEX", "GETSET", "GETDEL", "GETEX", "APPEND", "INCR", "INCRBY",
        "INCRBYFLOAT", "DECR", "DECRBY", "MSET", "MSETNX", "DEL", "UNLINK", "EXPIRE", "PEXPIRE",
        "EXPIREAT", "PEXPIREAT", "PERSIST", "RENAME", "RENAMENX", "RESTORE", "COPY", "MOVE",
        "HSET", "HSETNX", "HMSET", "HDEL", "HINCRBY", "HINCRBYFLOAT", "LPUSH", "RPUSH", "LPUSHX",
        "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "RPOPLPUSH", "LMOVE",
        "BLPOP", "BRPOP", "SADD", "SREM", "SPOP", "SMOVE", "SINTERSTORE", "SUNIONSTORE",
        "SDIFFSTORE", "ZADD", "ZREM", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "ZREMRANGEBYRANK",
        "ZREMRANGEBYSCORE", "SETRANGE", "SETBIT", "BITOP", "FLUSHDB", "FLUSHALL", "SWAPDB",
        "XADD", "XDEL", "XTRIM", "XSETID", "XGROUP",
    ];
    W.contains(&cmd_upper)
}

/// 쓰기/DDL 키워드 1개인지.
fn is_write_keyword(kw: &str) -> bool {
    matches!(
        kw,
        "INSERT"
            | "UPDATE"
            | "DELETE"
            | "MERGE"
            | "DROP"
            | "ALTER"
            | "CREATE"
            | "TRUNCATE"
            | "EXEC"
            | "EXECUTE"
            | "GRANT"
            | "REVOKE"
            | "DENY"
            | "BACKUP"
            | "RESTORE"
            | "BULK"
            | "INTO" // SELECT … INTO (MSSQL 테이블 생성)
    )
}

/// 문자열 리터럴('…', "…", `…`)·대괄호 식별자([…])·주석(--, /* */)을 공백으로 치환한다.
/// 리터럴/식별자 안의 키워드·세미콜론이 쓰기 판정을 오염시키지 않게 하는 전처리. UTF-8 안전(char 순회).
fn scrub_sql_literals(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    let mut chars = q.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // 라인 주석 -- … EOL
            '-' if chars.peek() == Some(&'-') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        break;
                    }
                }
            }
            // 블록 주석 /* … */
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            // 문자열/식별자 인용 — 닫힘까지 스킵('' 이스케이프 처리), 자리엔 공백.
            '\'' | '"' | '`' => {
                let quote = c;
                while let Some(n) = chars.next() {
                    if n == quote {
                        if chars.peek() == Some(&quote) {
                            chars.next(); // 이스케이프된 인용부호
                            continue;
                        }
                        break;
                    }
                }
                out.push(' ');
            }
            // 대괄호 식별자 [col] (MSSQL) — 안의 키워드가 오탐되지 않게 제거.
            '[' => {
                for n in chars.by_ref() {
                    if n == ']' {
                        break;
                    }
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

/// 쓰기/DDL 여부 — read_only 연결의 안전망. **첫 키워드만** 보던 기존 판정은
/// `SELECT 1; DELETE …`(스택드) 나 `WITH x AS (DELETE …) SELECT …`(CTE)로 우회됐다.
/// read_only 연결에서만 호출되므로 과차단은 안전(fail-closed): 리터럴·주석을 제거한 뒤
/// ①추가 문장(내부 세미콜론) ②아무 데나 등장하는 쓰기 키워드를 모두 쓰기로 본다.
fn is_write_sql(query: &str) -> bool {
    // 빠른 경로 — 첫 키워드가 쓰기/DDL.
    if is_write_keyword(&first_keyword(query)) {
        return true;
    }
    let scrubbed = scrub_sql_literals(query);
    // 스택드 문장 — 내부 세미콜론 뒤에 내용이 있으면 다중 문장(끝의 `;` 하나는 허용).
    if scrubbed.split(';').skip(1).any(|s| !s.trim().is_empty()) {
        return true;
    }
    // CTE 본문 등에 숨은 쓰기 키워드 — 단어 경계로 토큰화(밑줄 포함 식별자는 한 토큰).
    scrubbed
        .to_ascii_uppercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(is_write_keyword)
}

/// 선행 주석(-- , /* */)·공백을 건너뛴 첫 키워드(대문자).
fn first_keyword(query: &str) -> String {
    let mut s = query.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.find("*/").map(|i| &rest[i + 2..]).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    s.chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect::<String>()
        .to_ascii_uppercase()
}

enum MongoOp {
    Find(Document),
    Aggregate(Vec<Document>),
}
struct ParsedMongo {
    collection: String,
    op: MongoOp,
}

async fn mongo_query(
    client: &Client,
    database: &str,
    query: &str,
    limit: i64,
    read_only: bool,
) -> Result<DbResult, IpcError> {
    let parsed = parse_mongo(query)?;
    guard_ops(&parsed.op, read_only)?;
    let db = client.database(database);
    let coll = db.collection::<Document>(&parsed.collection);

    let docs: Vec<Document> = match parsed.op {
        MongoOp::Find(filter) => coll
            .find(filter)
            .limit(limit)
            .await
            .map_err(|e| err(format!("쿼리 실패: {e}")))?
            .try_collect()
            .await
            .map_err(|e| err(format!("결과 수집 실패: {e}")))?,
        MongoOp::Aggregate(mut pipeline) => {
            pipeline.push(doc! { "$limit": limit });
            coll.aggregate(pipeline)
                .await
                .map_err(|e| err(format!("쿼리 실패: {e}")))?
                .try_collect()
                .await
                .map_err(|e| err(format!("결과 수집 실패: {e}")))?
        }
    };
    Ok(docs_to_result(docs))
}

fn parse_mongo(query: &str) -> Result<ParsedMongo, IpcError> {
    let q = query.trim().trim_end_matches(';').trim();
    let collection = extract_get_collection(q)
        .or_else(|| extract_db_dot(q))
        .ok_or_else(|| {
            err("컬렉션을 찾지 못함 — 예: db.getCollection(\"이름\").find({})")
        })?;

    if let Some(arg) = extract_call(q, "aggregate") {
        let v: Json = if arg.trim().is_empty() {
            serde_json::json!([])
        } else {
            serde_json::from_str(&normalize_mongo(&arg))
                .map_err(|e| err(format!("aggregate 인자 JSON 오류: {e}")))?
        };
        let pipeline = v
            .as_array()
            .ok_or_else(|| err("aggregate 인자는 배열이어야 합니다"))?
            .iter()
            .map(json_to_doc)
            .collect();
        Ok(ParsedMongo {
            collection,
            op: MongoOp::Aggregate(pipeline),
        })
    } else if let Some(arg) = extract_call(q, "find") {
        let filter = if arg.trim().is_empty() {
            Document::new()
        } else {
            let v: Json = serde_json::from_str(&normalize_mongo(&arg))
                .map_err(|e| err(format!("find 필터 JSON 오류: {e}")))?;
            json_to_doc(&v)
        };
        Ok(ParsedMongo {
            collection,
            op: MongoOp::Find(filter),
        })
    } else {
        Err(err(
            "지원 형식: db.getCollection(\"이름\").find({...}) 또는 .aggregate([...])",
        ))
    }
}

fn extract_get_collection(q: &str) -> Option<String> {
    let i = q.find("getCollection(")? + "getCollection(".len();
    let rest = q[i..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let after = &rest[1..];
    let end = after.find(quote)?;
    Some(after[..end].to_string())
}

fn extract_db_dot(q: &str) -> Option<String> {
    let rest = q.strip_prefix("db.")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// `.method(` 뒤 균형 괄호 안의 인자 문자열 추출 (문자열 리터럴 내부의 괄호·이스케이프는 무시).
fn extract_call(q: &str, method: &str) -> Option<String> {
    let pat = format!(".{method}(");
    let pos = q.find(&pat)?;
    let open = pos + pat.len() - 1; // '(' 위치
    let close = scan_balanced(q.as_bytes(), open)?; // ')' 다음 인덱스
    Some(q[open + 1..close - 1].to_string())
}

/// `b[open]`가 '('일 때 짝이 맞는 ')' 다음 인덱스. 문자열 리터럴 내부 괄호는 센다(무시).
fn scan_balanced(b: &[u8], open: usize) -> Option<usize> {
    let n = b.len();
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str: Option<u8> = None;
    let mut esc = false;
    while i < n {
        let c = b[i];
        if let Some(quote) = in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == quote {
                in_str = None;
            }
        } else {
            match c {
                b'"' | b'\'' => in_str = Some(c),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// serde_json Value → BSON Document. 확장 JSON 래퍼($oid·$date·$numberLong 등)를 직접 해석해
/// 실제 BSON 타입으로 복원한다(이전의 to_bson은 {"$oid":..}를 하위 문서로 취급해 _id 조회 불가).
fn json_to_doc(v: &Json) -> Document {
    match json_value_to_bson(v) {
        Bson::Document(d) => d,
        _ => Document::new(),
    }
}

/// serde_json Value → Bson. 단일 키 확장 JSON 래퍼는 해당 BSON 타입으로 복원한다.
fn json_value_to_bson(v: &Json) -> Bson {
    match v {
        Json::Null => Bson::Null,
        Json::Bool(b) => Bson::Boolean(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Bson::Int64(i)
            } else if let Some(u) = n.as_u64() {
                Bson::Int64(u as i64)
            } else {
                Bson::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => Bson::String(s.clone()),
        Json::Array(a) => Bson::Array(a.iter().map(json_value_to_bson).collect()),
        Json::Object(o) => {
            if o.len() == 1 {
                if let Some(b) = try_extjson_wrapper(o) {
                    return b;
                }
            }
            let mut d = Document::new();
            for (k, val) in o {
                d.insert(k.clone(), json_value_to_bson(val));
            }
            Bson::Document(d)
        }
    }
}

/// 단일 키 확장 JSON 래퍼({"$oid":".."} 등)를 실제 BSON 타입으로. 인식 못하면 None.
fn try_extjson_wrapper(o: &serde_json::Map<String, Json>) -> Option<Bson> {
    let (k, v) = o.iter().next()?;
    match k.as_str() {
        "$oid" => v
            .as_str()
            .and_then(|s| ObjectId::parse_str(s).ok())
            .map(Bson::ObjectId),
        "$numberLong" => v.as_str().and_then(|s| s.parse().ok()).map(Bson::Int64),
        "$numberInt" => v.as_str().and_then(|s| s.parse().ok()).map(Bson::Int32),
        "$numberDouble" => v.as_str().and_then(|s| s.parse().ok()).map(Bson::Double),
        "$numberDecimal" => v
            .as_str()
            .and_then(|s| s.parse::<Decimal128>().ok())
            .map(Bson::Decimal128),
        "$date" => parse_extjson_date(v),
        _ => None,
    }
}

fn parse_extjson_date(v: &Json) -> Option<Bson> {
    if let Some(s) = v.as_str() {
        return DateTime::parse_rfc3339_str(s).ok().map(Bson::DateTime);
    }
    if let Some(ms) = v
        .as_object()
        .and_then(|o| o.get("$numberLong"))
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<i64>().ok())
    {
        return Some(Bson::DateTime(DateTime::from_millis(ms)));
    }
    None
}

fn docs_to_result(docs: Vec<Document>) -> DbResult {
    let mut json_docs: Vec<Json> = docs
        .into_iter()
        .map(|d| Bson::Document(d).into_relaxed_extjson())
        .collect();
    // 2^53 이상 정수(NumberLong 등)는 JS JSON.parse에서 반올림된다 — 문자열로 보존해 정확히 표시
    for jd in json_docs.iter_mut() {
        stringify_big_ints(jd);
    }

    let mut columns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for jd in &json_docs {
        if let Some(obj) = jd.as_object() {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    columns.push(k.clone());
                }
            }
        }
    }

    let rows: Vec<Vec<Json>> = json_docs
        .iter()
        .map(|jd| {
            columns
                .iter()
                .map(|c| jd.get(c).cloned().unwrap_or(Json::Null))
                .collect()
        })
        .collect();

    DbResult {
        row_count: rows.len(),
        columns: columns
            .into_iter()
            .map(|name| Column {
                name,
                type_name: None,
            })
            .collect(),
        rows,
    }
}

/// 2^53 이상 정수를 문자열로 바꿔 JS JSON.parse 반올림(정밀도 손실)을 막는다. 재귀.
fn stringify_big_ints(v: &mut Json) {
    const MAX_SAFE: i64 = 9_007_199_254_740_991; // 2^53 - 1
    match v {
        Json::Number(num) => {
            if let Some(i) = num.as_i64() {
                if i > MAX_SAFE || i < -MAX_SAFE {
                    *v = Json::String(i.to_string());
                }
            } else if let Some(u) = num.as_u64() {
                if u > MAX_SAFE as u64 {
                    *v = Json::String(u.to_string());
                }
            }
        }
        Json::Array(a) => a.iter_mut().for_each(stringify_big_ints),
        Json::Object(o) => o.values_mut().for_each(stringify_big_ints),
        _ => {}
    }
}

// ---- 쓰기/위험 연산자 차단 ----

/// $out·$merge는 뷰어에서 항상 차단(컬렉션 쓰기). read_only면 서버측 JS도 차단.
fn guard_ops(op: &MongoOp, read_only: bool) -> Result<(), IpcError> {
    const WRITE: &[&str] = &["$out", "$merge"];
    const JS: &[&str] = &["$where", "$function", "$accumulator"];
    let check = |d: &Document| -> Result<(), IpcError> {
        if let Some(found) = doc_find_op(d, WRITE) {
            return Err(err(format!(
                "쓰기 연산 '{found}'는 읽기 전용 뷰어에서 차단됩니다"
            )));
        }
        if read_only {
            if let Some(found) = doc_find_op(d, JS) {
                return Err(err(format!(
                    "서버측 JS '{found}'는 읽기 전용 연결에서 차단됩니다"
                )));
            }
        }
        Ok(())
    };
    match op {
        MongoOp::Find(filter) => check(filter)?,
        MongoOp::Aggregate(stages) => {
            for s in stages {
                check(s)?;
            }
        }
    }
    Ok(())
}

fn doc_find_op(doc: &Document, ops: &[&str]) -> Option<String> {
    for (k, v) in doc.iter() {
        if ops.contains(&k.as_str()) {
            return Some(k.clone());
        }
        if let Some(found) = bson_find_op(v, ops) {
            return Some(found);
        }
    }
    None
}

fn bson_find_op(b: &Bson, ops: &[&str]) -> Option<String> {
    match b {
        Bson::Document(d) => doc_find_op(d, ops),
        Bson::Array(a) => a.iter().find_map(|x| bson_find_op(x, ops)),
        _ => None,
    }
}

// ---- Mongo 셸 → strict JSON 정규화 ----

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}
fn is_ident_part(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}
fn is_json_literal(id: &[u8]) -> bool {
    id == b"true" || id == b"false" || id == b"null"
}
fn is_helper(id: &[u8]) -> bool {
    matches!(
        id,
        b"ObjectId" | b"ISODate" | b"Date" | b"NumberLong" | b"NumberInt" | b"NumberDecimal"
    )
}
fn peek_non_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}
/// `b[start]`가 따옴표일 때 닫는 따옴표 다음 인덱스(미종료면 끝).
fn string_end(b: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    let mut esc = false;
    while i < b.len() {
        let c = b[i];
        if esc {
            esc = false;
        } else if c == b'\\' {
            esc = true;
        } else if c == quote {
            return i + 1;
        }
        i += 1;
    }
    b.len()
}
/// 임의 바이트열을 쌍따옴표 JSON 문자열로 방출(필요한 문자만 이스케이프).
fn push_json_string_raw(out: &mut Vec<u8>, s: &[u8]) {
    out.push(b'"');
    for &c in s {
        match c {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            _ => out.push(c),
        }
    }
    out.push(b'"');
}
/// 홑따옴표 문자열 내용 → 쌍따옴표 JSON 문자열(`\'`→`'`, `"`→`\"`).
fn push_single_as_json(out: &mut Vec<u8>, inner: &[u8]) {
    out.push(b'"');
    let mut i = 0;
    while i < inner.len() {
        let c = inner[i];
        if c == b'\\' && i + 1 < inner.len() {
            let nx = inner[i + 1];
            if nx == b'\'' {
                out.push(b'\'');
            } else {
                out.push(b'\\');
                out.push(nx);
            }
            i += 2;
            continue;
        }
        if c == b'"' {
            out.extend_from_slice(b"\\\"");
        } else {
            out.push(c);
        }
        i += 1;
    }
    out.push(b'"');
}
/// 셸 헬퍼(ObjectId 등) → 확장 JSON. 값은 항상 JSON 문자열로 감싼다.
fn push_helper_extjson(out: &mut Vec<u8>, ident: &[u8], inner: &[u8]) {
    let inner_s = String::from_utf8_lossy(inner);
    let normalized = normalize_mongo(&inner_s);
    let trimmed = normalized.trim();
    let val = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    let key: &[u8] = match ident {
        b"ObjectId" => b"$oid",
        b"ISODate" | b"Date" => b"$date",
        b"NumberLong" => b"$numberLong",
        b"NumberInt" => b"$numberInt",
        b"NumberDecimal" => b"$numberDecimal",
        _ => b"$unknown",
    };
    out.push(b'{');
    out.push(b'"');
    out.extend_from_slice(key);
    out.push(b'"');
    out.push(b':');
    push_json_string_raw(out, val.as_bytes());
    out.push(b'}');
}

/// Mongo 셸 표기를 strict JSON으로 정규화한다(find/aggregate 인자 전용).
/// 홑따옴표→쌍따옴표, 따옴표 없는 키→따옴표, 셸 헬퍼→확장 JSON, // 및 /* */ 주석 제거.
/// 문자열 리터럴 내부는 절대 건드리지 않는다(괄호·콜론·따옴표는 데이터).
fn normalize_mongo(input: &str) -> String {
    let b = input.as_bytes();
    let n = b.len();
    let mut out: Vec<u8> = Vec::with_capacity(n + 16);
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == b'/' && i + 1 < n && b[i + 1] == b'/' {
            i += 2;
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
        } else if c == b'"' {
            let end = string_end(b, i, b'"');
            out.extend_from_slice(&b[i..end]);
            i = end;
        } else if c == b'\'' {
            let end = string_end(b, i, b'\'');
            let close = end.saturating_sub(1).max(i + 1);
            push_single_as_json(&mut out, &b[i + 1..close]);
            i = end;
        } else if is_ident_start(c) {
            let mut j = i + 1;
            while j < n && is_ident_part(b[j]) {
                j += 1;
            }
            let ident = &b[i..j];
            let after = peek_non_space(b, j);
            if after < n && b[after] == b'(' && is_helper(ident) {
                if let Some(close) = scan_balanced(b, after) {
                    push_helper_extjson(&mut out, ident, &b[after + 1..close - 1]);
                    i = close;
                    continue;
                }
                out.extend_from_slice(ident);
                i = j;
            } else if after < n && b[after] == b':' && !is_json_literal(ident) {
                out.push(b'"');
                out.extend_from_slice(ident);
                out.push(b'"');
                i = j;
            } else {
                out.extend_from_slice(ident);
                i = j;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn normalize_objectid_helper() {
        assert_eq!(
            normalize_mongo(r#"{"_id": ObjectId("507f1f77bcf86cd799439011")}"#),
            r#"{"_id": {"$oid":"507f1f77bcf86cd799439011"}}"#
        );
    }

    #[test]
    fn normalize_unquoted_keys_and_single_quotes() {
        assert_eq!(normalize_mongo("{category:'illust'}"), r#"{"category":"illust"}"#);
    }

    #[test]
    fn normalize_numberlong_both_forms() {
        assert_eq!(
            normalize_mongo("{n: NumberLong(5)}"),
            r#"{"n": {"$numberLong":"5"}}"#
        );
        assert_eq!(
            normalize_mongo(r#"{n: NumberLong("5")}"#),
            r#"{"n": {"$numberLong":"5"}}"#
        );
    }

    #[test]
    fn extjson_oid_roundtrips_to_objectid() {
        let v: Json =
            serde_json::from_str(r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#).unwrap();
        let d = json_to_doc(&v);
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
    }

    #[test]
    fn extract_call_ignores_paren_in_string() {
        let q = r#"db.users.find({"name": "Smith) & Co"})"#;
        assert_eq!(
            extract_call(q, "find").as_deref(),
            Some(r#"{"name": "Smith) & Co"}"#)
        );
    }

    #[test]
    fn big_ints_become_strings() {
        let mut v: Json = serde_json::json!({"a": 1234567890123456789_i64, "b": 5});
        stringify_big_ints(&mut v);
        assert_eq!(v["a"], Json::String("1234567890123456789".into()));
        assert_eq!(v["b"], serde_json::json!(5));
    }

    #[test]
    fn guard_blocks_out_stage_always() {
        let stages = vec![doc! {"$match": {}}, doc! {"$out": "backup"}];
        assert!(guard_ops(&MongoOp::Aggregate(stages), false).is_err());
    }

    #[test]
    fn guard_allows_normal_aggregate() {
        let stages = vec![doc! {"$match": {"a": 1}}, doc! {"$group": {"_id": "$x"}}];
        assert!(guard_ops(&MongoOp::Aggregate(stages), true).is_ok());
    }

    #[test]
    fn guard_where_only_blocked_when_readonly() {
        let f = doc! {"$where": "true"};
        assert!(guard_ops(&MongoOp::Find(f.clone()), true).is_err());
        assert!(guard_ops(&MongoOp::Find(f), false).is_ok());
    }

    #[test]
    fn first_keyword_skips_comments() {
        assert_eq!(first_keyword("-- c\nSELECT 1"), "SELECT");
        assert_eq!(first_keyword("/* x */ delete from t"), "DELETE");
        assert_eq!(first_keyword("   select top 10 *"), "SELECT");
        assert_eq!(first_keyword(""), "");
    }

    #[test]
    fn write_sql_detection() {
        assert!(is_write_sql("DELETE FROM t"));
        assert!(is_write_sql("update t set a=1"));
        assert!(is_write_sql("-- note\nDROP TABLE t"));
        assert!(is_write_sql("TRUNCATE TABLE t"));
        assert!(!is_write_sql("SELECT * FROM t"));
        assert!(!is_write_sql("  select top 10 * from t"));
        assert!(!is_write_sql("WITH x AS (SELECT 1) SELECT * FROM x"));

        // 우회 차단(회귀 방지):
        // 스택드 문장 — 첫 키워드는 SELECT지만 뒤에 DELETE.
        assert!(is_write_sql("SELECT 1; DELETE FROM t"));
        // 데이터 변경 CTE — 첫 키워드 WITH.
        assert!(is_write_sql(
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"
        ));
        // SELECT … INTO (MSSQL 테이블 생성).
        assert!(is_write_sql("SELECT * INTO backup FROM t"));

        // 오탐 없음(리터럴·식별자 속 키워드는 무시, 끝 세미콜론 허용):
        assert!(!is_write_sql("SELECT * FROM t WHERE note = 'please delete row'"));
        assert!(!is_write_sql("SELECT deleted_at, updated_at FROM t"));
        assert!(!is_write_sql("SELECT [delete], [update] FROM t")); // 대괄호 식별자
        assert!(!is_write_sql("SELECT * FROM t;"));
    }
}
