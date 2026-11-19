// The "Agent access" section of the profile editor (stage 4a). A grant is the owner's own act and applies at once,
// separately from Save: it is not part of the profile's fields.
import { useEffect, useState } from "react";
import { AGENT_LEVELS, type AgentLevel } from "../core/agent-access.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import { ACCESS_NOTE, LEVEL_TEXT, type AgentApi } from "./agent-panel.tsx";

export interface AgentAccessSectionProps {
  api: AgentApi;
  /** null = the profile is not saved yet: there is nothing to grant. */
  profileId: string | null;
}

export function AgentAccessSection({ api, profileId }: AgentAccessSectionProps) {
  const [level, setLevel] = useState<AgentLevel>("none");
  const [record, setRecord] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profileId === null) return;
    let live = true;
    void api
      .list()
      .then((grants) => {
        if (!live) return;
        const mine = grants.find((g) => g.profileId === profileId);
        setLevel(mine?.level ?? "none");
        setRecord(mine?.recordCommands ?? false);
        setLoaded(true);
      })
      .catch((e) => live && setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))));
    return () => {
      live = false;
    };
  }, [api, profileId]);

  const apply = (nextLevel: AgentLevel, nextRecord: boolean) => {
    if (profileId === null) return;
    setBusy(true);
    setMessage(null);
    setProblem(null);
    void api
      .set(profileId, nextLevel, nextRecord)
      .then((granted) => {
        setLevel(granted.level);
        setRecord(granted.recordCommands);
        setMessage(granted.level === "none" ? "Агенты больше не могут пользоваться этим подключением." : `Агентам разрешено это подключение на уровне «${granted.level}».`);
      })
      .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };

  return (
    <fieldset aria-label="Доступ агентов">
      <legend>Доступ агентов</legend>
      <p className="rh-hint">{ACCESS_NOTE}</p>
      {profileId === null ? (
        <p className="rh-hint">Сначала сохраните подключение; после этого можно разрешить агентам им пользоваться.</p>
      ) : (
        <>
          <label>
            Уровень
            <select
              aria-label="Уровень доступа агентов"
              value={level}
              disabled={busy || !loaded}
              onChange={(e) => apply(e.target.value as AgentLevel, e.target.value === "exec" ? record : false)}
            >
              {AGENT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_TEXT[l]}
                </option>
              ))}
            </select>
          </label>
          {level === "exec" && (
            <label className="rh-check">
              <input type="checkbox" checked={record} disabled={busy} onChange={(e) => apply("exec", e.target.checked)} />
              Записывать текст команд в список активности (выключено: только длина)
            </label>
          )}
          {message !== null && <p role="status" className="rh-hint">{message}</p>}
          {problem !== null && <p role="alert" className="rh-error">{problem}</p>}
        </>
      )}
    </fieldset>
  );
}
