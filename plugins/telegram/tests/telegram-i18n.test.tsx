// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { TelegramPage } from "../src/ui/telegram-page.tsx";
import { TelegramStartup } from "../src/ui/telegram-startup.tsx";
import { makeTelegramTranslator, resolveTelegramLanguage, TelegramLocaleProvider, useTelegramLocale } from "../src/ui/i18n/index.tsx";
import { displayMessageText } from "../src/ui/i18n/message-labels.ts";
import russian from "../src/ui/i18n/ru.json";

afterEach(cleanup);

test("announces localized startup progress until the connection action is available", () => {
  const startup = (checking: boolean) => <TelegramLocaleProvider preference="ru">
    <TelegramStartup status={checking ? "Checking Telegram connection…" : undefined}>
      {!checking && <button type="button">Подключить Telegram</button>}
    </TelegramStartup>
  </TelegramLocaleProvider>;
  const view = render(startup(true));
  expect(screen.getByRole("status").textContent).toBe("Проверяем подключение…");
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(startup(false));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Подключить Telegram" })).toBeTruthy();
});

test("follows the first supported system language and honors an explicit override", () => {
  expect(resolveTelegramLanguage("auto", ["es-ES", "ru-RU", "en"])).toBe("ru");
  expect(resolveTelegramLanguage("auto", ["en-GB", "ru"])).toBe("en");
  expect(resolveTelegramLanguage("auto", ["es-ES"], "en")).toBe("en");
  expect(resolveTelegramLanguage("auto", ["en-GB"], "ru-RU")).toBe("ru");
  expect(resolveTelegramLanguage("en", ["ru-RU"], "ru")).toBe("en");
  expect(resolveTelegramLanguage("ru", ["en-GB"])).toBe("ru");
});

test("updates automatic mode when the BB shell language changes", async () => {
  function Sample() {
    const { locale, t } = useTelegramLocale();
    return <p lang={locale}>{t("Chat details")}</p>;
  }
  const root = document.documentElement;
  const previous = root.getAttribute("lang");
  try {
    root.lang = "en";
    const view = render(<TelegramLocaleProvider preference="auto"><Sample /></TelegramLocaleProvider>);
    expect(screen.getByText("Chat details")).toHaveProperty("lang", "en");
    root.lang = "ru";
    expect(await screen.findByText("Детали чата")).toHaveProperty("lang", "ru");
    view.rerender(<TelegramLocaleProvider preference="en"><Sample /></TelegramLocaleProvider>);
    expect(screen.getByText("Chat details")).toHaveProperty("lang", "en");
  } finally {
    if (previous === null) root.removeAttribute("lang");
    else root.setAttribute("lang", previous);
  }
});

test("switches interface language without losing the open chat, draft or message text", async () => {
  const chat = { id: "42", name: "Translations fixture", initials: "TF", color: "#246dbd", subtitle: "Direct message", messages: [] };
  const live = {
    chats: [chat], folders: [], list: "main" as const, selectList: () => {}, refresh: () => {}, loading: false, error: "", liveRevision: 0,
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
    loadHistory: async () => ({ before: null, messages: [{ id: "25", author: "Fixture", text: "Close", time: "10:00" }] }),
  };
  const view = render(<TelegramLocaleProvider preference="en"><TelegramPage live={live} /></TelegramLocaleProvider>);
  fireEvent.click(screen.getByRole("button", { name: /Translations fixture/ }));
  const draft = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Write a message" });
  fireEvent.change(draft, { target: { value: "Save" } });
  await screen.findByText("Close", { exact: true });
  view.rerender(<TelegramLocaleProvider preference="ru"><TelegramPage live={live} /></TelegramLocaleProvider>);
  expect(screen.getByRole("heading", { name: chat.name })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Написать сообщение" })).toBe(draft);
  expect(draft.value).toBe("Save");
  await waitFor(() => expect(screen.getByText("Close", { exact: true })).toBeTruthy());
});

test("translates generated labels while preserving Telegram text and template values", () => {
  const t = makeTelegramTranslator("ru");
  const message = { id: "50", author: "Fixture", text: "Photo", time: "10:00" };
  expect(displayMessageText(message, t)).toBe("Photo");
  expect(displayMessageText({ ...message, textIsLabel: true }, t)).toBe("Фото");
  expect(displayMessageText({ ...message, service: true, text: "Chat renamed to “Archive”" }, t)).toBe("Чат переименован в «Archive»");
  expect(t("Forward {0} messages", [4])).toBe("Переслать сообщения (4)");
  expect(makeTelegramTranslator("en")("Forward {0} messages", [4])).toBe("Forward 4 messages");
});

test("retains every interpolation field in the Russian catalogue", () => {
  const placeholders = (value: string) => Array.from(value.matchAll(/\{\d+\}/g), ([placeholder]) => placeholder).sort().join(" ");
  expect(Object.entries(russian).filter(([source, translated]) => !translated.trim()
    || placeholders(source) !== placeholders(translated))).toEqual([]);
});

test("covers literal UI translation keys in the client source", () => {
  const directory = resolve("src/ui");
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tsx"))
    .map((name) => join(directory, name));
  files.push(resolve("app.tsx"));
  const missing = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "tr") {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) {
          const key = argument.text.trim().replace(/\s+/g, " ");
          if (/[A-Za-z]{2}/.test(key) && !Object.hasOwn(russian, key)) missing.add(key);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  expect([...missing]).toEqual([]);
});
