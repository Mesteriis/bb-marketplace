import { experimental_FilePreview as FilePreview, Markdown } from "@get-bb/plugin-sdk/app";
import { FILE_PREVIEW_PROVIDER as provider, filePreviewParamsSchema as schema } from "../../../core/diff/refs.ts";
import { fileTarget } from "../../../core/panels/entry-card.ts";
import type { PanelRef } from "../../../core/panels/ref.ts";
import { Listeners, type ContentSource, type SourceSection } from "./content-sources.ts";

interface Environment {
  id: string;
  hostId: string;
  name: string | null;
  path: string | null;
  status: string;
  mergeBaseBranch?: string | null;
  defaultBranch?: string | null;
}
interface EnvironmentReader {
  list(input: { status: "ready"; limit: number; offset: number }): Promise<Environment[]>;
  get(input: { environmentId: string; signal?: AbortSignal }): Promise<Environment>;
  paths(input: { environmentId: string; includeFiles: "true"; includeDirectories: "false"; query: string; signal?: AbortSignal }): Promise<{
    paths: { kind: string; path: string }[];
  }>;
}

/** Shared workspace picker. A new environment or search invalidates all old item IDs. */
export class WorkspaceFileCatalog {
  private readonly changes = new Listeners();
  readonly subscribe = this.changes.subscribe;
  private generation = 0;
  private environment: Environment | null = null;
  private scope = "";
  readonly requestedEnvironment = () => this.scope;
  private section: SourceSection = { state: "ready", items: [] };
  constructor(private readonly environments: EnvironmentReader) {}

  async listEnvironments() {
    const ready: Environment[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = await this.environments.list({ status: "ready", limit, offset });
      ready.push(...page.filter(env => env.status === "ready" && env.path));
      if (page.length < limit) return ready;
    }
  }

  async select(environmentId: string, query = "") {
    const generation = ++this.generation;
    this.scope = environmentId;
    this.environment = null;
    this.section = { state: "loading", items: [] };
    this.changes.notify();
    try {
      const env = (await this.listEnvironments()).find(env => env.id === environmentId);
      if (!env) throw Error("Среда недоступна.");
      if (generation !== this.generation) return;
      const files = await this.files(environmentId, query);
      if (generation !== this.generation) return;
      this.environment = env;
      this.section = { state: "ready", items: files.map(file => ({
        id: JSON.stringify([env.id, file.path]), title: file.path, context: env.name ?? env.id,
      })) };
    } catch {
      if (generation !== this.generation) return;
      this.section = { state: "denied", items: [] };
    }
    this.changes.notify();
  }

  async files(environmentId: string, query: string, signal?: AbortSignal) {
    const { paths } = await this.environments.paths({ environmentId, query, signal, includeFiles: "true", includeDirectories: "false" });
    return paths.filter(file => file.kind === "file" && schema.safeParse({
      kind: "workspace", environmentId, path: encodeURIComponent(file.path),
    }).success);
  }

  getEnvironment(environmentId: string, signal?: AbortSignal) {
    return this.environments.get({ environmentId, signal });
  }

  get selected() { return this.environment?.id ?? null; }
  get comparisonBranch() { return this.environment?.mergeBaseBranch ?? this.environment?.defaultBranch ?? undefined; }
  get snapshot() { return this.section; }

  params(id: string) {
    const file = this.section.items.find(item => item.id === id);
    return this.environment && file ? { kind: "workspace" as const, environmentId: this.environment.id, path: encodeURIComponent(file.title) } : null;
  }
}

// A direct OS drop inside a frame never reaches the tile's drag handlers.
function readOnlyHtmlPreview(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'">`;
  const doc = new DOMParser().parseFromString(policy + content, "text/html");
  const roots: ParentNode[] = [doc];
  for (const root of roots) {
    root.querySelectorAll("input, textarea, select, button, fieldset").forEach(control => {
      control.setAttribute("disabled", "");
    });
    root.querySelectorAll("[contenteditable]").forEach(element => element.removeAttribute("contenteditable"));
    // Declarative shadow templates can become active when srcDoc is parsed.
    root.querySelectorAll("template").forEach(template => {
      if (template instanceof HTMLTemplateElement) roots.push(template.content);
    });
  }
  doc.documentElement.setAttribute("contenteditable", "false");
  return doc.documentElement.outerHTML;
}

export function createFilePreviewSource(catalog: WorkspaceFileCatalog): ContentSource {
  const title = "BB предпросмотр";
  const pending = new Map<string, AbortController>();
  const refOf = (id: string) => {
    const params = catalog.params(id);
    return params && { provider, params };
  };
  return {
    sectionTitle: title, neutralLabel: title, canEndSession: false, offered: () => true,
    section: () => catalog.snapshot, refOf, stableRefOf: refOf, subscribe: catalog.subscribe,
    provider: {
      type: provider, paramsSchema: schema, multipleViews: false,
      capabilities: { showNativeRoute: "yes", embedInstance: "yes", keepLiveInDocument: "unverified",
        rebindToSession: "no", transferBetweenWindows: "no", restoreAfterRestart: "partial" },
      async open({ instanceId, ref }) {
        if (ref.provider !== provider || !schema.safeParse(ref.params).success) return { status: "access-denied" };
        const target = fileTarget(ref.params);
        pending.get(instanceId)?.abort();
        const controller = new AbortController();
        pending.set(instanceId, controller);
        try {
          const files = await catalog.files(target.environmentId, target.path, controller.signal);
          if (controller.signal.aborted) return { status: "lost" };
          return files.some(f => f.path === target.path) ? { status: "live", addressee: null } : { status: "lost" };
        } catch {
          return { status: controller.signal.aborted ? "lost" : "access-denied" };
        } finally {
          if (pending.get(instanceId) === controller) pending.delete(instanceId);
        }
      },
      release(instanceId) { pending.get(instanceId)?.abort(); pending.delete(instanceId); }, endsSessionOnLastClose: () => false, endSession: async () => "unknown",
    },
    label(ref: PanelRef) {
      return ref.provider === provider && schema.safeParse(ref.params).success ? { title: fileTarget(ref.params).path, context: title } : null;
    },
    render(ref) {
      const target = fileTarget(ref.params);
      return <FilePreview target={target} renderPreview={({ content }) => {
        if (/\.html?$/i.test(target.path)) return <iframe title={target.path} sandbox="" referrerPolicy="no-referrer" className="h-full w-full" srcDoc={readOnlyHtmlPreview(content)} />;
        if (/\.(md|markdown)$/i.test(target.path)) return <Markdown content={content} />;
        return <pre className="h-full overflow-auto whitespace-pre">{content}</pre>;
      }} />;
    },
    stateText: state => state === "lost" || state === "access-denied"
      ? { title: "Файл недоступен", description: "BB не нашёл файл в выбранной среде или отказал в доступе. Ссылка сохранена." } : null,
  };
}
