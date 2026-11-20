import { writeFile } from "node:fs/promises";

export const frameTimescale = 1_000_000;

// setts indexes packets in decode order. The edit encoder disables B-frames,
// so these indexes also address the verified presentation order.
function packetValues(values: readonly number[], first = 0, end = values.length): string {
  if (end - first === 1) return String(values[first]);
  const middle = first + Math.floor((end - first) / 2);
  return `if(lt(N,${middle}),${packetValues(values, first, middle)},${packetValues(values, middle, end)})`;
}

export async function writeHevcPacketClock(path: string, times: readonly number[], durations: readonly number[], filter?: string) {
  if (!times.length || times.length !== durations.length) throw new Error("Invalid HEVC packet clock.");
  const clock = `setts=time_base=1/${frameTimescale}:ts='${packetValues(times)}':duration='${packetValues(durations)}'`;
  await writeFile(path, filter ? `${filter},${clock}` : clock);
}
