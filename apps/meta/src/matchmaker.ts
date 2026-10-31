import type { MatchmakingMsg } from '@echo/shared/net/protocol';
import { META } from './config';
import { createRoom } from './registry';

// Ranked queue: a match starts at once when it is full, or `gatherSec` after
// the minimum number of players is waiting. One place per account.

export interface Waiting {
  sub: string;
  send(msg: MatchmakingMsg): void;
  /** The match is on: hand this player their ticket. */
  matched(code: string, url: string): void;
  /** Kicked out of the queue (another tab took the place). */
  drop(text: string): void;
}

const queue: Waiting[] = [];
let gatherSince = 0;
let starting = false;

export function queued(): number {
  return queue.length;
}

export function enqueue(w: Waiting): void {
  // A second tab replaces the first.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].sub === w.sub && queue[i] !== w) queue.splice(i, 1)[0].drop('Вы встали в очередь в другой вкладке');
  }
  if (!queue.includes(w)) queue.push(w);
  void update();
}

export function leave(w: Waiting): void {
  const i = queue.indexOf(w);
  if (i >= 0) queue.splice(i, 1);
  void update();
}

async function update(): Promise<void> {
  if (starting) return;
  const { minPlayers, maxPlayers, gatherSec } = META.ranked;
  if (queue.length < minPlayers) gatherSince = 0;
  else gatherSince ||= Date.now();

  while (queue.length >= maxPlayers || (gatherSince && queue.length >= minPlayers && Date.now() - gatherSince >= gatherSec * 1000)) {
    const entrants = queue.splice(0, maxPlayers);
    gatherSince = queue.length >= minPlayers ? Date.now() : 0;
    for (const e of entrants) e.send({ t: 'mm', state: 'found', players: entrants.length });
    starting = true;
    try {
      const { code, url } = await createRoom(null, true, entrants.map((e) => e.sub));
      for (const e of entrants) e.matched(code, url);
    } catch {
      for (const e of entrants) e.send({ t: 'mm', state: 'error', text: 'Игровой сервер недоступен — попробуйте через минуту' });
    } finally {
      starting = false;
    }
  }

  const startIn = gatherSince ? Math.max(0, Math.ceil(gatherSec - (Date.now() - gatherSince) / 1000)) : -1;
  for (const e of queue) e.send({ t: 'mm', state: 'queue', players: queue.length, need: minPlayers, startIn });
}

setInterval(() => void update(), 1000).unref();
