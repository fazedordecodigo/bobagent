import { expect } from "bun:test";
import type { Locator } from "playwright-core";

export async function expectSwitchGeometry(control: Locator, knobSelector?: string) {
  const geometry = await control.evaluate(async (element, selector) => {
    getComputedStyle(element, "::before").top;
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
    const box = (style: CSSStyleDeclaration) => {
      const transform = new DOMMatrix(style.transform === "none" ? undefined : style.transform);
      const x = Number.parseFloat(style.left) + transform.m41;
      const y = Number.parseFloat(style.top) + transform.m42;
      return {
        x,
        y,
        right: x + Number.parseFloat(style.width),
        bottom: y + Number.parseFloat(style.height),
      };
    };
    const knob = selector ? element.querySelector(selector) : null;
    const rect = element.getBoundingClientRect();
    return {
      track: box(getComputedStyle(element, "::before")),
      knob: box(knob ? getComputedStyle(knob) : getComputedStyle(element, "::after")),
      width: rect.width,
      height: rect.height,
    };
  }, knobSelector);
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.track.x).toBeGreaterThanOrEqual(0);
  expect(geometry.track.y).toBeGreaterThanOrEqual(0);
  expect(geometry.track.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.track.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.knob.x).toBeGreaterThanOrEqual(geometry.track.x);
  expect(geometry.knob.y).toBeGreaterThanOrEqual(geometry.track.y);
  expect(geometry.knob.right).toBeLessThanOrEqual(geometry.track.right);
  expect(geometry.knob.bottom).toBeLessThanOrEqual(geometry.track.bottom);
}
