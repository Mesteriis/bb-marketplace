import { useMemo } from "react";
import katex from "katex";
import type { RichFormulaRange } from "../core/contract.ts";

export function inlineFormulaReplacements(text: string, formulas?: readonly RichFormulaRange[]) {
  return formulas?.map(({ offset, length }) => ({
    offset, length, content: <MathFormula expression={text.slice(offset, offset + length)} />,
  }));
}

export function MathFormula({ expression, displayMode = false }: { expression: string; displayMode?: boolean }) {
  const math = useMemo(() => {
    try {
      return katex.renderToString(expression, {
        displayMode, output: "mathml", trust: false, strict: "ignore", maxExpand: 200, maxSize: 20,
      });
    } catch {
      return undefined;
    }
  }, [displayMode, expression]);
  return math ? <span dangerouslySetInnerHTML={{ __html: math }} /> : <code>{expression}</code>;
}
