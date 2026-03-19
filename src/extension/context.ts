import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function getCurrentModelId(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function getSessionFile(
  ctx: ExtensionContext | undefined,
): string | undefined {
  if (!ctx) return undefined;
  return typeof ctx.sessionManager?.getSessionFile === "function"
    ? ctx.sessionManager.getSessionFile()
    : undefined;
}

export function isIdle(ctx: ExtensionContext | undefined): boolean {
  return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
}
