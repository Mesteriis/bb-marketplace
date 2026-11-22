import { randomUUID } from "node:crypto";
import { DomainError } from "../../core/errors";
import type { ZoomMeeting } from "../../core/model";
import type { KeyValue } from "./token-store";

type MeetingOwner = { accountId(): Promise<string>; listUpcoming(): Promise<ZoomMeeting[]> };
type Binding = { owner: string; id: string };

export function createMeetingRefs(kv: KeyValue, api: MeetingOwner, revision: () => number) {
  let writes = Promise.resolve();
  const denied = () => new DomainError("not_found", "Встреча недоступна этому аккаунту");
  function check(epoch: number) {
    if (epoch !== revision()) throw denied();
  }
  async function meeting(id: string, epoch: number) {
    check(epoch);
    const result = (await api.listUpcoming()).find((m) => m.id === id);
    check(epoch);
    if (!result) throw denied();
    return result;
  }
  return {
    select(id: string) {
      const epoch = revision();
      const result = writes.then(async () => {
        const owner = await api.accountId();
        await meeting(id, epoch);
        const key = "embed.meeting." + JSON.stringify([owner, id]);
        const existing = await kv.get<string>(key);
        check(epoch);
        if (existing) return existing;
        const ref = randomUUID();
        await kv.set("embed.ref." + ref, { owner, id });
        await kv.set(key, ref);
        check(epoch);
        return ref;
      });
      writes = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    async resolve<T>(ref: string, use: (meeting: ZoomMeeting) => Promise<T>) {
      const epoch = revision();
      const binding = await kv.get<Binding>("embed.ref." + ref);
      if (!binding || binding.owner !== (await api.accountId())) throw denied();
      const target = await meeting(binding.id, epoch);
      const result = await use(target);
      check(epoch);
      return result;
    },
  };
}
