/**
 * Expandable cards: one place for a card that a click expands or collapses,
 * as Pi's tool results do, while a global setting (Ctrl+O) sets every card.
 * Pi's transcript and the attach view wrap their own cards with it, and a
 * transcript `Container` routes clicks to whichever card is under the
 * pointer, so a card type needs no click handling of its own. Tool calls
 * use Pi's `ToolExecutionComponent`, which brings the same behavior.
 */

import {
  type Component,
  Container,
  MouseRegion,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** A card's expansion: its own, and the global setting it last followed. */
export interface Expansion {
  expanded: boolean;
  global: boolean;
}

export function expansion(global: boolean): Expansion {
  return { expanded: global, global };
}

/**
 * A card built for its expansion. A left click toggles the card, unless a
 * component inside handles the click first, such as a link. A change of
 * `global` sets the card again. Pass `state` to keep a click's toggle when
 * the card is rebuilt, for example after a theme change.
 */
export function expandableCard(
  build: (expanded: boolean) => Component | undefined,
  global: () => boolean,
  state: Expansion = expansion(global()),
): Component {
  return new ExpandableCard(build, global, state);
}

class ExpandableCard implements Component {
  private readonly card = new Container();
  private readonly region: MouseRegion;
  private built: boolean | undefined;

  constructor(
    private readonly build: (expanded: boolean) => Component | undefined,
    private readonly global: () => boolean,
    private readonly state: Expansion,
  ) {
    this.region = new MouseRegion(this.card, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      this.state.expanded = !this.state.expanded;
      this.sync();
      return { handled: true, render: true };
    });
    this.sync();
  }

  private sync(): void {
    const global = this.global();
    if (global !== this.state.global) {
      this.state.global = global;
      this.state.expanded = global;
    }
    if (this.built === this.state.expanded) return;
    this.built = this.state.expanded;
    this.card.clear();
    const content = this.build(this.state.expanded);
    if (content) this.card.addChild(content);
  }

  render(width: number): string[] {
    this.sync();
    return this.region.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.region.handleMouse(event);
  }

  invalidate(): void {
    this.region.invalidate();
  }
}
