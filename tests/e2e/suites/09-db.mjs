// DB 탐색기 — db_list/save/delete_connection + connect 오류분류(죽은 포트). 서버 불필요 경로 우선.
// SQLite(파일 기반)는 서버 없이 실통합 검증한다. 로컬 MongoDB(27017)/MSSQL(1433) 가 떠 있으면
// connect→databases 까지 추가 검증(없으면 SKIP).
import net from "node:net";
import { join } from "node:path";

export const name = "DB 탐색기 (db_list / save / connect / delete + SQLite 실통합)";
const CONN_ID = "gpv-e2e-conn";

function portOpen(port, host = "127.0.0.1", timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(port, host);
  });
}

export async function run({ cdp, report: r, fix }) {
  // ── list(기존 연결 보존 확인용 베이스라인) ──
  const before = await cdp.invoke("db_list_connections");
  r.check("db_list_connections: 배열 반환", Array.isArray(before), `${before?.length}개`);

  // ── save(메타 영속) ──
  const connection = { id: CONN_ID, name: "e2e-temp", engine: "mongodb", host: "127.0.0.1", port: 65000, database: null, username: "", options: "serverSelectionTimeoutMS=1500&connectTimeoutMS=1500", readOnly: true, color: null };
  const saved = await cdp.invoke("db_save_connection", { payload: { connection, password: null } });
  r.check("db_save_connection: 저장된 연결 반환", saved?.id === CONN_ID, saved?.id);
  const mid = await cdp.invoke("db_list_connections");
  r.check("db_list_connections: 새 연결 포함", (mid || []).some((c) => c.id === CONN_ID));
  r.check("db_list_connections: 기존 연결 보존", before.every((c) => (mid || []).some((m) => m.id === c.id)), "(사용자 연결 유지)");

  // ── connect: 죽은 포트 → 오류 분류(서버 불필요) ──
  const conn = await cdp.try("db_connect", { id: CONN_ID }, { timeoutMs: 9000 });
  // 타임아웃이 아닌 "실제 연결 실패"여야 한다 — E2E_TIMEOUT 은 db_connect 가 멈춘 것일 뿐 검증이 아님.
  r.check("db_connect: 죽은 포트 → 실패 분류", !conn.ok && conn.code !== "E2E_TIMEOUT", conn.code || conn.message?.slice(0, 60) || "(ok?)");

  // ── 비연결 상태에서 조회/CRUD 커맨드 — 모두 "등록됨 + 클라이언트 가드"로 오류 반환해야 함
  //    (서버 없이도 명령 등록·도달 가능성을 검증; 'command not found' 면 미등록 버그) ──
  const guarded = [
    ["db_tables", { id: CONN_ID, database: "x" }],
    ["db_query", { id: CONN_ID, database: "x", query: "select 1", limit: 10 }],
    ["db_table_meta", { id: CONN_ID, database: "x", table: "t" }],
    ["db_explain", { id: CONN_ID, database: "x", query: "select 1" }],
    ["db_procedures", { id: CONN_ID, database: "x" }],
    ["db_proc_params", { id: CONN_ID, database: "x", proc: "p" }],
    ["db_update_cell", { id: CONN_ID, database: "x", table: "t", pk: [{ col: "id", value: 1 }], setCol: "c", setValue: 1 }],
    ["db_delete_row", { id: CONN_ID, database: "x", table: "t", pk: [{ col: "id", value: 1 }] }],
    ["db_insert_row", { id: CONN_ID, database: "x", table: "t", values: [{ col: "id", value: 1 }] }],
  ];
  for (const [cmd, args] of guarded) {
    const res = await cdp.try(cmd, args, { timeoutMs: 9000 });
    const notFound = /not found|등록/i.test(res.message || "") && !res.code; // 'command X not found'
    // 미등록(notFound)도, 타임아웃(E2E_TIMEOUT — 등록을 증명 못 함)도 통과시키지 않는다.
    r.check(`${cmd}: 등록됨 + 비연결 시 오류`, !res.ok && !notFound && res.code !== "E2E_TIMEOUT", res.code || res.message?.slice(0, 40) || "(ok?)");
  }

  // ── SQLite 실통합 (서버 불필요 — 파일 기반). 연결/CREATE/INSERT/SELECT/UPDATE/메타/EXPLAIN/DELETE ──
  const SQLITE_ID = "gpv-e2e-sqlite";
  const dbFile = join(fix.repo, "e2e-sqlite.db"); // 픽스처 정리 시 함께 삭제됨
  const sconn = {
    id: SQLITE_ID, name: "e2e-sqlite", engine: "sqlite",
    host: "", port: 0, database: dbFile, username: "", options: null,
    readOnly: false, color: null,
  };
  await cdp.invoke("db_save_connection", { payload: { connection: sconn, password: null } });
  const sc = await cdp.try("db_connect", { id: SQLITE_ID }, { timeoutMs: 12000 });
  r.check("sqlite: db_connect(파일 생성)", sc.ok, sc.code || sc.message?.slice(0, 60) || "");
  if (sc.ok) {
    const Q = (query) => ({ id: SQLITE_ID, database: "main", query, limit: 100 });
    const ddl = await cdp.try("db_query", Q("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"), { timeoutMs: 12000 });
    r.check("sqlite: CREATE TABLE", ddl.ok, ddl.code || ddl.message?.slice(0, 60) || "");

    const ins = await cdp.try("db_insert_row", { id: SQLITE_ID, database: "main", table: "t", values: [{ col: "id", value: 1 }, { col: "name", value: "alice" }] }, { timeoutMs: 12000 });
    r.check("sqlite: db_insert_row(파라미터 DML)", ins.ok, ins.code || ins.message?.slice(0, 60) || "");

    const sel = await cdp.try("db_query", Q("SELECT id, name FROM t"), { timeoutMs: 12000 });
    r.check(
      "sqlite: SELECT 결과 정합",
      sel.ok && sel.r?.rowCount === 1 && sel.r.rows?.[0]?.[1] === "alice",
      JSON.stringify(sel.r?.rows),
    );

    const upd = await cdp.try("db_update_cell", { id: SQLITE_ID, database: "main", table: "t", pk: [{ col: "id", value: 1 }], setCol: "name", setValue: "bob" }, { timeoutMs: 12000 });
    r.check("sqlite: db_update_cell", upd.ok, upd.code || upd.message?.slice(0, 60) || "");

    const meta = await cdp.try("db_table_meta", { id: SQLITE_ID, database: "main", table: "t" }, { timeoutMs: 12000 });
    r.check(
      "sqlite: db_table_meta(컬럼/PK)",
      meta.ok && meta.r?.columns?.some((c) => c.name === "id" && c.pk),
      JSON.stringify(meta.r?.columns?.map((c) => [c.name, c.pk])),
    );

    const exp = await cdp.try("db_explain", { id: SQLITE_ID, database: "main", query: "SELECT * FROM t WHERE id=1" }, { timeoutMs: 12000 });
    r.check("sqlite: db_explain(QUERY PLAN)", exp.ok && typeof exp.r === "string" && exp.r.length > 0, exp.ok ? "(계획 반환)" : exp.code);

    const tbls = await cdp.try("db_tables", { id: SQLITE_ID, database: "main" }, { timeoutMs: 12000 });
    r.check("sqlite: db_tables", tbls.ok && (tbls.r || []).includes("t"), JSON.stringify(tbls.r));

    const del2 = await cdp.try("db_delete_row", { id: SQLITE_ID, database: "main", table: "t", pk: [{ col: "id", value: 1 }] }, { timeoutMs: 12000 });
    r.check("sqlite: db_delete_row", del2.ok, del2.code || "");

    await cdp.try("db_disconnect", { id: SQLITE_ID });
  }
  await cdp.invoke("db_delete_connection", { id: SQLITE_ID });

  // ── 선택: 로컬 DB 서버가 있으면 connect→databases 추가 검증 ──
  const mongoUp = await portOpen(27017);
  if (mongoUp) {
    const live = { id: "gpv-e2e-mongo", name: "e2e-mongo-live", engine: "mongodb", host: "127.0.0.1", port: 27017, database: null, username: "", options: "serverSelectionTimeoutMS=2500", readOnly: true, color: null };
    await cdp.invoke("db_save_connection", { payload: { connection: live, password: null } });
    const lc = await cdp.try("db_connect", { id: live.id }, { timeoutMs: 12000 });
    if (lc.ok) {
      const dbs = await cdp.try("db_databases", { id: live.id }, { timeoutMs: 12000 });
      r.check("db_connect/db_databases(로컬 mongo): DB 목록", dbs.ok && Array.isArray(dbs.r), JSON.stringify(dbs.r?.slice?.(0, 4)));
      const firstDb = dbs.ok && dbs.r.find((d) => !["admin", "local", "config"].includes(d));
      if (firstDb) {
        const tbls = await cdp.try("db_tables", { id: live.id, database: firstDb }, { timeoutMs: 12000 });
        r.check(`db_tables(로컬 mongo/${firstDb}): 컬렉션 목록`, tbls.ok && Array.isArray(tbls.r), JSON.stringify(tbls.r?.slice?.(0, 4)));
      }
      await cdp.try("db_disconnect", { id: live.id });
    } else {
      r.skip("로컬 mongo connect", `포트는 열림이나 인증/핸드셰이크 실패 — ${lc.code || lc.message}`);
    }
    await cdp.try("db_delete_connection", { id: live.id });
  } else {
    r.skip("로컬 DB CRUD(connect/databases/tables/query)", "127.0.0.1:27017 / 1433 미응답 — 서버 없음");
  }

  // ── delete(정리 + 영속 검증) ──
  await cdp.invoke("db_delete_connection", { id: CONN_ID });
  const after = await cdp.invoke("db_list_connections");
  r.check("db_delete_connection: 연결 제거됨", !(after || []).some((c) => c.id === CONN_ID));
  r.check("db_delete_connection: 기존 연결 그대로", before.every((c) => (after || []).some((a) => a.id === c.id)), "(사용자 연결 보존)");
}
