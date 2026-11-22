import { createPortal } from "react-dom";
import { useId, useState, useSyncExternalStore } from "react";
import { chooseParamsSchema, chooseProvider, type ChooseKind } from "../../../core/panels/choose.ts";
import { ChoosePanel } from "../../../ui/panels/ChoosePanel.tsx";
import { ContentPicker } from "../../../ui/chrome/index.ts";
import { Modal } from "../../../ui/chrome/primitives.tsx";
import type { ContentSource } from "./content-sources.ts";
import type { WorkspaceSession } from "./workspace-session.ts";

function Choice({ session, instanceId, kind }: { session: WorkspaceSession; instanceId: string; kind: ChooseKind }) {
  const [open, setOpen] = useState(false);
  const heading = useId();
  useSyncExternalStore(session.subscribe, session.getVersion);
  return <>
    <ChoosePanel kind={kind} onChoose={() => setOpen(true)} />
    {open && createPortal(<Modal labelledBy={heading} onDismiss={() => setOpen(false)} className="h-[min(32rem,100%)] max-w-lg">
      <ContentPicker target="empty-tile" headingId={heading}
        sections={session.contentSections().filter(section => kind === "any" ? session.pickerOffersEmbeds(instanceId) || session.sourceOf(section.providerId)?.embed === undefined : section.providerId === kind)} tileCount={0} tileLimit={1}
        onFocusExisting={id => { session.focusPanel(id); setOpen(false); }}
        onOpen={choice => { session.replaceChoice(instanceId, choice); setOpen(false); }} />
    </Modal>, document.body)}
  </>;
}

export function chooseSource(session: () => WorkspaceSession): ContentSource {
  return {
    provider: chooseProvider, sectionTitle: "Выбор содержимого", neutralLabel: "Выбор содержимого",
    canEndSession: false, offered: () => false, section: () => ({ state: "ready", items: [] }),
    refOf: () => null, stableRefOf: () => null, label: ref => ({ title: session().sourceOf(String(ref.params.kind))?.sectionTitle ?? "Выбор содержимого" }),
    stateText: () => null, subscribe: () => () => {},
    render: (ref, instanceId) => <Choice session={session()} instanceId={instanceId} kind={chooseParamsSchema.parse(ref.params).kind} />,
  };
}
