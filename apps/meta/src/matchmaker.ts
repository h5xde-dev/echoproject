import type { PlayerClass } from '@echo/shared/game/types';
import type { ClientMessage } from '@echo/shared/net/protocol';
import { SERVER } from './config';
import type { PlayerConn } from './conn';
import { RankedMatch, type Entrant } from './match';

// Ranked queue: a match starts at once when it is full, or `gatherSec` after
// the minimum number of players is waiting. One seat per account.

const queue: Entrant[] = [];
const matches = new Set<RankedMatch>();
let gatherSince = 0;

export function stats(): { queued: number; matches: number; playing: number } {
  let playing = 0;
  for (const m of matches) playing += m.sim.actors.size;
  return { queued: queue.length, matches: matches.size, playing };
}

/** A new WebSocket from a signed-in player: wait for their hello. */
export function accept(conn: PlayerConn): void {
  conn.onMessage = (msg: ClientMessage) => {
    if (msg.t !== 'hello') return;
    // Back from a dropped link: straight into the same match.
    for (const m of matches) if (m.hasSeat(conn.user.id) && m.rejoin(conn)) return;
    enqueue({ conn, cls: validClass(msg.cls), color: typeof msg.color === 'number' ? msg.color : -1 });
  };
  conn.onClose = () => leave(conn);
}

function enqueue(e: Entrant): void {
  // A second tab replaces the first.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].conn.user.id === e.conn.user.id) {
      const old = queue.splice(i, 1)[0];
      if (old.conn !== e.conn) {
        old.conn.send({ t: 'mm', state: 'error', text: 'Вы встали в очередь в другой вкладке' });
        old.conn.close();
      }
    }
  }
  queue.push(e);
  e.conn.onClose = () => leave(e.conn);
  update();
}

function leave(conn: PlayerConn): void {
  const i = queue.findIndex((q) => q.conn === conn);
  if (i >= 0) queue.splice(i, 1);
  update();
}

function update(): void {
  const { minPlayers, maxPlayers, gatherSec } = SERVER.ranked;
  if (queue.length < minPlayers) gatherSince = 0;
  else gatherSince ||= Date.now();

  while (queue.length >= maxPlayers || (gatherSince && queue.length >= minPlayers && Date.now() - gatherSince >= gatherSec * 1000)) {
    const entrants = queue.splice(0, maxPlayers);
    gatherSince = queue.length >= minPlayers ? Date.now() : 0;
    for (const e of entrants) e.conn.send({ t: 'mm', state: 'found', players: entrants.length });
    const match = new RankedMatch(entrants, (m) => {
      // Let the result screens show, then forget the match.
      setTimeout(() => matches.delete(m), 15_000);
    });
    matches.add(match);
  }

  const startIn = gatherSince ? Math.max(0, Math.ceil(gatherSec - (Date.now() - gatherSince) / 1000)) : -1;
  for (const e of queue) e.conn.send({ t: 'mm', state: 'queue', players: queue.length, need: minPlayers, startIn });
}

setInterval(update, 1000).unref();

export function shutdown(): void {
  for (const m of matches) m.abort();
  for (const e of queue) e.conn.close();
}

function validClass(cls: unknown): PlayerClass | null {
  return cls === 'assault' || cls === 'scout' || cls === 'medic' || cls === 'engineer' ? cls : null;
}
