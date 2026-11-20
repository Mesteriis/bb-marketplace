import { afterEach, expect, test, vi } from "vitest";
import { waitForDocumentDelivery } from "../src/adapters/bb/document-delivery-client.ts";

const url = "/api/v1/plugins/makosh-telegram/http/document-upload?ticket=fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("recovers a Telegram delivery result after a transient BB connection failure", async () => {
  vi.useFakeTimers();
  const sent = { state: "sent", message: { id: "1", author: "Fixture", time: "", text: "Fixture" } };
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ state: "pending" }))
    .mockRejectedValueOnce(new TypeError("Connection reset"))
    .mockResolvedValueOnce(new Response("Unavailable", { status: 502 }))
    .mockResolvedValueOnce(Response.json(sent));
  vi.stubGlobal("fetch", fetch);
  const result = waitForDocumentDelivery(url);
  await vi.advanceTimersByTimeAsync(6000);
  await expect(result).resolves.toEqual(sent);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.map(([request, options]) => [request, options.method]))
    .toEqual(Array.from({ length: 4 }, () => [url, undefined]));
});

test("stops polling if the upload ticket has expired", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  await expect(waitForDocumentDelivery(url)).resolves.toEqual({ state: "unknown" });
  expect(fetch).toHaveBeenCalledOnce();
});

test("stops polling after five consecutive temporary failures", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const result = waitForDocumentDelivery(url);
  await vi.advanceTimersByTimeAsync(8000);
  await expect(result).resolves.toEqual({ state: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(5);
});

test("continues watching delivery if cancellation loses the dispatch race", async () => {
  vi.useFakeTimers();
  const sent = { state: "sent", message: { id: "1", author: "Fixture", time: "", text: "Fixture" } };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ state: "pending", canCancel: true }))
    .mockResolvedValueOnce(Response.json(sent));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const request = vi.fn(async () => false);
  const progress = vi.fn(() => controller.abort());
  const result = waitForDocumentDelivery(url, progress, { signal: controller.signal, request });
  await vi.advanceTimersByTimeAsync(2000);
  await expect(result).resolves.toEqual(sent);
  expect(request).toHaveBeenCalledOnce();
  expect(progress).toHaveBeenCalledWith(undefined, true);
});
