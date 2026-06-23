import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { EnvVar } from "../../stores/apiclient";
import { useApiClient } from "../../stores/apiclient";

/**
 * 환경 관리 모달(§8.5) — fixed inset-0 + 좌 환경목록 / 우 변수 KeyValueEditor.
 * setEnvVar / addEnvironment / removeEnvironment 로 저장(즉시 영속).
 */
export function EnvDialog() {
  const open = useApiClient((s) => s.envDialogOpen);
  const close = useApiClient((s) => s.closeEnvDialog);
  const environments = useApiClient((s) => s.environments);
  const addEnvironment = useApiClient((s) => s.addEnvironment);
  const removeEnvironment = useApiClient((s) => s.removeEnvironment);
  const setEnvVar = useApiClient((s) => s.setEnvVar);

  const [selected, setSelected] = useState<string | null>(null);

  const envList = Object.values(environments);

  // 선택 보정: 선택된 env가 사라지거나 비어 있으면 첫 항목으로.
  useEffect(() => {
    if (!open) return;
    if (selected && environments[selected]) return;
    setSelected(envList[0]?.id ?? null);
  }, [open, selected, environments, envList]);

  if (!open) return null;

  const env = selected ? environments[selected] : undefined;

  const updateVar = (index: number, patch: Partial<EnvVar>) => {
    if (!env) return;
    setEnvVar(env.id, index, patch);
  };

  // 새 빈 변수 행 추가 — store에 직접 setEnvVar는 index 기반이므로 vars를 통째로 갱신한다.
  const addVarRow = () => {
    if (!env) return;
    const vars: EnvVar[] = [...env.vars, { key: "", value: "", secret: false }];
    useApiClient.setState((s) => ({
      environments: { ...s.environments, [env.id]: { ...env, vars } },
    }));
  };

  const removeVarRow = (index: number) => {
    if (!env) return;
    const vars = env.vars.filter((_, i) => i !== index);
    useApiClient.setState((s) => ({
      environments: { ...s.environments, [env.id]: { ...env, vars } },
    }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={close}
    >
      <div
        className="flex h-[480px] w-[680px] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-3">
          <span className="font-semibold">환경 관리</span>
          <button
            onClick={close}
            className="rounded px-2 py-0.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            닫기 ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 좌: 환경 목록 */}
          <div className="flex w-48 shrink-0 flex-col border-r border-edge">
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {envList.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-fg-dim">
                  환경이 없습니다.
                </div>
              )}
              {envList.map((e) => (
                <div
                  key={e.id}
                  className={`group flex items-center gap-1 px-3 py-1 text-[13px] hover:bg-raised ${
                    selected === e.id ? "bg-raised" : ""
                  }`}
                >
                  <button
                    onClick={() => setSelected(e.id)}
                    className="min-w-0 flex-1 truncate text-left text-fg"
                  >
                    {e.name}
                    <span className="ml-1 text-[10px] text-fg-dim">
                      {e.scope === "global" ? "G" : "C"}
                    </span>
                  </button>
                  <button
                    onClick={() => removeEnvironment(e.id)}
                    title="환경 삭제"
                    className="shrink-0 text-fg-dim opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() =>
                setSelected(
                  addEnvironment({
                    name: "새 환경",
                    scope: "global",
                    collectionId: null,
                    vars: [],
                  }),
                )
              }
              className="flex shrink-0 items-center gap-1 border-t border-edge px-3 py-2 text-[12px] text-fg-muted hover:bg-raised hover:text-fg"
            >
              <Plus size={13} /> 환경 추가
            </button>
          </div>

          {/* 우: 변수 편집 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!env ? (
              <div className="flex flex-1 items-center justify-center text-[13px] text-fg-dim">
                좌측에서 환경을 선택하세요
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
                  <input
                    value={env.name}
                    onChange={(e) =>
                      useApiClient.setState((s) => ({
                        environments: {
                          ...s.environments,
                          [env.id]: { ...env, name: e.target.value },
                        },
                      }))
                    }
                    className="w-48 rounded border border-edge bg-base px-2 py-1 text-[13px] outline-none focus:border-accent"
                  />
                  <select
                    value={env.scope}
                    onChange={(e) =>
                      useApiClient.setState((s) => ({
                        environments: {
                          ...s.environments,
                          [env.id]: {
                            ...env,
                            scope: e.target.value as "global" | "collection",
                          },
                        },
                      }))
                    }
                    className="rounded border border-edge bg-base px-2 py-1 text-[12px] outline-none focus:border-accent"
                  >
                    <option value="global">Global</option>
                    <option value="collection">Collection</option>
                  </select>
                </div>

                <div className="min-h-0 flex-1 overflow-auto text-[13px]">
                  {env.vars.map((v, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 border-b border-edge/50 px-3 py-1"
                    >
                      <input
                        value={v.key}
                        onChange={(e) => updateVar(i, { key: e.target.value })}
                        placeholder="key"
                        className="w-1/3 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
                      />
                      <input
                        value={v.value}
                        onChange={(e) => updateVar(i, { value: e.target.value })}
                        placeholder="value"
                        type={v.secret ? "password" : "text"}
                        className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
                      />
                      <label
                        className="flex shrink-0 items-center gap-1 text-[11px] text-fg-dim"
                        title="히스토리에서 마스킹"
                      >
                        <input
                          type="checkbox"
                          checked={v.secret}
                          onChange={(e) =>
                            updateVar(i, { secret: e.target.checked })
                          }
                          className="accent-accent"
                        />
                        secret
                      </label>
                      <button
                        onClick={() => removeVarRow(i)}
                        title="변수 삭제"
                        className="shrink-0 text-fg-dim hover:text-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addVarRow}
                    className="flex items-center gap-1 px-3 py-2 text-[12px] text-fg-muted hover:text-fg"
                  >
                    <Plus size={13} /> 변수 추가
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
