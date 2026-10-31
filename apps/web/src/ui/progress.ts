/**
 * Progress between matches: experience, levels and what they unlock (ring
 * colours). The rules live in @echo/shared/progress; this keeps a guest's
 * progress in localStorage on this device; without storage it simply
 * starts over each session.
 */
import { levelOf, matchXp, RING_COLORS, type MatchTally, type Progress } from '@echo/shared/progress';

export { levelOf, matchXp, RING_COLORS, type MatchTally, type Progress };

const KEY = 'echo.progress';

export function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Progress>;
    const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : 0);
    return { xp: n(p.xp), matches: n(p.matches), kills: n(p.kills), wins: n(p.wins) };
  } catch {
    return { xp: 0, matches: 0, kills: 0, wins: 0 };
  }
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* no storage: progress lasts this session only */
  }
}

/** Banks a finished match; returns what changed for the game-over screen. */
export function addMatch(t: MatchTally, win: boolean): { gained: number; before: number; after: number; unlocked: string[] } {
  const p = loadProgress();
  const gained = matchXp(t, win);
  const before = levelOf(p.xp).level;
  p.xp += gained;
  p.matches++;
  p.kills += t.kills;
  if (win) p.wins++;
  saveProgress(p);
  const after = levelOf(p.xp).level;
  const unlocked = RING_COLORS.filter((c) => c.level > before && c.level <= after).map((c) => c.name);
  return { gained, before, after, unlocked };
}
