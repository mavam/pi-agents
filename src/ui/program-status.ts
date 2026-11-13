import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

type StatusTerminal = Pick<Terminal, "setProgramStatus">;

/**
 * Combines native terminal status with child activity at the shared output.
 */
export class AgentProgramStatus {
  private terminal: StatusTerminal | undefined;
  private original: StatusTerminal["setProgramStatus"] | undefined;
  private wrapper: StatusTerminal["setProgramStatus"] | undefined;
  private parent: ProgramStatus = { app: "pi", state: "idle" };
  private active = false;
  private disposed = false;
  private lastReport: string | undefined;

  /**
   * Attach once to the TUI terminal, retaining Pi's native writer and state.
   */
  attach(terminal: StatusTerminal, initial: ProgramStatus): void {
    if (this.disposed || this.terminal === terminal) return;
    if (this.terminal) this.detach();
    this.terminal = terminal;
    this.original = terminal.setProgramStatus;
    this.parent = initial;
    this.lastReport = undefined;
    const original = this.original;
    const wrapper: StatusTerminal["setProgramStatus"] = (status) => {
      // A later extension may still wrap this function after our disposal.
      if (this.disposed || this.wrapper !== wrapper) {
        original.call(terminal, status);
        return;
      }
      this.parent = { ...status };
      this.publish();
    };
    this.wrapper = wrapper;
    terminal.setProgramStatus = wrapper;
    if (this.active) this.publish();
  }

  /**
   * Replace whether any child is working or waiting on its inputs.
   */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.publish();
  }

  private current(): ProgramStatus {
    // Preserve native questions, permissions, failures, and explicit clearing.
    if (
      !this.active ||
      (this.parent.state !== "idle" && this.parent.state !== "done")
    )
      return this.parent;
    return {
      app: this.parent.app,
      state: "working",
      message: "Agents working",
    };
  }

  private publish(): void {
    if (!this.terminal || !this.original) return;
    const status = this.current();
    const key = JSON.stringify(status);
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.original.call(this.terminal, status);
  }

  private detach(): void {
    const terminal = this.terminal;
    if (!terminal || !this.original) return;
    const wrapper = this.wrapper;
    this.wrapper = undefined;
    if (terminal.setProgramStatus === wrapper)
      terminal.setProgramStatus = this.original;
    // Restore even when Pi deduplicates its next unchanged native report.
    if (
      this.lastReport !== undefined &&
      this.lastReport !== JSON.stringify(this.parent)
    )
      terminal.setProgramStatus(this.parent);
    this.terminal = undefined;
    this.original = undefined;
    this.wrapper = undefined;
    this.lastReport = undefined;
  }

  /**
   * Restore native output and remove activity when the session ends/reloads.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.detach();
  }
}
