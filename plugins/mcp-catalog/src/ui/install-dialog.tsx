import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SecretsStateResult } from "../core/contract";
import { messageOf } from "./api";
import { Centered, Notice } from "./parts";

export type SubmitResult = { ok: true } | { ok: false; message: string };

interface Props {
  title: string;
  description: string;
  submitLabel: string;
  /** Edit mode: a stored variable can be marked for clearing. */
  allowClear?: boolean;
  loadVariables: () => Promise<SecretsStateResult>;
  submit: (values: Record<string, string>, clear: string[]) => Promise<SubmitResult>;
  onDone: () => void;
  onClose: () => void;
}

/** Variables the server declares. Fields start empty: a stored secret shows only «задано» and is kept when the field stays empty. */
export function VariablesDialog({ title, description, submitLabel, allowClear = false, loadVariables, submit, onDone, onClose }: Props) {
  const [variables, setVariables] = useState<SecretsStateResult["variables"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadVariables().then(
      (result) => live && setVariables(result.variables),
      (error) => live && setLoadError(messageOf(error)),
    );
    return () => {
      live = false;
    };
  }, [loadVariables]);

  const typed = (key: string) => (values[key] ?? "") !== "";
  const blocked =
    variables === null ||
    variables.some((v) => v.isRequired && !typed(v.name) && (v.state === "missing" || cleared.has(v.name)));

  const toggleClear = (key: string) =>
    setCleared((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const sent = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== "" && !cleared.has(key)));
      const result = await submit(sent, [...cleared]);
      if (result.ok) onDone();
      else setProblem(result.message);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {loadError !== null && <Notice danger>{loadError}</Notice>}
        {variables === null && loadError === null && <Centered>Загрузка…</Centered>}
        {variables !== null && variables.length === 0 && <p className="text-sm text-muted-foreground">Сервер не требует переменных.</p>}
        {variables !== null && variables.length > 0 && (
          <div className="flex flex-col gap-3">
            {variables.map((variable) => {
              const willClear = cleared.has(variable.name);
              return (
                <div key={variable.name} className="flex flex-col gap-1 text-sm">
                  <label className="flex flex-col gap-1">
                    <span className="font-medium">
                      {variable.name}
                      {variable.isRequired && <span className="text-destructive"> *</span>}
                    </span>
                    {variable.description !== null && <span className="text-xs text-muted-foreground">{variable.description}</span>}
                    <Input
                      type={variable.isSecret ? "password" : "text"}
                      value={willClear ? "" : (values[variable.name] ?? "")}
                      disabled={willClear}
                      placeholder={willClear ? "будет очищено" : variable.state === "set" ? "задано" : ""}
                      onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    {variable.state === "set" && !willClear && <span className="text-xs text-muted-foreground">Пустое поле оставит прежнее значение.</span>}
                    {allowClear && variable.state === "set" && (
                      <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => toggleClear(variable.name)}>
                        {willClear ? "Не очищать" : "Очистить"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {problem !== null && <Notice danger>{problem}</Notice>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy || blocked} onClick={() => void send()}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
