// Read receipts (slice 3i, #72). Mail never sends a Message Disposition
// Notification and never asks for one; this file only notices that a
// message asked, so the reading pane can say so. A source-scan test keeps
// these header names out of every other file.

/** The headers that ask for a read receipt. */
export const RECEIPT_HEADERS: readonly string[] = ["Disposition-Notification-To", "Return-Receipt-To", "X-Confirm-Reading-To"];

const NAMES = new Set(RECEIPT_HEADERS.map((name) => name.toLowerCase()));

/** Whether any of the message's header lines asks for a read receipt. */
export function receiptRequested(headers: readonly { key: string; value?: string }[]): boolean {
  return headers.some((line) => NAMES.has(line.key.toLowerCase()));
}
