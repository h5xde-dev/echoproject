import type { Difficulty, PlayerClass } from '../game/types';

/**
 * Player settings, kept in localStorage. Storage can be missing (private
 * windows, blocked site data): then the defaults simply apply each session.
 */
export interface Settings {
  /** Master volume, 0..1. */
  volume: number;
  /** Low: pixel density 1 and no shadows, for weaker machines. */
  quality: 'high' | 'low';
  /** Camera shake on shots and blasts. */
  shake: boolean;
  /** FPS and ping counter in the corner. */
  stats: boolean;
  /** Bot difficulty for games you host or play solo. */
  difficulty: Difficulty;
  /** Your class. */
  cls: PlayerClass;
  /** Ring colour picked from the unlocked ones (-1: default). */
  color: number;
}

const KEY = 'echo.settings';

export const DEFAULT_SETTINGS: Settings = { volume: 0.8, quality: 'high', shake: true, stats: false, difficulty: 'normal', cls: 'assault', color: -1 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : DEFAULT_SETTINGS.volume,
      quality: s.quality === 'low' ? 'low' : 'high',
      shake: typeof s.shake === 'boolean' ? s.shake : DEFAULT_SETTINGS.shake,
      stats: typeof s.stats === 'boolean' ? s.stats : DEFAULT_SETTINGS.stats,
      difficulty: s.difficulty === 'easy' || s.difficulty === 'hard' ? s.difficulty : 'normal',
      cls: s.cls === 'scout' || s.cls === 'medic' || s.cls === 'engineer' ? s.cls : 'assault',
      color: typeof s.color === 'number' ? s.color : -1,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* no storage: settings last for this session only */
  }
}
