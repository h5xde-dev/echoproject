import type { Game } from '../src/game/game';

declare global {
  interface Window {
    __peaks: { host: number; client: number };
    __peakTimer: number;
    __net: {
      gameA: Game;
      gameB: Game;
      code: string;
      ready: boolean;
      error: string;
    };
  }
}

export {};
