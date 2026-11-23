export interface EventRecord {
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
}

export interface Activity {
  seq: number;
  createdAt: number;
  kind: "agent" | "check" | "change" | "plan" | "attention" | "run";
  title: string;
  detail?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = 1200): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

export interface PlanStep {
  title: string;
  status: "pending" | "active" | "completed" | "failed";
}

export function planSteps(event: EventRecord): PlanStep[] {
  const data = record(event.data);
  const item = record(data.item);
  const steps = event.type === "turn/plan/updated" ? data.plan :
    event.type === "item/completed" && item.type === "planSteps" ? item.steps : undefined;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap(raw => {
    const step = record(raw);
    const title = text(step.step);
    if (!title) return [];
    const status = step.status;
    return [{ title, status: status === "active" || status === "completed" || status === "failed" ? status : "pending" }];
  });
}

const verification = /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b|(?:pytest|vitest|jest|tsc|eslint|ruff)\b|(?:go|cargo|node)\s+(?:test|--test)\b)/;

export function activity(event: EventRecord): Activity | null {
  const { seq, createdAt, type } = event;
  const data = record(event.data);
  const entry = (kind: Activity["kind"], title: string, detail?: string): Activity =>
    ({ seq, createdAt, kind, title, detail });

  switch (type) {
    case "item/completed": {
      const item = record(data.item);
      if (item.type === "planSteps") {
        const detail = planSteps(event).find(step => step.status === "active")?.title;
        return detail ? entry("plan", "Этап плана", detail) : null;
      }
      if (item.type === "agentMessage" && text(item.text)) {
        return entry("agent", "Сообщение агента", text(item.text));
      }
      if (item.type === "commandExecution" && typeof item.exitCode === "number") {
        const command = text(item.command);
        if (item.exitCode !== 0) return entry("check", "Команда завершилась с кодом " + item.exitCode, command);
        if (command && verification.test(command)) return entry("check", "Проверка · код выхода 0", command);
      }
      if (item.type === "fileChange" && item.status === "completed" && Array.isArray(item.changes)) {
        const paths = item.changes.flatMap(change => text(record(change).path, 220) ?? []).slice(0, 8);
        if (paths.length) return entry("change", "Изменения в файлах", paths.join("\n"));
      }
      return null;
    }
    case "turn/plan/updated": {
      const detail = planSteps(event).find(step => step.status === "active")?.title;
      return detail ? entry("plan", "Этап плана", detail) : null;
    }
    case "system/interaction/lifecycle": {
      const interaction = record(data.interaction);
      return interaction.status === "pending"
        ? entry("attention", "BB запросил ответ", text(record(interaction.payload).title ?? interaction.title))
        : null;
    }
    case "provider/modelFallback":
      return entry("change", "BB сменил модель");
    case "system/error":
      return entry("attention", "Ошибка BB", text(data.message));
    case "turn/completed":
      if (data.status === "failed") return entry("attention", "Ход завершился ошибкой", text(record(data.error).message));
      if (data.status === "interrupted") return entry("run", "Ход прерван");
      return data.status === "completed" ? entry("run", "Ход завершён") : null;
    default:
      return null;
  }
}

export function viewedThrough(previous: number, rows: readonly {seq: number}[]): number {
  return rows.reduce((through, row) => Math.max(through, row.seq), previous);
}
