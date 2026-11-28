// A component stand for the window and the composer button, outside BB:
// the real components, the host's theme tokens, canned states.
//
//   ?theme=dark|light|mock   the host's themes, or the palette the mockup was drawn in
//   ?view=mock|states        the mockup's three sections, or every state
import { ArrowUp } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { GuardView } from "../src/core/service.ts";
import type { Minutes, Scope } from "../src/core/state.ts";
import { GuardButton } from "../src/ui/guard-button.tsx";
import { GuardPopup } from "../src/ui/guard-popup.tsx";

const NOW = 1000;
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const which = params.get("view") ?? "mock";

/** The palette of the mockup (base.css), mapped onto the host's tokens. Stand only. */
const MOCK_PALETTE: Record<string, string> = {
  "--canvas": "#1b1b28",
  "--background": "#1b1b28",
  "--popover": "#20202d",
  "--card": "#20202d",
  "--accent": "#272736",
  "--accent-foreground": "#dfe1ee",
  "--border": "#34344a",
  "--foreground": "#dfe1ee",
  "--ink": "#dfe1ee",
  "--muted-foreground": "#9a9db3",
  "--primary": "#8fb4ff",
  "--ring": "#8fb4ff",
  "--warning": "#f0b862",
  "--warning-text": "#f0b862",
  "--destructive": "#ff8b8b",
};

document.documentElement.classList.add(theme === "light" ? "light" : "dark");
if (theme === "mock") {
  for (const [name, value] of Object.entries(MOCK_PALETTE)) document.documentElement.style.setProperty(name, value);
}

const closed: GuardView = { configured: true, local: true, effective: null };
const open = (scope: Scope, minutes: number): GuardView => ({
  configured: true,
  local: true,
  effective: { scope, until: NOW + minutes * 60, rootThreadId: scope === "global" ? null : "thr_stand" },
});

const page: CSSProperties = {
  minHeight: "100vh",
  padding: "28px 32px 36px",
  background: "var(--canvas)",
  color: "var(--foreground)",
  fontFamily: "var(--font-sans, system-ui)",
  boxSizing: "border-box",
};
const heading: CSSProperties = {
  margin: "0 0 10px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
};

function Section({ title, id, first, children }: { title: string; id: string; first?: boolean; children: ReactNode }) {
  return (
    <section data-stand={id} style={{ marginTop: first ? 0 : 28 }}>
      <h2 style={heading}>{title}</h2>
      {children}
    </section>
  );
}

/** What the host draws around a popup. `fit` is the mockup's window; without it the host stretches. */
function HostPopup({ fit, children }: { fit?: boolean; children: ReactNode }) {
  return (
    <div
      data-stand-popup=""
      style={{
        width: fit ? "fit-content" : "100%",
        maxWidth: "100%",
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 10,
      }}
    >
      {children}
    </div>
  );
}

function Composer({ view }: { view: GuardView | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: 620,
        maxWidth: "100%",
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: "8px 8px 8px 16px",
        color: "var(--muted-foreground)",
        boxSizing: "border-box",
      }}
    >
      <span>Напишите сообщение…</span>
      <span style={{ flex: 1 }} />
      <GuardButton view={view} now={NOW} onOpen={() => {}} />
      {/* The host's own send button, for context only. */}
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: "var(--primary)",
          color: "var(--canvas)",
        }}
      >
        <ArrowUp size={16} />
      </span>
    </div>
  );
}

/** A live window: terms open, «Закрыть» closes, as the plugin's server would answer. */
function Live({ initial, fit }: { initial: GuardView; fit?: boolean }) {
  const [view, setView] = useState(initial);
  return (
    <HostPopup fit={fit}>
      <GuardPopup
        view={view}
        now={NOW}
        busy={false}
        error={null}
        onOpen={(scope: Scope, minutes: Minutes) => setView(open(scope, minutes))}
        onClose={() => setView(closed)}
      />
    </HostPopup>
  );
}

function Still(props: { view: GuardView | null; busy?: boolean; error?: string | null }) {
  return (
    <HostPopup>
      <GuardPopup
        view={props.view}
        now={NOW}
        busy={props.busy ?? false}
        error={props.error ?? null}
        onOpen={() => {}}
        onClose={() => {}}
      />
    </HostPopup>
  );
}

function Mock() {
  return (
    <>
      <Section title="Кнопка у поля ввода" id="composer" first>
        <Composer view={open("thread", 24)} />
      </Section>
      <Section title="Закрыто" id="closed">
        <Live initial={closed} fit />
      </Section>
      <Section title="Открыто" id="open">
        <Live initial={open("thread", 24)} fit />
      </Section>
    </>
  );
}

function States() {
  return (
    <>
      <Section title="Кнопка: закрыто" id="button-closed" first>
        <Composer view={closed} />
      </Section>
      <Section title="Кнопка: охрана не найдена" id="button-disabled">
        <Composer view={{ configured: false, local: true, effective: null }} />
      </Section>
      <Section title="Хост растянул окно: закрыто" id="stretched-closed">
        <Live initial={closed} />
      </Section>
      <Section title="Хост растянул окно: открыто с субтредами" id="stretched-open">
        <Live initial={open("tree", 60)} />
      </Section>
      <Section title="Занято" id="busy">
        <Still view={open("global", 8)} busy />
      </Section>
      <Section title="Отказ сервера" id="refusal">
        <Still view={closed} error="Файл отметки занят другой записью, повторите" />
      </Section>
      <Section title="Загрузка" id="loading">
        <Still view={null} />
      </Section>
      <Section title="Состояние неизвестно" id="unknown">
        <Still view={null} error="Состояние охраны неизвестно: сервер не ответил" />
      </Section>
      <Section title="Охрана не найдена" id="not-found">
        <Still view={{ configured: false, local: true, effective: null }} />
      </Section>
      <Section title="Тред не на этой машине" id="not-local">
        <Still view={{ configured: true, local: false, effective: null }} />
      </Section>
    </>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <div data-bb-plugin="makosh-secrets-guard" data-bb-plugin-root="" style={page}>
      {which === "states" ? <States /> : <Mock />}
    </div>,
  );
}
