import { documentDeliveryTimeoutMs, schemas, type SendResult } from "../../core/contract.ts";

export async function waitForDocumentDelivery(url: string): Promise<SendResult> {
  const deadline = Date.now() + documentDeliveryTimeoutMs + 45_000;
  let failures = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const state: unknown = await response.json();
        const result = schemas.sendDocument.output.safeParse(state);
        if (result.success) return result.data;
        if (!state || typeof state !== "object" || !("state" in state) || state.state !== "pending") break;
        failures = 0;
      } else {
        if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
        failures++;
      }
    } catch {
      failures++;
    }
    if (failures >= 5) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  return { state: "unknown" };
}
