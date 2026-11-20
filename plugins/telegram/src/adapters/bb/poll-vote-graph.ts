import { pollVoteGraph, type PollVoteGraph } from "../../core/contract.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function readPollVoteGraph(graph: Record<string, unknown> | undefined): PollVoteGraph | undefined {
  if (graph?.["@type"] !== "statisticalGraphData" || typeof graph.json_data !== "string" || graph.json_data.length > 1_048_576) return;
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(graph.json_data)); }
  catch { return; }
  const types = record(data?.types);
  const names = record(data?.names);
  const colors = record(data?.colors);
  if (!types || !Array.isArray(data?.columns) || data.columns.length < 2 || data.columns.length > 50) return;
  const ids = new Set<string>();
  let dates: unknown[] | undefined;
  let chartType: PollVoteGraph["chartType"] | undefined;
  const series = [];
  for (const column of data.columns) {
    if (!Array.isArray(column) || column.length < 2 || column.length > 3661) return;
    const [id, ...values] = column as unknown[];
    if (typeof id !== "string" || !id || id.length > 64 || ids.has(id)) return;
    ids.add(id);
    const kind = types[id];
    if (kind === "x") {
      if (dates) return;
      dates = values;
      continue;
    }
    if (kind !== "line" && kind !== "step" && kind !== "bar" && kind !== "area" || chartType && kind !== chartType) return;
    chartType = kind;
    const label = names?.[id];
    const rawColor = colors?.[id];
    const color = typeof rawColor === "string" ? rawColor.match(/#[0-9a-f]{6}$/i)?.[0] : undefined;
    series.push({ id, name: typeof label === "string" && label.trim() ? label.trim().slice(0, 128) : id, color, values });
  }
  const parsed = pollVoteGraph.safeParse({ dates, chartType, series,
    stacked: data.stacked === true, percentage: data.percentage === true, scaled: data.y_scaled === true,
    zoomable: typeof graph.zoom_token === "string" && graph.zoom_token.length > 0 && graph.zoom_token.length <= 4096 });
  return parsed.success ? parsed.data : undefined;
}
