// Standalone demo entry: mounts the REAL src/ui against a synthetic API built
// on the real core. Open via the instructions in README.md (no BB install).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { buildDemoApi } from "./synthetic-api";
import { TaskboardPage } from "../src/ui/taskboard-page";

const notify = (kind: "error" | "success" | "info", message: string) => console.log("[" + kind + "]", message);

async function main() {
  const api = await buildDemoApi();
  const container = document.getElementById("root");
  if (container === null) return;
  createRoot(container).render(
    <StrictMode>
      <div data-bb-plugin-root>
        <TaskboardPage api={api} notify={notify} />
      </div>
    </StrictMode>,
  );
}

void main();
