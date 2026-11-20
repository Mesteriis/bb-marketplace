import type { RichStyledRange } from "./contract.ts";
import { maskSpoilers } from "./message-spoilers.ts";

type TextCell = {
  text: string;
  styles?: readonly RichStyledRange[];
  colSpan?: number;
  rowSpan?: number;
  invisible?: boolean;
};

export function tabSeparatedTableText(rows: readonly (readonly TextCell[])[]) {
  const grid: (string | undefined)[][] = rows.map(() => []);
  let width = 0;
  for (const [rowIndex, cells] of rows.entries()) {
    const row = grid[rowIndex]!;
    let column = 0;
    for (const cell of cells) {
      while (row[column] !== undefined) column++;
      const end = column + (cell.colSpan ?? 1);
      for (const coveredRow of grid.slice(rowIndex, rowIndex + (cell.rowSpan ?? 1))) {
        for (let index = column; index < end; index++) coveredRow[index] ??= "";
      }
      if (!cell.invisible) row[column] = maskSpoilers(cell.text, cell.styles).replace(/[\t\r\n]+/g, " ");
      width = Math.max(width, end);
      column = end;
    }
  }
  return grid.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? "").join("\t")).join("\n");
}
