import { expect, it, vi } from "vitest";
import { createMeetingRefs } from "./meeting-refs";
import type { KeyValue } from "./token-store";
import type { ZoomMeeting } from "../../core/model";

const meeting = {
  id: "1111111111",
  topic: "Meeting",
  startTime: null,
  durationMinutes: 30,
  joinUrl: "https://zoom.us/j/1111111111?pwd=secret",
  passcode: "secret",
} satisfies ZoomMeeting;
it("restores the same opaque UUID only for the account that selected an accessible meeting", async () => {
  const data = new Map<string, unknown>();
  const kv: KeyValue = {
    get: async <T>(key: string) => data.get(key) as T,
    set: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => {
      data.delete(k);
    },
  };
  const api = { accountId: vi.fn(async () => "user-a"), listUpcoming: vi.fn(async () => [meeting]) };
  let revision = 0;
  const refs = createMeetingRefs(kv, api, () => revision);
  const [ref, duplicate] = await Promise.all([refs.select(meeting.id), refs.select(meeting.id)]);
  expect(ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(duplicate).toBe(ref);
  expect(JSON.stringify([...data])).not.toContain("secret");
  const restored = createMeetingRefs(kv, api, () => revision);
  expect(await restored.resolve(ref, async (m) => m.topic)).toBe("Meeting");
  api.accountId.mockResolvedValue("user-b");
  api.listUpcoming.mockClear();
  const prepare = vi.fn(async () => "signature");
  await expect(restored.resolve(ref, prepare)).rejects.toThrow("недоступна");
  expect(api.listUpcoming).not.toHaveBeenCalled();
  api.accountId.mockResolvedValue("user-a");
  api.listUpcoming.mockResolvedValueOnce([]);
  await expect(restored.resolve(ref, prepare)).rejects.toThrow("недоступна");
  expect(prepare).not.toHaveBeenCalled();
  await expect(
    restored.resolve(ref, async () => {
      revision++;
      return "signature";
    }),
  ).rejects.toThrow("недоступна");
});
