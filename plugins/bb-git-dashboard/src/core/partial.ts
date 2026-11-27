const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";

/**
 * A part of a page read on its own: when it fails the page still opens with `fallback`, and the notice says
 * what is missing and why. The page's own record is read without this, so its failure still fails the page.
 */
export async function partial<T>(read: Promise<T>, fallback: T, missing: (code: string) => string): Promise<{value: T; notice: string | null}> {
  try { return {value: await read, notice: null}; }
  catch (error) { return {value: fallback, notice: missing(codeOf(error))}; }
}
