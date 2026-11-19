//! 결과 그리드의 행 수정·삭제 — 결과가 어느 테이블의 어느 키로 행 하나를 겨냥하는지 판정하고, 그 한 행만 바꾼다.
//!
//! 판정은 보수적이다: 결과가 `SELECT * | 맨 컬럼 목록 FROM <테이블 하나>`에서 왔고 그 테이블의 기본 키(없으면 유일 키)
//! 컬럼이 결과에 다 있을 때만 키를 돌려준다. 확신할 수 없으면 거절 사유를 돌려주고 추측(전 컬럼 일치 등)하지 않는다.
//! 마지막 방어선은 실행 쪽이다 — 영향 행이 정확히 1이 아니면 되돌린다(sqlx: 트랜잭션, MSSQL: 같은 문장 안의 개수 조건).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value as Json;
use sqlx::Row as _;
use tauri::State;

use super::{
    bind_json, client_of, err, mssql_column_types, mssql_table_meta, mssql_tables, placeholder, quote_ident,
    quote_table, read_only_of, sql_literal, sql_table_meta, sql_tables, DbClient, DbEngine, DbState, MssqlClient,
    PkCell, TableMeta,
};
use crate::error::IpcError;
use crate::i18n::text_db;

/// `key`가 비어 있으면 편집 불가 — 이유는 `refusal`. `table`은 행 추가(키 불필요)에도 쓴다.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    pub table: Option<String>,
    pub key: Vec<String>,
    pub refusal: Option<String>,
}

#[tauri::command(async)]
pub async fn db_edit_target(
    state: State<'_, DbState>,
    id: String,
    database: String,
    query: String,
    columns: Vec<String>,
) -> Result<EditTarget, IpcError> {
    let refuse = |table: Option<String>, why: String| Ok(EditTarget { table, key: Vec::new(), refusal: Some(why) });
    if read_only_of(&state, &id) {
        return refuse(None, text_db::db_read_only_edit_blocked().into());
    }
    let client = client_of(&state, &id)?;
    let engine = match &client {
        DbClient::Mssql(_) => DbEngine::Mssql,
        DbClient::Sql(_, e) => *e,
        DbClient::Mongo(_) | DbClient::Redis(_) => return refuse(None, text_db::db_cell_edit_sql_only().into()),
    };
    let Some(parts) = select_source_table(engine, &query) else {
        return refuse(None, text_db::db_grid_edit_not_single_table().into());
    };
    let tables = match &client {
        DbClient::Mssql(c) => mssql_tables(c, &database).await?,
        DbClient::Sql(pool, _) => sql_tables(pool, engine, &database).await?,
        DbClient::Mongo(_) | DbClient::Redis(_) => return refuse(None, text_db::db_cell_edit_sql_only().into()),
    };
    let Some(table) = resolve_source_table(engine, &parts, &tables) else {
        let shown = parts.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>().join(".");
        return refuse(None, text_db::db_grid_edit_table_unresolved(&shown));
    };
    let meta = match &client {
        DbClient::Mssql(c) => mssql_table_meta(c, &database, &table).await?,
        DbClient::Sql(pool, _) => sql_table_meta(pool, engine, &table).await?,
        DbClient::Mongo(_) | DbClient::Redis(_) => return refuse(None, text_db::db_cell_edit_sql_only().into()),
    };
    Ok(match pick_row_key(&meta, &columns) {
        Ok(key) => EditTarget { table: Some(table), key, refusal: None },
        Err(why) => EditTarget { table: Some(table), key: Vec::new(), refusal: Some(why) },
    })
}

/// 키(`pk`)로 겨냥한 행 하나의 여러 컬럼을 UPDATE. 셀 하나 편집도 이것으로 한다(`values` 한 개).
#[tauri::command(async)]
pub async fn db_update_row(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
    pk: Vec<PkCell>,
    values: Vec<PkCell>,
) -> Result<(), IpcError> {
    if read_only_of(&state, &id) {
        return Err(err(text_db::db_read_only_edit_blocked()));
    }
    let change = RowChange::Update(&values);
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_row_change(&c, &database, &table, &pk, change).await,
        DbClient::Sql(pool, engine) => sql_row_change(&pool, engine, &table, &pk, change).await,
        DbClient::Mongo(_) => Err(err(text_db::db_cell_edit_sql_only())),
        DbClient::Redis(_) => Err(err(text_db::db_cell_edit_redis_unsupported())),
    }
}

/// 키(`pk`)로 겨냥한 행 하나를 DELETE. 확인 창은 프런트가 띄운다.
#[tauri::command(async)]
pub async fn db_delete_row(
    state: State<'_, DbState>,
    id: String,
    database: String,
    table: String,
    pk: Vec<PkCell>,
) -> Result<(), IpcError> {
    if read_only_of(&state, &id) {
        return Err(err(text_db::db_read_only_delete_blocked()));
    }
    match client_of(&state, &id)? {
        DbClient::Mssql(c) => mssql_row_change(&c, &database, &table, &pk, RowChange::Delete).await,
        DbClient::Sql(pool, engine) => sql_row_change(&pool, engine, &table, &pk, RowChange::Delete).await,
        DbClient::Mongo(_) => Err(err(text_db::db_row_delete_sql_only())),
        DbClient::Redis(_) => Err(err(text_db::db_row_delete_redis_unsupported())),
    }
}

// ---- 결과의 출처 테이블 판정 ----

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// 따옴표 없는 낱말 — 키워드·식별자·숫자.
    Word(String),
    /// 이 엔진이 식별자로 읽는 인용("…"·[…]·`…`) — 이스케이프를 푼 이름.
    Ident(String),
    Punct(char),
    /// 문자열 리터럴, 또는 이 엔진이 식별자로 읽지 않는 인용.
    Literal,
}

/// 엔진이 실제로 읽는 대로 토큰을 나눈다. 엔진과 다르게 읽을 여지가 있는 곳(백슬래시 이스케이프·MySQL `/*!`·
/// Postgres `$` 인용)은 해석을 포기한다 — 문자열 안으로 숨은 UNION 을 놓치면 다른 테이블 행을 이 테이블 키로 고친다.
fn tokenize(engine: DbEngine, sql: &str) -> Option<Vec<Tok>> {
    let cs: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        let next = cs.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // MySQL 의 `--` 는 뒤에 공백이 있어야 주석이다(`--1` 은 빼기 두 번).
        if c == '-'
            && next == Some('-')
            && (engine != DbEngine::Mysql || cs.get(i + 2).is_none_or(|ch| ch.is_whitespace()))
        {
            while i < cs.len() && cs[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            if engine == DbEngine::Mysql && cs.get(i + 2) == Some(&'!') {
                return None; // MySQL 은 `/*! … */` 안을 실행한다
            }
            let close = (i + 2..cs.len().saturating_sub(1)).find(|&j| cs[j] == '*' && cs[j + 1] == '/')?;
            i = close + 2;
            continue;
        }
        if c == '$' && engine == DbEngine::Postgres {
            return None;
        }
        let close = match c {
            '\'' => '\'',
            '"' => '"',
            '`' => '`',
            '[' => ']',
            _ => '\0',
        };
        if close != '\0' {
            let mut s = String::new();
            let mut j = i + 1;
            loop {
                let d = *cs.get(j)?;
                if d == '\\' {
                    return None;
                }
                if d == close {
                    if cs.get(j + 1) == Some(&close) {
                        s.push(close);
                        j += 2;
                        continue;
                    }
                    break;
                }
                s.push(d);
                j += 1;
            }
            i = j + 1;
            let ident = match c {
                '"' => matches!(engine, DbEngine::Postgres | DbEngine::Sqlite),
                '[' => matches!(engine, DbEngine::Mssql | DbEngine::Sqlite),
                '`' => matches!(engine, DbEngine::Mysql | DbEngine::Sqlite),
                _ => false,
            };
            out.push(if ident { Tok::Ident(s) } else { Tok::Literal });
            continue;
        }
        if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '_' || cs[i] == '$') {
                i += 1;
            }
            out.push(Tok::Word(cs[start..i].iter().collect()));
            continue;
        }
        out.push(Tok::Punct(c));
        i += 1;
    }
    Some(out)
}

fn is_word(t: Option<&Tok>, kw: &str) -> bool {
    matches!(t, Some(Tok::Word(w)) if w.eq_ignore_ascii_case(kw))
}

fn word_in(t: Option<&Tok>, set: &[&str]) -> bool {
    matches!(t, Some(Tok::Word(w)) if set.iter().any(|k| w.eq_ignore_ascii_case(k)))
}

/// 테이블 뒤에 와도 되는 절의 첫 낱말 — 이것들은 별칭으로 먹지 않는다.
const CLAUSE_START: &[&str] = &["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR"];
/// 꼬리(괄호 밖)에 있으면 결과 행이 이 테이블만의 행이 아니게 되는 낱말 — 다른 결과 집합(MSSQL 은 `;` 없이도 문장이
/// 이어진다)·집합 연산·집계·임시 테이블 이력(FOR SYSTEM_TIME).
const TAIL_FORBIDDEN: &[&str] = &[
    "SELECT", "EXEC", "EXECUTE", "CALL", "UNION", "INTERSECT", "EXCEPT", "MINUS", "GROUP", "HAVING", "INTO", "JOIN",
    "WINDOW", "COMPUTE", "OUTPUT", "RETURNING", "VALUES", "TABLE", "WITH", "SHOW", "PRAGMA", "SYSTEM_TIME",
];
/// 맨 낱말인데 컬럼이 아니라 값을 내는 것 — `SELECT user FROM t` 의 user 컬럼은 접속 계정 이름이다.
const NILADIC: &[&str] = &[
    "USER", "CURRENT_USER", "SESSION_USER", "SYSTEM_USER", "CURRENT_ROLE", "CURRENT_SCHEMA", "CURRENT_CATALOG",
    "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "LOCALTIME", "LOCALTIMESTAMP",
];

fn name_of(t: Option<&Tok>) -> Option<(String, bool)> {
    match t? {
        Tok::Word(w) => Some((w.clone(), false)),
        Tok::Ident(s) => Some((s.clone(), true)),
        _ => None,
    }
}

/// 결과 컬럼이 그 테이블의 실제 컬럼이고 행도 그 테이블의 행일 때만 테이블 이름 조각([스키마,] 이름 + 인용 여부)을 돌려준다.
/// 허용: `SELECT [TOP n] (* | [별칭.]* | [별칭.]컬럼, …) FROM [스키마.]테이블 [[AS] 별칭] [WHERE|ORDER|LIMIT|OFFSET|FETCH|FOR …]`.
/// 컬럼 별칭·식·DISTINCT·JOIN·여러 테이블·여러 문장은 거절한다(`SELECT name AS id` 의 id 로 고치면 엉뚱한 행이 바뀐다).
fn select_source_table(engine: DbEngine, query: &str) -> Option<Vec<(String, bool)>> {
    let mut t = tokenize(engine, query)?;
    while t.last() == Some(&Tok::Punct(';')) {
        t.pop();
    }
    if t.contains(&Tok::Punct(';')) {
        return None;
    }
    let at = |i: usize| t.get(i);
    if !is_word(at(0), "SELECT") {
        return None;
    }
    let mut i = 1;
    if is_word(at(i), "TOP") {
        let digits = |x: Option<&Tok>| matches!(x, Some(Tok::Word(w)) if w.chars().all(|c| c.is_ascii_digit()));
        if digits(at(i + 1)) {
            i += 2;
        } else if at(i + 1) == Some(&Tok::Punct('(')) && digits(at(i + 2)) && at(i + 3) == Some(&Tok::Punct(')')) {
            i += 4;
        } else {
            return None;
        }
    }
    loop {
        let bare_value = |x: Option<&Tok>| word_in(x, NILADIC);
        match at(i) {
            Some(Tok::Punct('*')) => i += 1,
            Some(Tok::Word(_) | Tok::Ident(_)) => {
                if at(i + 1) == Some(&Tok::Punct('.')) {
                    match at(i + 2) {
                        Some(Tok::Punct('*')) | Some(Tok::Word(_) | Tok::Ident(_)) => i += 3,
                        _ => return None,
                    }
                } else if bare_value(at(i)) {
                    return None;
                } else {
                    i += 1;
                }
            }
            _ => return None,
        }
        if at(i) == Some(&Tok::Punct(',')) {
            i += 1;
        } else {
            break;
        }
    }
    if !is_word(at(i), "FROM") {
        return None;
    }
    i += 1;
    let mut parts = vec![name_of(at(i))?];
    i += 1;
    if at(i) == Some(&Tok::Punct('.')) {
        parts.push(name_of(at(i + 1))?);
        i += 2;
    }
    if at(i) == Some(&Tok::Punct('.')) {
        return None; // db.schema.table — 지금 DB인지 확인할 수 없다
    }
    if is_word(at(i), "AS") {
        name_of(at(i + 1))?;
        i += 2;
    } else if matches!(at(i), Some(Tok::Ident(_))) || (matches!(at(i), Some(Tok::Word(_))) && !word_in(at(i), CLAUSE_START)) {
        i += 1;
    }
    if at(i).is_some() && !word_in(at(i), CLAUSE_START) {
        return None;
    }
    let mut depth = 0i32;
    for tok in &t[i..] {
        match tok {
            Tok::Punct('(') => depth += 1,
            Tok::Punct(')') => depth -= 1,
            _ if depth == 0 && word_in(Some(tok), TAIL_FORBIDDEN) => return None,
            _ => {}
        }
    }
    Some(parts)
}

/// 쿼리의 테이블 이름 조각을 사이드바 목록(`db_tables` — MSSQL/Postgres 는 "schema.table") 하나에 맞춘다. 둘 이상이면 None.
/// Postgres 는 인용 안 된 이름을 소문자로 접고 정확히 비교, 나머지는 대소문자를 가리지 않는다.
fn resolve_source_table(engine: DbEngine, parts: &[(String, bool)], tables: &[String]) -> Option<String> {
    let same = |listed: &str, (part, quoted): &(String, bool)| match engine {
        DbEngine::Postgres if *quoted => listed == part,
        DbEngine::Postgres => listed == part.to_lowercase(),
        _ => listed.to_lowercase() == part.to_lowercase(),
    };
    let schemaful = matches!(engine, DbEngine::Mssql | DbEngine::Postgres);
    let hits: Vec<&String> = tables
        .iter()
        .filter(|t| match (schemaful, parts) {
            (true, [s, n]) => t.split_once('.').is_some_and(|(ts, tn)| same(ts, s) && same(tn, n)),
            (true, [n]) => t.split_once('.').is_some_and(|(_, tn)| same(tn, n)),
            (false, [n]) => same(t, n),
            _ => false,
        })
        .collect();
    match hits.as_slice() {
        [one] => Some((*one).clone()),
        _ => None,
    }
}

/// 기본 키 컬럼이 결과에 다 있으면 그것, 아니면 결과에 다 들어 있는 가장 짧은 유일 키/유일 인덱스.
fn pick_row_key(meta: &TableMeta, columns: &[String]) -> Result<Vec<String>, String> {
    let has = |c: &String| columns.contains(c);
    let pk: Vec<String> = meta
        .keys
        .iter()
        .find(|k| k.kind == "PRIMARY KEY")
        .map(|k| k.columns.clone())
        .unwrap_or_else(|| meta.columns.iter().filter(|c| c.pk).map(|c| c.name.clone()).collect());
    if !pk.is_empty() && pk.iter().all(has) {
        return Ok(pk);
    }
    let uniques: Vec<&Vec<String>> = meta
        .keys
        .iter()
        .filter(|k| k.kind == "UNIQUE")
        .map(|k| &k.columns)
        .chain(meta.indexes.iter().filter(|x| x.unique).map(|x| &x.columns))
        // 식 인덱스는 컬럼 이름이 비어 온다 — 값으로 행을 고를 수 없다.
        .filter(|cols| !cols.is_empty() && cols.iter().all(|c| !c.is_empty()))
        .collect();
    if let Some(best) = uniques.iter().filter(|cols| cols.iter().all(has)).min_by_key(|cols| cols.len()) {
        return Ok((*best).clone());
    }
    let wanted = if pk.is_empty() { uniques.first().map(|c| (*c).clone()) } else { Some(pk) };
    match wanted {
        None => Err(text_db::db_grid_edit_no_key().into()),
        Some(cols) => {
            let missing: Vec<&str> = cols.iter().filter(|c| !has(c)).map(String::as_str).collect();
            Err(text_db::db_grid_edit_key_missing(&missing.join(", ")))
        }
    }
}

// ---- 한 행 바꾸기 ----

#[derive(Clone, Copy)]
enum RowChange<'a> {
    Update(&'a [PkCell]),
    Delete,
}

impl RowChange<'_> {
    fn failed(self, e: impl std::fmt::Display) -> IpcError {
        err(match self {
            RowChange::Update(_) => text_db::db_update_failed(e),
            RowChange::Delete => text_db::db_delete_failed(e),
        })
    }

    fn count_error(self, n: u64) -> IpcError {
        err(match (self, n) {
            (RowChange::Update(_), 0) => text_db::db_update_no_matching_row().to_string(),
            (RowChange::Delete, 0) => text_db::db_delete_no_matching_row().to_string(),
            (RowChange::Update(_), n) => text_db::db_update_pk_not_unique(n),
            (RowChange::Delete, n) => text_db::db_delete_multiple_rows(n),
        })
    }
}

/// NULL 키 값은 받지 않는다 — `col IS NULL` 로 바꾸면 그 컬럼이 NULL 인 다른 행이 맞는다
/// (드라이버가 못 읽는 타입도 그리드에는 null 로 온다).
fn check_row_key(pk: &[PkCell], change: RowChange) -> Result<(), IpcError> {
    if pk.is_empty() {
        return Err(err(match change {
            RowChange::Update(_) => text_db::db_edit_needs_primary_key(),
            RowChange::Delete => text_db::db_delete_needs_primary_key(),
        }));
    }
    if let Some(p) = pk.iter().find(|p| p.value.is_null()) {
        return Err(err(text_db::db_row_key_value_null(&p.col)));
    }
    if matches!(change, RowChange::Update(v) if v.is_empty()) {
        return Err(err(text_db::db_insert_no_values()));
    }
    Ok(())
}

/// sqlx 엔진(Postgres·MySQL·SQLite)의 UPDATE/DELETE 와 바인딩 순서. 값은 전부 바인딩, 식별자는 엔진별 인용.
fn sql_row_change_stmt<'a>(
    engine: DbEngine,
    table: &str,
    pk: &'a [PkCell],
    change: RowChange<'a>,
    pg_types: &HashMap<String, String>,
) -> Result<(String, Vec<&'a Json>), IpcError> {
    check_row_key(pk, change)?;
    let mut binds: Vec<&'a Json> = Vec::new();
    // Postgres 는 값을 텍스트로 보낸다(sqlx 가 String 을 TEXT 로 못박아 정수·날짜 컬럼이 "expression is of type text"로
    // 거절한다) — 그래서 컬럼 타입으로 CAST 해 되돌린다.
    let mut slot = |col: &str, v: &'a Json| {
        binds.push(v);
        let ph = placeholder(engine, binds.len());
        match pg_types.get(col) {
            Some(ty) if engine == DbEngine::Postgres => format!("CAST({ph} AS {ty})"),
            _ => ph,
        }
    };
    let head = match change {
        RowChange::Update(values) => {
            let sets: Vec<String> = values
                .iter()
                .map(|v| {
                    let rhs = if v.value.is_null() { "NULL".to_string() } else { slot(&v.col, &v.value) };
                    format!("{} = {}", quote_ident(engine, &v.col), rhs)
                })
                .collect();
            format!("UPDATE {} SET {}", quote_table(engine, table), sets.join(", "))
        }
        RowChange::Delete => format!("DELETE FROM {}", quote_table(engine, table)),
    };
    let wheres: Vec<String> =
        pk.iter().map(|p| format!("{} = {}", quote_ident(engine, &p.col), slot(&p.col, &p.value))).collect();
    Ok((format!("{head} WHERE {}", wheres.join(" AND ")), binds))
}

/// MSSQL 의 UPDATE/DELETE + 영향 행 수 조회. 값은 `sql_literal`(타입 검증·'' 이스케이프), 식별자는 `[ ]`(]] 이스케이프).
fn mssql_row_change_stmt(
    database: &str,
    table: &str,
    pk: &[PkCell],
    change: RowChange,
    types: &HashMap<String, String>,
) -> Result<String, IpcError> {
    check_row_key(pk, change)?;
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    let br = |s: &str| format!("[{}]", s.replace(']', "]]"));
    let ty = |c: &str| types.get(c).map(String::as_str).unwrap_or("");
    let target = format!("{}.{}.{}", br(database), br(schema), br(name));
    let mut wheres = Vec::with_capacity(pk.len());
    for p in pk {
        wheres.push(format!("{} = {}", br(&p.col), sql_literal(&p.value, ty(&p.col))?));
    }
    let wheres = wheres.join(" AND ");
    let head = match change {
        RowChange::Update(values) => {
            let mut sets = Vec::with_capacity(values.len());
            for v in values {
                sets.push(format!("{} = {}", br(&v.col), sql_literal(&v.value, ty(&v.col))?));
            }
            format!("UPDATE {target} SET {}", sets.join(", "))
        }
        RowChange::Delete => format!("DELETE FROM {target}"),
    };
    // MSSQL 은 앱 전체가 연결 하나를 같이 쓴다 — BEGIN TRAN 을 열었다가 오류 경로에서 못 닫으면 사용자의 다음 쿼리까지
    // 그 트랜잭션에 물린다. 대신 "키가 정확히 한 행에만 맞을 때" 조건을 같은 문장에 넣어 문장 원자성으로 막는다.
    Ok(format!("{head} WHERE {wheres} AND (SELECT COUNT(*) FROM {target} WHERE {wheres}) = 1; SELECT @@ROWCOUNT"))
}

async fn mssql_row_change(
    arc: &Arc<tokio::sync::Mutex<MssqlClient>>,
    database: &str,
    table: &str,
    pk: &[PkCell],
    change: RowChange<'_>,
) -> Result<(), IpcError> {
    let (schema, name) = table.split_once('.').unwrap_or(("dbo", table));
    let types = mssql_column_types(arc, database, schema, name).await?;
    let sql = mssql_row_change_stmt(database, table, pk, change, &types)?;
    let mut client = arc.lock().await;
    let sets = client
        .simple_query(sql)
        .await
        .map_err(|e| change.failed(e))?
        .into_results()
        .await
        .map_err(|e| change.failed(e))?;
    // 트리거가 결과 집합을 낼 수 있어 마지막 집합(SELECT @@ROWCOUNT)을 본다.
    match sets.last().and_then(|rows| rows.first()).and_then(|r| r.try_get::<i32, _>(0).ok().flatten()) {
        Some(1) => Ok(()),
        Some(_) => Err(err(text_db::db_row_not_exactly_one())),
        None => Err(change.failed(text_db::db_internal_error())),
    }
}

async fn sql_row_change(
    pool: &sqlx::AnyPool,
    engine: DbEngine,
    table: &str,
    pk: &[PkCell],
    change: RowChange<'_>,
) -> Result<(), IpcError> {
    let pg_types = if engine == DbEngine::Postgres { pg_column_types(pool, table).await? } else { HashMap::new() };
    let (sql, binds) = sql_row_change_stmt(engine, table, pk, change, &pg_types)?;
    let mut q = sqlx::query(&sql);
    for v in binds {
        q = if engine == DbEngine::Postgres { q.bind(json_as_text(v)) } else { bind_json(q, v) };
    }
    let mut tx = pool.begin().await.map_err(|e| change.failed(e))?;
    let n = q.execute(&mut *tx).await.map_err(|e| change.failed(e))?.rows_affected();
    if n == 1 {
        return tx.commit().await.map_err(|e| change.failed(e));
    }
    tx.rollback().await.map_err(|e| change.failed(e))?;
    Err(change.count_error(n))
}

fn json_as_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 컬럼 → `format_type` 표기(`integer`·`character varying(20)`·`timestamp without time zone`·사용자 enum 등 — CAST 에 그대로 쓴다).
async fn pg_column_types(pool: &sqlx::AnyPool, table: &str) -> Result<HashMap<String, String>, IpcError> {
    let rows = sqlx::query(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a \
         WHERE a.attrelid = CAST($1 AS regclass) AND a.attnum > 0 AND NOT a.attisdropped",
    )
    .bind(quote_table(DbEngine::Postgres, table))
    .fetch_all(pool)
    .await
    .map_err(|e| err(text_db::db_columns_query_failed(e)))?;
    Ok(rows
        .iter()
        .filter_map(|r| Some((r.try_get::<String, _>(0).ok()?, r.try_get::<String, _>(1).ok()?)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::super::{ColumnInfo, IndexInfo, KeyInfo};
    use super::*;
    use serde_json::json;

    fn parts(engine: DbEngine, q: &str) -> Option<Vec<String>> {
        select_source_table(engine, q).map(|p| p.into_iter().map(|(n, _)| n).collect())
    }

    #[test]
    fn grid_edit_accepts_the_sidebar_preview_queries() {
        // openCollection 의 defaultQuery 가 엔진마다 만드는 꼴.
        assert_eq!(parts(DbEngine::Mssql, "SELECT TOP 100 * FROM [dbo].[Users]"), Some(vec!["dbo".into(), "Users".into()]));
        assert_eq!(parts(DbEngine::Postgres, r#"SELECT * FROM "public"."users" LIMIT 100"#), Some(vec!["public".into(), "users".into()]));
        assert_eq!(parts(DbEngine::Mysql, "SELECT * FROM `users` LIMIT 100"), Some(vec!["users".into()]));
        assert_eq!(parts(DbEngine::Sqlite, r#"SELECT * FROM "users" LIMIT 100"#), Some(vec!["users".into()]));
    }

    #[test]
    fn grid_edit_accepts_plain_single_table_selects() {
        let ok = [
            "select id, name from users u where u.id > 3 order by id;",
            "SELECT u.* FROM users AS u WHERE name = 'O''Brien'",
            "SELECT TOP (5) id FROM dbo.users",
            "-- note\nSELECT * FROM users /* c */ WHERE id IN (SELECT id FROM other UNION SELECT 1)",
            "SELECT *, id FROM users FOR UPDATE",
        ];
        for q in ok {
            assert!(select_source_table(DbEngine::Mssql, q).is_some() || select_source_table(DbEngine::Postgres, q).is_some(), "{q}");
        }
        assert_eq!(select_source_table(DbEngine::Postgres, "SELECT * FROM Users"), Some(vec![("Users".into(), false)]));
    }

    #[test]
    fn grid_edit_refuses_anything_that_is_not_one_tables_rows() {
        let bad = [
            "SELECT name AS id FROM users",            // 컬럼 별칭 — id 로 고치면 다른 행
            "SELECT name id FROM users",               // AS 없는 별칭
            "SELECT id + 1 FROM users",                // 식
            "SELECT DISTINCT id FROM users",
            "SELECT user, id FROM users",              // 접속 계정 이름
            "SELECT * FROM users u JOIN orders o ON o.uid = u.id",
            "SELECT * FROM users, orders",
            "SELECT * FROM users UNION SELECT * FROM admins",
            "SELECT * FROM users WHERE 1 = 1 UNION ALL SELECT * FROM admins",
            "SELECT * FROM users GROUP BY id",
            "SELECT * FROM users; SELECT * FROM admins",
            "SELECT * FROM users WHERE id = 1 SELECT * FROM admins", // T-SQL 은 ; 없이 다음 문장
            "SELECT * FROM (SELECT * FROM users) x",
            "WITH x AS (SELECT * FROM users) SELECT * FROM x",
            "SELECT * INTO copy FROM users",
            "SELECT * FROM users FOR SYSTEM_TIME ALL",
            "SELECT * FROM db.dbo.users",
            "SELECT * FROM users WHERE name = 'a\\' UNION SELECT * FROM admins -- '",
            "SELECT * FROM users /* unterminated",
            "SELECT * FROM users WHERE name = 'unterminated",
            "UPDATE users SET a = 1",
            "",
        ];
        for q in bad {
            for e in [DbEngine::Mssql, DbEngine::Postgres, DbEngine::Mysql, DbEngine::Sqlite] {
                assert_eq!(select_source_table(e, q), None, "{e:?}: {q}");
            }
        }
    }

    #[test]
    fn grid_edit_reads_quotes_and_comments_the_way_each_engine_does() {
        // MySQL 의 "id" 는 문자열 리터럴 — 결과 컬럼 id 에 'id' 글자가 찬다.
        assert_eq!(select_source_table(DbEngine::Mysql, r#"SELECT "id" FROM users"#), None);
        assert!(select_source_table(DbEngine::Postgres, r#"SELECT "id" FROM users"#).is_some());
        // MySQL 의 /*! */ 안은 실행된다.
        assert_eq!(select_source_table(DbEngine::Mysql, "SELECT * FROM users /*! UNION SELECT * FROM admins */"), None);
        assert!(select_source_table(DbEngine::Postgres, "SELECT * FROM users /* UNION SELECT * FROM admins */").is_some());
        // MySQL 의 `--1` 은 주석이 아니다.
        assert_eq!(select_source_table(DbEngine::Mysql, "SELECT * FROM users WHERE id = 1 --1\nUNION SELECT * FROM admins"), None);
        // Postgres $ 인용은 읽지 않는다.
        assert_eq!(select_source_table(DbEngine::Postgres, "SELECT * FROM users WHERE a = $$'$$ UNION SELECT * FROM admins"), None);
        // 이스케이프된 식별자 이름
        assert_eq!(select_source_table(DbEngine::Mssql, "SELECT * FROM [we]]ird]"), Some(vec![("we]ird".into(), true)]));
    }

    #[test]
    fn grid_edit_resolves_one_listed_table_or_none() {
        let mssql = vec!["dbo.Users".to_string(), "sales.Users".to_string(), "dbo.Orders".to_string()];
        let p = |s: &[(&str, bool)]| s.iter().map(|(a, b)| (a.to_string(), *b)).collect::<Vec<_>>();
        assert_eq!(resolve_source_table(DbEngine::Mssql, &p(&[("orders", false)]), &mssql), Some("dbo.Orders".into()));
        assert_eq!(resolve_source_table(DbEngine::Mssql, &p(&[("Users", false)]), &mssql), None); // 두 스키마에 있다
        assert_eq!(resolve_source_table(DbEngine::Mssql, &p(&[("sales", false), ("users", false)]), &mssql), Some("sales.Users".into()));
        let pg = vec!["public.users".to_string(), "public.Users".to_string()];
        assert_eq!(resolve_source_table(DbEngine::Postgres, &p(&[("USERS", false)]), &pg), Some("public.users".into()));
        assert_eq!(resolve_source_table(DbEngine::Postgres, &p(&[("Users", true)]), &pg), Some("public.Users".into()));
        let flat = vec!["users".to_string()];
        assert_eq!(resolve_source_table(DbEngine::Mysql, &p(&[("Users", false)]), &flat), Some("users".into()));
        assert_eq!(resolve_source_table(DbEngine::Mysql, &p(&[("other", false), ("users", false)]), &flat), None);
    }

    fn meta(cols: &[(&str, bool)], keys: &[(&str, &[&str])], indexes: &[(&[&str], bool)]) -> TableMeta {
        TableMeta {
            columns: cols
                .iter()
                .map(|(n, pk)| ColumnInfo {
                    name: n.to_string(),
                    type_name: String::new(),
                    nullable: false,
                    pk: *pk,
                    identity: false,
                    has_default: false,
                })
                .collect(),
            keys: keys
                .iter()
                .map(|(kind, c)| KeyInfo {
                    name: String::new(),
                    kind: kind.to_string(),
                    columns: c.iter().map(|s| s.to_string()).collect(),
                    references: None,
                })
                .collect(),
            indexes: indexes
                .iter()
                .map(|(c, unique)| IndexInfo {
                    name: String::new(),
                    kind: String::new(),
                    unique: *unique,
                    columns: c.iter().map(|s| s.to_string()).collect(),
                })
                .collect(),
            constraints: Vec::new(),
            triggers: Vec::new(),
        }
    }

    #[test]
    fn grid_edit_picks_primary_key_then_unique_key_and_never_guesses() {
        let cols = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let m = meta(&[("a", true), ("b", true), ("email", false)], &[("PRIMARY KEY", &["b", "a"][..])], &[(&["email"][..], true)]);
        assert_eq!(pick_row_key(&m, &cols(&["a", "b", "email"])), Ok(cols(&["b", "a"])));
        // PK 컬럼이 결과에 없으면 결과에 다 있는 유일 키로
        assert_eq!(pick_row_key(&m, &cols(&["a", "email"])), Ok(cols(&["email"])));
        assert!(pick_row_key(&m, &cols(&["a"])).is_err());
        // 키가 아예 없으면 전 컬럼 일치 같은 추측 없이 거절
        let none = meta(&[("x", false), ("y", false)], &[], &[(&["x"][..], false), (&[""][..], true)]);
        assert!(pick_row_key(&none, &cols(&["x", "y"])).is_err());
        // MSSQL 의 UNIQUE 제약
        let uq = meta(&[("code", false)], &[("UNIQUE", &["code"][..])], &[]);
        assert_eq!(pick_row_key(&uq, &cols(&["code"])), Ok(cols(&["code"])));
    }

    fn cell(col: &str, value: Json) -> PkCell {
        PkCell { col: col.into(), value }
    }

    #[test]
    fn grid_edit_sqlx_statements_bind_values_and_quote_names() {
        let pk = [cell("id", json!(7))];
        let vals = [cell("na\"me", json!("O'Brien")), cell("note", Json::Null)];
        let types: HashMap<String, String> =
            [("id".to_string(), "integer".to_string()), ("na\"me".to_string(), "text".to_string())].into();
        let (sql, binds) =
            sql_row_change_stmt(DbEngine::Postgres, "public.we\"ird", &pk, RowChange::Update(&vals), &types).unwrap();
        assert_eq!(
            sql,
            r#"UPDATE "public"."we""ird" SET "na""me" = CAST($1 AS text), "note" = NULL WHERE "id" = CAST($2 AS integer)"#
        );
        assert_eq!(binds, vec![&json!("O'Brien"), &json!(7)]);

        let pk2 = [cell("a`b", json!("x")), cell("n", json!(2))];
        let (sql, binds) = sql_row_change_stmt(DbEngine::Mysql, "t", &pk2, RowChange::Delete, &HashMap::new()).unwrap();
        assert_eq!(sql, "DELETE FROM `t` WHERE `a``b` = ? AND `n` = ?");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn grid_edit_refuses_missing_or_null_keys() {
        let vals = [cell("c", json!("v"))];
        let none = HashMap::new();
        assert!(sql_row_change_stmt(DbEngine::Sqlite, "t", &[], RowChange::Delete, &none).is_err());
        assert!(sql_row_change_stmt(DbEngine::Sqlite, "t", &[cell("id", Json::Null)], RowChange::Delete, &none).is_err());
        assert!(sql_row_change_stmt(DbEngine::Sqlite, "t", &[cell("id", json!(1))], RowChange::Update(&[]), &none).is_err());
        assert!(mssql_row_change_stmt("d", "t", &[cell("id", Json::Null)], RowChange::Update(&vals), &none).is_err());
    }

    /// 실제 SQLite(메모리)로 쓰기 경로를 돈다 — 키가 한 행이면 바뀌고, 두 행 이상에 맞으면 트랜잭션을 되돌려 아무것도 안 바뀐다.
    #[tokio::test]
    async fn grid_edit_sqlite_changes_exactly_one_row_or_rolls_back() {
        super::super::ensure_sql_drivers();
        let pool = sqlx::any::AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        for q in [
            "CREATE TABLE t (id INTEGER PRIMARY KEY, grp TEXT, name TEXT)",
            "INSERT INTO t VALUES (1, 'a', 'x'), (2, 'a', 'y'), (3, 'b', 'z')",
        ] {
            sqlx::query(q).execute(&pool).await.unwrap();
        }
        let names = || async {
            sqlx::query("SELECT id, name FROM t ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| (r.try_get::<i64, _>(0).unwrap(), r.try_get::<Option<String>, _>(1).unwrap()))
                .collect::<Vec<_>>()
        };
        let sqlite = DbEngine::Sqlite;
        let tricky = json!("it's \"q\"; DROP TABLE t; --");
        sql_row_change(&pool, sqlite, "t", &[cell("id", json!(2))], RowChange::Update(&[cell("name", tricky.clone())]))
            .await
            .unwrap();
        // grp='a' 는 두 행 — 수정·삭제 모두 되돌린다
        let two = [cell("grp", json!("a"))];
        assert!(sql_row_change(&pool, sqlite, "t", &two, RowChange::Update(&[cell("name", json!("zz"))])).await.is_err());
        assert!(sql_row_change(&pool, sqlite, "t", &two, RowChange::Delete).await.is_err());
        sql_row_change(&pool, sqlite, "t", &[cell("id", json!(3))], RowChange::Delete).await.unwrap();
        assert!(sql_row_change(&pool, sqlite, "t", &[cell("id", json!(3))], RowChange::Delete).await.is_err());
        // 그리드가 보낸 문자열 키("1")도 INTEGER 컬럼에 맞는다(SQLite 숫자 친화) · NULL 저장
        sql_row_change(&pool, sqlite, "t", &[cell("id", json!("1"))], RowChange::Update(&[cell("name", Json::Null)]))
            .await
            .unwrap();
        assert_eq!(names().await, vec![(1, None), (2, Some("it's \"q\"; DROP TABLE t; --".to_string()))]);
        // 판정도 실제 메타로 — PK 가 결과에 있으면 그것, 없으면 거절
        let meta = sql_table_meta(&pool, sqlite, "t").await.unwrap();
        assert_eq!(pick_row_key(&meta, &["id".into(), "name".into()]), Ok(vec!["id".to_string()]));
        assert!(pick_row_key(&meta, &["name".into()]).is_err());
    }

    #[test]
    fn grid_edit_mssql_statement_escapes_and_guards_to_one_row() {
        let types: HashMap<String, String> = [("id".to_string(), "int".to_string())].into();
        let sql = mssql_row_change_stmt(
            "my]db",
            "dbo.t]x",
            &[cell("id", json!(5))],
            RowChange::Update(&[cell("na]me", json!("O'Brien"))]),
            &types,
        )
        .unwrap();
        assert_eq!(
            sql,
            "UPDATE [my]]db].[dbo].[t]]x] SET [na]]me] = N'O''Brien' WHERE [id] = 5 \
             AND (SELECT COUNT(*) FROM [my]]db].[dbo].[t]]x] WHERE [id] = 5) = 1; SELECT @@ROWCOUNT"
        );
        // 정수 컬럼에 정수가 아닌 키 값은 문장에 넣기 전에 거절(주입 차단)
        assert!(mssql_row_change_stmt("d", "t", &[cell("id", json!("1; DROP TABLE t"))], RowChange::Delete, &types).is_err());
    }
}
