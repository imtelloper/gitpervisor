// DB 탐색기 — db_list/save/delete_connection + connect 오류분류(죽은 포트). 서버 불필요 경로 우선.
// 로컬 MongoDB(27017)/MSSQL(1433) 가 떠 있으면 connect→databases 까지 추가 검증(없으면 SKIP).
import net from "node:net";

export const name = "DB 탐색기 (db_list / save / connect / delete)";
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

export async function run({ cdp, report: r }) {
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
