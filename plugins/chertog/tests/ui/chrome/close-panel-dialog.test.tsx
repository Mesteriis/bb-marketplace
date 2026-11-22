// The confirmation shown before a close that would end a session: three
// outcomes that cannot be confused, Escape, the focus trap and its return.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClosePanelDialog, HiddenPanelsList, HeaderActions } from "../../../src/ui/chrome/index.ts";

function outcomes() {
  return { onHide: vi.fn<() => void>(), onCloseAndEnd: vi.fn<() => void>(), onCancel: vi.fn<() => void>() };
}

/** The tile's close button opens the dialog; any outcome dismisses it, as the workspace does. */
function Harness({ calls }: { calls: ReturnType<typeof outcomes> }) {
  const [open, setOpen] = useState(false);
  const done = (report: () => void) => () => {
    report();
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Закрыть панель
      </button>
      <ClosePanelDialog
        open={open}
        panelTitle="Zoom: Планёрка"
        onHide={done(calls.onHide)}
        onCloseAndEnd={done(calls.onCloseAndEnd)}
        onCancel={done(calls.onCancel)}
      />
    </>
  );
}

async function openDialog() {
  const user = userEvent.setup();
  const calls = outcomes();
  render(<Harness calls={calls} />);
  const source = screen.getByRole("button", { name: "Закрыть панель" });
  await user.click(source);
  return { user, calls, source };
}

describe("ClosePanelDialog", () => {
  it("renders nothing while closed", () => {
    render(<Harness calls={outcomes()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the panel, warns that the session ends and starts on «Скрыть панель»", async () => {
    await openDialog();

    const dialog = screen.getByRole("dialog", { name: "Закрыть «Zoom: Планёрка»?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(
      "Это последнее представление панели: если закрыть её, сессия завершится. Скрытая панель продолжит работать, её можно вернуть из списка скрытых панелей.",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Скрыть панель" }));
  });

  it("Enter on the default choice hides the panel and ends nothing", async () => {
    const { user, calls, source } = await openDialog();

    await user.keyboard("{Enter}");

    expect(calls.onHide).toHaveBeenCalledTimes(1);
    expect(calls.onCloseAndEnd).not.toHaveBeenCalled();
    expect(calls.onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(source);
  });

  it("«Закрыть и завершить» is the only choice that ends the session", async () => {
    const { user, calls, source } = await openDialog();

    await user.click(screen.getByRole("button", { name: "Закрыть и завершить" }));

    expect(calls.onCloseAndEnd).toHaveBeenCalledTimes(1);
    expect(calls.onHide).not.toHaveBeenCalled();
    expect(calls.onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(source);
  });

  it("«Отмена» only cancels", async () => {
    const { user, calls, source } = await openDialog();

    await user.click(screen.getByRole("button", { name: "Отмена" }));

    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.onHide).not.toHaveBeenCalled();
    expect(calls.onCloseAndEnd).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(source);
  });

  it("Escape cancels, wherever the focus is inside the dialog", async () => {
    const { user, calls, source } = await openDialog();

    await user.tab();
    await user.keyboard("{Escape}");

    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.onHide).not.toHaveBeenCalled();
    expect(calls.onCloseAndEnd).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(source);
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const { user, calls } = await openDialog();
    const hide = screen.getByRole("button", { name: "Скрыть панель" });
    const end = screen.getByRole("button", { name: "Закрыть и завершить" });
    const cancel = screen.getByRole("button", { name: "Отмена" });

    expect(document.activeElement).toBe(hide);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(end);
    await user.tab();
    expect(document.activeElement).toBe(hide);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(end);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(hide);

    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it("marks the ending choice as the dangerous one", async () => {
    await openDialog();

    expect(screen.getByRole("button", { name: "Закрыть и завершить" }).getAttribute("data-variant")).toBe("danger");
    expect(screen.getByRole("button", { name: "Скрыть панель" }).getAttribute("data-variant")).toBe("primary");
    expect(screen.getByRole("button", { name: "Отмена" }).getAttribute("data-variant")).toBe("neutral");
  });

  it("leaves the focus where an outcome put it", async () => {
    const user = userEvent.setup();
    function Moving() {
      const [open, setOpen] = useState(false);
      const close = () => setOpen(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Закрыть панель
          </button>
          <input aria-label="Соседний тайл" />
          <ClosePanelDialog
            open={open}
            panelTitle="Zoom: Планёрка"
            onHide={() => {
              screen.getByRole("textbox", { name: "Соседний тайл" }).focus();
              close();
            }}
            onCloseAndEnd={close}
            onCancel={close}
          />
        </>
      );
    }
    render(<Moving />);

    await user.click(screen.getByRole("button", { name: "Закрыть панель" }));
    await user.click(screen.getByRole("button", { name: "Скрыть панель" }));

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Соседний тайл" }));
  });
});

describe("ClosePanelDialog opened from a control that goes away", () => {
  const PANELS = [
    { instanceId: "p1", title: "Zoom: Планёрка" },
    { instanceId: "p2", title: "SSH: build-01" },
  ];

  /** The workspace's wiring: «Закрыть» in the hidden list asks first, and only «Закрыть и завершить» removes the panel. */
  function FromHiddenList({ inToolbar }: { inToolbar: boolean }) {
    const [panels, setPanels] = useState(PANELS);
    const [closing, setClosing] = useState<string | null>(null);
    const hidden = { panels, onShow: () => {}, onClose: setClosing };
    const unused = () => {
      throw new Error("This callback is not part of the test");
    };
    return (
      <>
        {inToolbar ? (
          <HeaderActions
            layouts={{
              layouts: [{ id: "l1", name: "Разработка" }],
              activeLayoutId: "l1",
              presets: [],
              saveStatus: "saved",
              onSwitch: unused,
              onCreateFromCurrent: unused,
              onCreateFromPreset: unused,
              onRename: unused,
              onDuplicate: unused,
              onDelete: unused,
              onRetrySave: unused,
              onReload: unused,
            }}
            content={{ sections: [], tileCount: 1, tileLimit: 8, onOpen: unused, onFocusExisting: unused }}
            hiddenPanels={hidden}
            onNewThread={unused}
          />
        ) : (
          <HiddenPanelsList {...hidden} />
        )}
        <ClosePanelDialog
          open={closing !== null}
          panelTitle={panels.find((panel) => panel.instanceId === closing)?.title ?? ""}
          onHide={() => setClosing(null)}
          onCloseAndEnd={() => {
            setPanels(panels.filter((panel) => panel.instanceId !== closing));
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      </>
    );
  }

  async function ask(inToolbar: boolean) {
    const user = userEvent.setup();
    render(<FromHiddenList inToolbar={inToolbar} />);
    await user.click(screen.getByRole("button", { name: "Скрытые панели: 2" }));
    await user.click(screen.getByRole("button", { name: "Закрыть «Zoom: Планёрка»" }));
    expect(screen.getByRole("dialog", { name: "Закрыть «Zoom: Планёрка»?" })).toBeTruthy();
    // The dialog took the focus, so the list folded and its «Закрыть» button is gone.
    expect(screen.queryByRole("button", { name: "Закрыть «Zoom: Планёрка»" })).toBeNull();
    return user;
  }

  const cases = [false, true].flatMap((inToolbar) =>
    (
      [
        ["Escape", "{Escape}", null, 2],
        ["«Отмена»", null, "Отмена", 2],
        ["«Скрыть панель»", null, "Скрыть панель", 2],
        ["«Закрыть и завершить»", null, "Закрыть и завершить", 1],
      ] as const
    ).map(([name, key, button, left]) => [inToolbar ? "the toolbar" : "the list alone", name, inToolbar, key, button, left] as const),
  );

  it.each(cases)("in %s, after %s the focus returns to «Скрытые панели», not to the page", async (_where, _name, inToolbar, key, button, left) => {
    const user = await ask(inToolbar);

    if (key !== null) await user.keyboard(key);
    else await user.click(screen.getByRole("button", { name: button as string }));

    expect(screen.queryByRole("dialog", { name: "Закрыть «Zoom: Планёрка»?" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Скрытые панели: ${left}` }));
    expect(document.activeElement).not.toBe(document.body);
  });
});

