import type { QueryClient } from "@tanstack/react-query";

import { monaco } from "../diff/monaco-setup";
import type { DbEngine, TableMeta } from "../../lib/ipc";
import { dbTablesQuery, tableMetaQuery } from "../../queries";
import { useDb } from "../../stores/db";

const COMMON_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS NULL", "IS NOT NULL", "IN", "EXISTS", "BETWEEN", "LIKE",
  "AS", "DISTINCT", "ORDER BY", "GROUP BY", "HAVING", "ASC", "DESC", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN",
  "FULL OUTER JOIN", "CROSS JOIN", "ON", "UNION", "UNION ALL", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
  "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "CREATE INDEX", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "COUNT",
  "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST", "PRIMARY KEY", "DEFAULT", "BEGIN", "COMMIT", "ROLLBACK",
];
const ENGINE_KEYWORDS: Partial<Record<DbEngine, string[]>> = {
  mssql: ["TOP", "WITH (NOLOCK)", "OFFSET", "FETCH NEXT", "ROWS ONLY", "ISNULL", "GETDATE()", "LEN", "EXEC", "NVARCHAR"],
  postgres: ["LIMIT", "OFFSET", "ILIKE", "RETURNING", "NOW()", "SERIAL", "TEXT", "JSONB"],
  mysql: ["LIMIT", "OFFSET", "IFNULL", "NOW()", "AUTO_INCREMENT", "VARCHAR"],
  sqlite: ["LIMIT", "OFFSET", "IFNULL", "PRAGMA", "AUTOINCREMENT", "TEXT", "INTEGER"],
};

// 따옴표는 \x22·\x60 으로 쓴다 — i18n 소스 스캐너가 정규식 속 따옴표를 문자열 시작으로 읽는다.
const IDENT = String.raw`(?:\x22[^\x22]+\x22|\[[^\]]+\]|\x60[^\x60]+\x60|[A-Za-z_#@][\w$#@]*)`;
const REF = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;
const REF_RE = new RegExp(String.raw`\b(FROM|JOIN|UPDATE|INTO)\s+(${REF})(?:\s+(?:AS\s+)?(${IDENT}))?`, "gi");
const NEXT_REF_RE = new RegExp(String.raw`\s*,\s*(${REF})(?:\s+(?:AS\s+)?(${IDENT}))?`, "iy");
const MEMBER_RE = new RegExp(String.raw`(${IDENT})\.$`);
/** 테이블 뒤에 와도 별칭이 아닌 낱말. */
const NOT_ALIAS = new Set([
  "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "NATURAL", "ON", "USING", "GROUP", "ORDER",
  "HAVING", "LIMIT", "OFFSET", "FETCH", "UNION", "EXCEPT", "INTERSECT", "SET", "VALUES", "WITH", "FOR", "WINDOW",
  "SELECT", "OUTPUT", "DEFAULT", "RETURNING",
]);
const TABLE_AFTER = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE"]);

const unquote = (s: string) => s.replace(/^[\x22[\x60]|[\x22\]\x60]$/g, "");
const lastPart = (s: string) => (s.split(".").pop() ?? s).toLowerCase();

/** 주석·문자열을 공백으로 — 그 안의 FROM·별칭을 참조로 읽지 않게. */
function stripSqlNoise(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\x27(?:[^\x27]|\x27\x27)*\x27?/g, (m) => " ".repeat(m.length));
}

/** FROM·JOIN·UPDATE·INTO 뒤 테이블 참조와 별칭(FROM a x, b y 쉼표 목록 포함). */
function sqlTableRefs(sql: string): { table: string; alias: string | null }[] {
  const text = stripSqlNoise(sql);
  const out: { table: string; alias: string | null }[] = [];
  const push = (ref: string, alias: string | undefined) =>
    out.push({
      table: ref.split(/\s*\.\s*/).map(unquote).join("."),
      alias: alias && !NOT_ALIAS.has(alias.toUpperCase()) ? unquote(alias) : null,
    });
  for (const m of text.matchAll(REF_RE)) {
    push(m[2], m[3]);
    if (m[1].toUpperCase() !== "FROM") continue;
    NEXT_REF_RE.lastIndex = (m.index ?? 0) + m[0].length;
    for (let n = NEXT_REF_RE.exec(text); n; n = NEXT_REF_RE.exec(text)) push(n[1], n[2]);
  }
  return out;
}

type SqlSlot = { kind: "member"; qualifier: string } | { kind: "table" } | { kind: "any" };

/** 커서 앞 텍스트(주석·문자열 제거됨)로 지금 무엇을 쓰는 자리인지. */
function sqlSlotAt(before: string): SqlSlot {
  const member = MEMBER_RE.exec(before);
  if (member) return { kind: "member", qualifier: unquote(member[1]) };
  const prev = /([A-Za-z_]+)\s*$/.exec(before)?.[1]?.toUpperCase();
  if (prev && TABLE_AFTER.has(prev)) return { kind: "table" };
  if (/,\s*$/.test(before)) {
    const clause = [...before.matchAll(/\b(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|SET|VALUES|ON|JOIN)\b/gi)].pop();
    if (clause?.[1].toUpperCase() === "FROM") return { kind: "table" };
  }
  return { kind: "any" };
}

function quoteIdent(engine: DbEngine | null, name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(engine === "postgres" && /[A-Z]/.test(name));
  if (plain) return name;
  if (engine === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  if (engine === "mysql") return "\x60" + name.replace(/\x60/g, "\x60\x60") + "\x60";
  return '"' + name.replace(/\x22/g, '""') + '"';
}

/** 사이드바 목록(MSSQL·Postgres 는 "schema.table")에서 쿼리에 쓴 이름에 맞는 항목. */
function findTable(tables: string[], name: string): string | undefined {
  const n = name.toLowerCase();
  return tables.find((t) => t.toLowerCase() === n) ?? tables.find((t) => lastPart(t) === lastPart(n));
}

async function orFallback<T>(load: Promise<T>, fallback: T): Promise<T> {
  try {
    return await load;
  } catch {
    // 자동완성은 메타를 못 가져와도 키워드만으로 계속 돈다 — 연결 오류는 사이드바·실행 결과가 이미 보여 준다.
    return fallback;
  }
}

/**
 * DB 쿼리 편집기의 SQL 자동완성 — 키워드, 현재 DB의 테이블, FROM·JOIN 에 나온 테이블(별칭 포함)의 컬럼.
 * `별칭.`·`테이블.` 뒤에서는 그 테이블 컬럼만, `스키마.` 뒤에서는 그 스키마 테이블만. 메타는 사이드바와 같은 쿼리 캐시를 쓴다.
 */
export function registerSqlCompletion(
  editor: monaco.editor.IStandaloneCodeEditor,
  qc: QueryClient,
): monaco.IDisposable {
  const Kind = monaco.languages.CompletionItemKind;
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position) => {
      // 언어 단위 등록이라 다른 SQL 편집기(파일 뷰어 등)에도 불린다 — 이 편집기 모델에만 답한다.
      if (model !== editor.getModel()) return { suggestions: [] };
      const { activeConnId: conn, activeDatabase: db, activeEngine: engine } = useDb.getState();
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const before = stripSqlNoise(
        model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: word.startColumn,
        }),
      );
      const slot = sqlSlotAt(before);
      const tables = conn && db ? await orFallback<string[]>(qc.fetchQuery(dbTablesQuery(conn, db)), []) : [];
      const columnsOf = async (table: string) =>
        conn && db
          ? ((await orFallback<TableMeta | null>(qc.fetchQuery(tableMetaQuery(conn, db, table)), null))?.columns ?? [])
          : [];
      const refs = sqlTableRefs(model.getValue());

      const tableItem = (t: string, sortText: string, label = t): monaco.languages.CompletionItem => ({
        label,
        kind: Kind.Struct,
        detail: t,
        insertText: label.split(".").map((p) => quoteIdent(engine, p)).join("."),
        filterText: `${lastPart(label)} ${label}`,
        sortText,
        range,
      });
      const columnItems = async (table: string, sortText: string) =>
        (await columnsOf(table)).map(
          (c): monaco.languages.CompletionItem => ({
            label: c.name,
            kind: c.pk ? Kind.Constant : Kind.Field,
            detail: `${c.typeName} · ${table}`,
            insertText: quoteIdent(engine, c.name),
            sortText,
            range,
          }),
        );

      if (slot.kind === "member") {
        const q = slot.qualifier.toLowerCase();
        const ref =
          refs.find((r) => r.alias?.toLowerCase() === q) ?? refs.find((r) => lastPart(r.table) === q);
        const table = findTable(tables, ref?.table ?? slot.qualifier);
        if (table) return { suggestions: await columnItems(table, "0") };
        const inSchema = tables.filter((t) => t.toLowerCase().startsWith(`${q}.`));
        return { suggestions: inSchema.map((t) => tableItem(t, "0", t.slice(q.length + 1))) };
      }

      const keywords = [...COMMON_KEYWORDS, ...((engine && ENGINE_KEYWORDS[engine]) ?? [])].map(
        (k): monaco.languages.CompletionItem => ({
          label: k,
          kind: Kind.Keyword,
          insertText: k,
          sortText: "2",
          range,
        }),
      );
      const tableItems = tables.map((t) => tableItem(t, slot.kind === "table" ? "0" : "1"));
      if (slot.kind === "table") return { suggestions: [...tableItems, ...keywords] };

      const used = [...new Set(refs.map((r) => findTable(tables, r.table)).filter((t): t is string => !!t))];
      const columns = (await Promise.all(used.slice(0, 8).map((t) => columnItems(t, "0")))).flat();
      return { suggestions: [...columns, ...tableItems, ...keywords] };
    },
  });
}
