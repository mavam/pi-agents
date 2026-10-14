import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Show a notice, if Pi has a UI for it. Work can outlive its session, and
 * Pi makes every use of a replaced session's context throw. A notice from
 * such work, often in a promise's error handler, would then turn into an
 * unhandled rejection that ends Pi; it goes nowhere instead.
 */
export function notify(
  ctx: ExtensionContext | undefined,
  text: string,
  type: "info" | "warning" | "error" = "warning",
): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(text, type);
  } catch {
    // The session was replaced, and its UI with it.
  }
}
