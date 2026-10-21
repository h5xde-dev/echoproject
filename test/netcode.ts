import { Game } from '../src/game/game';
import { Hud } from '../src/ui/hud';
import { installLoopbackTransport } from './loopback';

interface Harness {
  gameA: Game;
  gameB: Game;
  code: string;
  ready: boolean;
  error: string;
}

async function main(): Promise<void> {
  const harness: Harness = {
    gameA: null as unknown as Game,
    gameB: null as unknown as Game,
    code: '',
    ready: false,
    error: '',
  };
  (window as unknown as { __net: Harness }).__net = harness;

  try {
    installLoopbackTransport();

    // Reuse the production HUD markup so the test exercises the real widget.
    const html = await fetch('/index.html').then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const template = doc.getElementById('hud')?.innerHTML ?? '';

    const hudA = document.getElementById('hudA')!;
    const hudB = document.getElementById('hudB')!;
    hudA.innerHTML = template;
    hudB.innerHTML = template;

    // Shadow maps are far too slow under software rendering in CI.
    harness.gameA = new Game(document.getElementById('viewA')!, new Hud(hudA), { shadows: false });
    harness.gameB = new Game(document.getElementById('viewB')!, new Hud(hudB), { shadows: false });

    await harness.gameA.startHost('альфа');
    harness.code = harness.gameA.roomCode;
    await harness.gameB.startClient('браво', harness.code);

    harness.ready = true;
  } catch (err) {
    harness.error = err instanceof Error ? err.message : String(err);
  }
}

void main();
