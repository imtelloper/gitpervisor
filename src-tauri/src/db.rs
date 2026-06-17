use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};

use futures::stream::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::error::{ErrorCode, IpcError};

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
    /// 활성 연결 (connId → Mongo 클라이언트). M6.1은 Mongo만.
    clients: Mutex<HashMap<String, Client>>,
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
fn store_password(conn_id: &str, password: &str) {
    if let Some(e) = keyring_entry(conn_id) {
        let _ = e.set_password(password);
    }
}
fn read_password(conn_id: &str) -> Option<String> {
    keyring_entry(conn_id).and_then(|e| e.get_password().ok())
}
fn delete_password(conn_id: &str) {
    if let Some(e) = keyring_entry(conn_id) {
        let _ = e.delete_credential();
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
        store_password(&conn.id, &pw);
    }
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

    if conn.engine != DbEngine::Mongodb {
        return Err(err("아직 MongoDB만 지원합니다 (다른 엔진은 M6.2)"));
    }

    let password = read_password(&conn.id);
    let client = build_mongo_client(&conn, password).await?;
    // 연결 확인 — DB 목록 조회로 핑
    client
        .list_database_names()
        .await
        .map_err(|e| err(format!("연결 실패: {e}")))?;

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
    let client = client_of(&state, &id)?;
    client
        .list_database_names()
        .await
        .map_err(|e| err(format!("DB 목록 조회 실패: {e}")))
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbState>,
    id: String,
    database: String,
) -> Result<Vec<String>, IpcError> {
    let client = client_of(&state, &id)?;
    client
        .database(&database)
        .list_collection_names()
        .await
        .map_err(|e| err(format!("컬렉션 목록 조회 실패: {e}")))
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    id: String,
    database: String,
    query: String,
    limit: Option<i64>,
) -> Result<DbResult, IpcError> {
    let client = client_of(&state, &id)?;
    let limit = limit.unwrap_or(ROW_LIMIT).clamp(1, ROW_LIMIT);
    mongo_query(&client, &database, &query, limit).await
}

fn client_of(state: &State<'_, DbState>, id: &str) -> Result<Client, IpcError> {
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
) -> Result<DbResult, IpcError> {
    let parsed = parse_mongo(query)?;
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
            serde_json::from_str(&arg).map_err(|e| err(format!("aggregate 인자 JSON 오류: {e}")))?
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
            let v: Json =
                serde_json::from_str(&arg).map_err(|e| err(format!("find 필터 JSON 오류: {e}")))?;
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

/// `.method(` 뒤 균형 괄호 안의 인자 문자열 추출
fn extract_call(q: &str, method: &str) -> Option<String> {
    let pat = format!(".{method}(");
    let start = q.find(&pat)? + pat.len();
    let bytes = q.as_bytes();
    let mut depth = 1usize;
    let mut j = start;
    while j < q.len() {
        match bytes[j] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(q[start..j].to_string());
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

fn json_to_doc(v: &Json) -> Document {
    match mongodb::bson::to_bson(v) {
        Ok(Bson::Document(d)) => d,
        _ => Document::new(),
    }
}

fn docs_to_result(docs: Vec<Document>) -> DbResult {
    let json_docs: Vec<Json> = docs
        .into_iter()
        .map(|d| Bson::Document(d).into_relaxed_extjson())
        .collect();

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
