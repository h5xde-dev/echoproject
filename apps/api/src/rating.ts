// Multiplayer Elo: every player is compared with every other one by final
// place; the K-factor is shared out over the opponents, so a match of six
// moves a rating about as much as one duel.

export const K_FACTOR = 32;

export function eloUpdate(players: { rating: number; place: number }[], k = K_FACTOR): number[] {
  const n = players.length;
  if (n < 2) return players.map((p) => p.rating);
  return players.map((a, i) => {
    let delta = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = players[j];
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const actual = a.place < b.place ? 1 : a.place === b.place ? 0.5 : 0;
      delta += actual - expected;
    }
    return a.rating + (k / (n - 1)) * delta;
  });
}
