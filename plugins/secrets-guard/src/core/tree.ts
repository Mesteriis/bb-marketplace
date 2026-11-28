/** Every thread below `root`: without the root, without repeats, safe on a cycle. */
export async function collectDescendants(
  root: string,
  childrenOf: (id: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const seen = new Set<string>([root]);
  const found: string[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of await childrenOf(next)) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
