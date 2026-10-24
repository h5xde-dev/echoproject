export type ActionName =
  | 'fire'
  | 'reload'
  | 'interact'
  | 'flashlight'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'slot7'
  | 'slot8'
  | 'nade'
  | 'mark'
  | 'grenade'
  | 'buy';

const ACTION_KEYS: Record<string, ActionName> = {
  KeyR: 'reload',
  KeyE: 'interact',
  KeyF: 'flashlight',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Digit4: 'slot4',
  Digit5: 'slot5',
  Digit6: 'slot6',
  Digit7: 'slot7',
  Digit8: 'slot8',
  KeyQ: 'nade',
  // Team marker; the middle mouse button does the same.
  KeyZ: 'mark',
  KeyG: 'grenade',
  KeyB: 'buy',
};

export class Input {
  readonly keys = new Set<string>();
  readonly pressed = new Set<ActionName>();
  mouseDown = false;
  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  /**
   * The game only takes the keyboard while a session is running. In the
   * menu the text fields keep their keys.
   */
  enabled = false;

  private el: HTMLElement | null = null;
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // A field the user is typing into keeps its keys.
    //
    // The listener sits on window, and `e.code` does not depend on the
    // keyboard layout: a Cyrillic "К" produces KeyR, which is a game
    // action. Without this check, typing a nickname silently eats every
    // letter that happens to sit under R/E/F/G/B — and the digits, which
    // are weapon slots.
    if (!this.enabled || isTypingTarget(e.target)) return;
    this.keys.add(e.code);
    const action = ACTION_KEYS[e.code];
    if (action) {
      this.pressed.add(action);
      e.preventDefault();
    }
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = true;
    if (e.button === 1 && this.enabled) {
      // Middle click: a team marker (and no autoscroll).
      e.preventDefault();
      this.pressed.add('mark');
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };

  private onWheel = (e: WheelEvent) => {
    this.wheel += Math.sign(e.deltaY);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseDown = false;
  };

  private onContext = (e: Event) => e.preventDefault();

  attach(el: HTMLElement): void {
    this.el = el;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.onBlur);
    el.addEventListener('contextmenu', this.onContext);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    this.el?.removeEventListener('contextmenu', this.onContext);
    this.el = null;
  }

  /** Consumes a one-shot action press. */
  consume(action: ActionName): boolean {
    if (this.pressed.has(action)) {
      this.pressed.delete(action);
      return true;
    }
    return false;
  }

  endFrame(): void {
    this.pressed.clear();
    this.wheel = 0;
  }

  /** Normalized movement vector from WASD / arrow keys. */
  moveVector(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    const l = Math.hypot(x, z);
    if (l > 1e-6) {
      x /= l;
      z /= l;
    }
    return { x, z };
  }
}

/**
 * True when the event comes from a field the user is typing into.
 *
 * The menu has text inputs and the game listens on window, so without this
 * check the game eats characters out of whatever the player types.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  );
}
