import type { TemplateParam } from "../../core/templating/engine.ts";

/** One template parameter as a form field: a checkbox, a list, a word or a line of free text. */
export function ParamField({param, value, onChange}: {param: TemplateParam; value: string | boolean; onChange(value: string | boolean): void}) {
  if (param.kind === "flag") return <label className="git-ci-check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)}/>
    <span>{param.label}</span></label>;
  if (param.kind === "choice") return <label>{param.label}<select value={String(value)} onChange={event => onChange(event.target.value)}>
    {param.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select></label>;
  return <label>{param.label}<input value={String(value)} maxLength={param.kind === "line" ? 200 : 100} onChange={event => onChange(event.target.value)}/></label>;
}
