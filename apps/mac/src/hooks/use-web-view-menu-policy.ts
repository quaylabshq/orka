import { useEffect } from "react";

// `HTMLInputElement.type` reports "text" for a missing or unknown type.
const textInputTypes = new Set([
  "text",
  "search",
  "email",
  "url",
  "password",
  "number",
  "tel",
]);

/** Whether a right-click on this target should keep the WebView's own menu. */
export function hasNativeTextMenu(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const input = target.closest("input");
  if (
    (input && textInputTypes.has(input.type)) ||
    target.closest(
      'textarea, [contenteditable]:not([contenteditable="false"]), a[href], [data-native-context-menu]',
    )
  )
    return true;
  const selection = window.getSelection();
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    (target.contains(selection.anchorNode) ||
      selection.containsNode(target, true)),
  );
}

/**
 * Hides the WebView menu (Reload and friends) unless an item menu already
 * handled the event or the target is text the user can edit, select or follow.
 */
export function useWebViewMenuPolicy() {
  useEffect(() => {
    const menu = (event: MouseEvent) => {
      if (!event.defaultPrevented && !hasNativeTextMenu(event.target))
        event.preventDefault();
    };
    document.addEventListener("contextmenu", menu);
    return () => document.removeEventListener("contextmenu", menu);
  }, []);
}
