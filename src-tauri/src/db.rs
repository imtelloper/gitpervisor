use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use futures::stream::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Decimal128, Document};
use mongodb::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use tiberius::{AuthMethod, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::error::{ErrorCode, IpcError};

/// SQL Server(TDS) 클라이언트 — 단일 연결이라 &mut가 필요해 tokio Mutex로 감싼다.
type MssqlClient = tiberius::Client<Compat<TcpStream>>;

/// 활성 연결 핸들. Mongo Client는 풀이라 clone 가능, MSSQL은 단일 연결이라 Arc<Mutex>.
#[derive(Clone)]
enum DbClient {
    Mongo(Client),
    Mssql(Arc<tokio::sync::Mutex<MssqlClient>>),
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
        _ => {
            return Err(err(
                "아직 MongoDB·SQL Server만 지원합니다 (PostgreSQL/MySQL/SQLite는 추후)",
            ))
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
    }
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
    Client::with_uri_str(&uri)
        .await
        .map_err(|e| err(format!("연결 문자열 오류: {e}")))
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
    config.authentication(AuthMethod::sql_server(
        &conn.username,
        password.as_deref().unwrap_or(""),
    ));
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

/// 첫 키워드가 쓰기/DDL인지 — read_only 연결의 안전망(완벽한 SQL 파서는 아님).
fn is_write_sql(query: &str) -> bool {
    matches!(
        first_keyword(query).as_str(),
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
    )
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
    }
}
