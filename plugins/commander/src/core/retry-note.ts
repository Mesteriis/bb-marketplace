/**
 * The error text the runner records on an item it skipped because a directory above it
 * was not done. Retry selects skipped items by this exact text.
 * Do not change: it is written into existing jobs, and changing it makes them unretryable.
 */
export const parentSkipNote = "Skipped: a directory above this item is not done";
