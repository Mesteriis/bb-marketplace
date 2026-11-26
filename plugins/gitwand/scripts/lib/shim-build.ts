// The shim ships as a string of plain JavaScript (src/adapters/bb/shim-source.generated.ts),
// so the plugin bundler cannot rename or hoist anything inside it.
import ts from "typescript";

export function transpileShim(source: string): string {
  if (/^\s*import\s/m.test(source)) throw new Error("the shim must not import anything: it is shipped as a standalone string");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
  });
  return outputText.replace(/^export \{\};\n?/m, "").replace(/^export function /m, "function ");
}
