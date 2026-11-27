import type { GraphRow } from "../../core/history/graph.ts";

export const rowHeight = 30;
const gap = 14;
const offset = 9;
const colors = ["#9566dc", "#42a675", "#e09b3d", "#4a90d9", "#d95f76", "#3fb4b4"];
const x = (lane: number) => offset + lane * gap;
const color = (lane: number) => colors[lane % colors.length];
export const graphWidth = (lanes: number) => offset * 2 + Math.max(0, lanes - 1) * gap;

/** One row of the commit graph; geometry follows the lane layout ported from git-history. */
export function GraphCell({row, width, head}: {row: GraphRow; width: number; head: boolean}) {
  const middle = rowHeight / 2;
  const at = x(row.commitLane);
  return <svg className="git-history-graph" width={width} height={rowHeight} viewBox={`0 0 ${width} ${rowHeight}`} aria-hidden="true">
    {row.topLanes.map(lane => <line key={"t" + lane} x1={x(lane)} y1={0} x2={x(lane)} y2={middle} stroke={color(lane)}/>)}
    {!row.startsHere && <line x1={at} y1={0} x2={at} y2={middle} stroke={color(row.commitLane)}/>}
    {row.bottomLanes.map(lane => <line key={"b" + lane} x1={x(lane)} y1={middle} x2={x(lane)} y2={rowHeight} stroke={color(lane)}/>)}
    {row.edges.map((edge, index) => edge.kind === "straight"
      ? <line key={"e" + index} x1={x(edge.fromLane)} y1={middle} x2={x(edge.toLane)} y2={rowHeight} stroke={color(edge.toLane)}/>
      : <path key={"e" + index} d={`M ${x(edge.fromLane)} ${middle} C ${x(edge.fromLane)} ${middle + 8}, ${x(edge.toLane)} ${middle + 7}, ${x(edge.toLane)} ${rowHeight}`}
        stroke={color(edge.toLane)} fill="none"/>)}
    <circle cx={at} cy={middle} r={head ? 5 : 4} fill={head ? "var(--background)" : color(row.commitLane)} stroke={color(row.commitLane)} strokeWidth={head ? 2.5 : 1.5}/>
  </svg>;
}
