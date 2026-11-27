// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginAccessPanel, sinceText, type PluginAccessApi, type PluginAccessView } from "./plugin-access-panel.tsx";
import { PluginRequestBanner, type PluginRequestBannerApi } from "./plugin-request-banner.tsx";

afterEach(cleanup);
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-27T12:00:00Z");
const names = new Map([[P1, "Сборочный сервер"], [P2, "Архив"]]);
const view = (over: Partial<PluginAccessView> = {}): PluginAccessView => ({
  requests: [{ requestId: "r1", pluginId: "makosh-commander", profileId: P1, level: "write", reason: "скопировать сборку", requestedAt: "2026-11-27T11:55:00Z" }],
  grants: [{ pluginId: "makosh-commander", profileId: P2, level: "read", grantedAt: "2026-11-27T09:00:00Z" }],
  channels: [
    { channelId: "c1", pluginId: "makosh-commander", profileId: P2, openedAt: "2026-11-27T11:59:00Z" },
    { channelId: "c2", pluginId: "makosh-commander", profileId: P2, openedAt: "2026-11-27T11:59:30Z" },
  ],
  ...over,
});
function api(v: PluginAccessView): PluginAccessApi {
  return {
    list: vi.fn(async () => v),
    grant: vi.fn(async () => ({ granted: true })),
    decline: vi.fn(async () => ({ declined: true })),
    revoke: vi.fn(async () => ({ revoked: true, channelsClosed: 2 })),
    revokeAll: vi.fn(async () => ({ revoked: 1 })),
  };
}

describe("sinceText", () => {
  it("says how long ago in whole minutes, hours and days", () => {
    expect(sinceText("2026-11-27T11:59:40Z", NOW)).toBe("только что");
    expect(sinceText("2026-11-27T11:55:00Z", NOW)).toBe("5 мин назад");
    expect(sinceText("2026-11-27T09:00:00Z", NOW)).toBe("3 ч назад");
    expect(sinceText("2026-11-24T12:00:00Z", NOW)).toBe("3 дн назад");
    expect(sinceText(null, NOW)).toBe("");
    expect(sinceText("not a date", NOW)).toBe("");
  });
});

describe("PluginAccessPanel", () => {
  it("shows who asks for what and why, and the owner's answer is one call with the level chosen", async () => {
    const a = api(view());
    render(<PluginAccessPanel api={a} profileNames={names} onClose={() => {}} now={() => NOW} />);
    const request = await screen.findByTestId("plugin-request");
    expect(request.textContent).toContain("плагин «makosh-commander» просит доступ к «Сборочный сервер»: чтение и запись");
    expect(request.textContent).toContain("5 мин назад · причина, как её назвал плагин: скопировать сборку");
    fireEvent.click(within(request).getByRole("button", { name: "Разрешить чтение" }));
    await waitFor(() => expect(a.grant).toHaveBeenCalledWith("makosh-commander", P1, "read"));
    fireEvent.click(within(request).getByRole("button", { name: "Разрешить чтение и запись" }));
    await waitFor(() => expect(a.grant).toHaveBeenCalledWith("makosh-commander", P1, "write"));
    fireEvent.click(within(request).getByRole("button", { name: "Отклонить" }));
    await waitFor(() => expect(a.decline).toHaveBeenCalledWith("r1"));
  });

  it("a request for reading offers no way to give more than was asked", async () => {
    const v = view();
    v.requests[0]!.level = "read";
    render(<PluginAccessPanel api={api(v)} profileNames={names} onClose={() => {}} now={() => NOW} />);
    const request = await screen.findByTestId("plugin-request");
    expect(within(request).queryByRole("button", { name: "Разрешить чтение и запись" })).toBeNull();
  });

  it("shows each grant with its level and open channels; revoke says how many channels it closed", async () => {
    const a = api(view());
    render(<PluginAccessPanel api={a} profileNames={names} onClose={() => {}} now={() => NOW} />);
    const grant = await screen.findByTestId("plugin-grant");
    expect(grant.textContent).toContain("плагин «makosh-commander» → «Архив»");
    expect(grant.textContent).toContain("разрешено 3 ч назад · открыто каналов: 2");
    fireEvent.change(within(grant).getByRole("combobox"), { target: { value: "write" } });
    await waitFor(() => expect(a.grant).toHaveBeenCalledWith("makosh-commander", P2, "write"));
    fireEvent.click(within(grant).getByRole("button", { name: "Отозвать" }));
    await waitFor(() => expect(a.revoke).toHaveBeenCalledWith("makosh-commander", P2));
    expect((await screen.findByRole("status")).textContent).toBe("Доступ отозван, закрыто каналов: 2.");
  });

  it("revoking everything asks first", async () => {
    const a = api(view());
    render(<PluginAccessPanel api={a} profileNames={names} onClose={() => {}} now={() => NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Отозвать всё" }));
    expect(a.revokeAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Да, отозвать всё" }));
    await waitFor(() => expect(a.revokeAll).toHaveBeenCalledTimes(1));
  });

  it("says so when nothing is asked and nothing is allowed, reloads on a signal, and shows a failed load", async () => {
    const a = api(view({ requests: [], grants: [], channels: [] }));
    let signal: () => void = () => {};
    render(<PluginAccessPanel api={a} profileNames={names} onClose={() => {}} subscribe={(cb) => ((signal = cb), () => {})} />);
    expect(await screen.findByText("Ни один плагин сейчас ничего не просит.")).toBeTruthy();
    expect(screen.getByText("Ни одному плагину ничего не разрешено.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отозвать всё" })).toBeNull();
    signal();
    await waitFor(() => expect(a.list).toHaveBeenCalledTimes(2));
    cleanup();
    const broken = api(view());
    broken.list = vi.fn(async () => Promise.reject(new Error("boom")));
    render(<PluginAccessPanel api={broken} profileNames={names} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("PluginRequestBanner", () => {
  const bannerApi = (v: PluginAccessView): PluginRequestBannerApi => ({ ...api(v), names: vi.fn(async () => names), open: vi.fn(), subscribe: () => () => {} });

  it("is not there while nobody asks", async () => {
    const a = bannerApi(view({ requests: [] }));
    const { container } = render(<PluginRequestBanner api={a} />);
    await waitFor(() => expect(a.list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("names the plugin, the connection and the level, and answers from where the owner is", async () => {
    const a = bannerApi(view());
    render(<PluginRequestBanner api={a} />);
    const row = await screen.findByTestId("plugin-request-banner-row");
    expect(row.textContent).toContain("плагин «makosh-commander» просит доступ к файлам на «Сборочный сервер»: чтение и запись.");
    fireEvent.click(within(row).getByRole("button", { name: "Отклонить" }));
    await waitFor(() => expect(a.decline).toHaveBeenCalledWith("r1"));
    fireEvent.click(within(row).getByRole("button", { name: "Разрешить чтение" }));
    await waitFor(() => expect(a.grant).toHaveBeenCalledWith("makosh-commander", P1, "read"));
    fireEvent.click(within(row).getByRole("button", { name: "Все разрешения" }));
    expect(a.open).toHaveBeenCalledTimes(1);
  });
});
