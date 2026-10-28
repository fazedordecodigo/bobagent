import { type RefObject, useEffect, useState } from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useLayerFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...(root.parentElement?.children ?? [])]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element !== root &&
          !element.classList.contains("side-scrim"),
      )
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of siblings) element.inert = true;
    const buttons = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length > 0);
    buttons()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || document.querySelector("dialog[open]")) return;
      const items = buttons();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && (index === items.length - 1 || index < 0)) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    root.addEventListener("keydown", trap);
    return () => {
      root.removeEventListener("keydown", trap);
      for (const { element, inert } of siblings) element.inert = inert;
      if (previous?.isConnected) previous.focus();
    };
  }, [active, ref]);
}
