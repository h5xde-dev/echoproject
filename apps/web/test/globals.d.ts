import type { Game } from '../src/game/game';
import type { Hud } from '../src/ui/hud';

declare global {
  interface Window {
    /** Debug handle the game page exposes (main.ts). */
    echo: { game: Game; hud: Hud };
  }
}

export {};
