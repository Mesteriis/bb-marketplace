// Finding the composer the lock sits in. The host hands a composer action no
// element of the composer, so the root is found by shape: the closest ancestor
// of the button that also holds the message editor.

const EDITOR = 'textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * The composer's outermost element, or null when the button is not inside
 * one. The page itself never counts: an editor somewhere else on the page
 * does not make the whole page a composer.
 */
export function findComposerRoot(button: HTMLElement | null): HTMLElement | null {
  if (button === null) return null;
  const page = button.ownerDocument;
  for (let node = button.parentElement; node !== null; node = node.parentElement) {
    if (node === page.body || node === page.documentElement) return null;
    if (node.querySelector(EDITOR) !== null) return node;
  }
  return null;
}
