// The signed-in player (Yandex ID, via the game server). Offline builds and
// local play work without it: every call fails soft to "signed out".

export interface Account {
  id: number;
  name: string;
  avatar: string;
  rating: number;
  games: number;
  wins: number;
  rank: number | null;
  /** Experience the server banked for this account. */
  xp: number;
  level: number;
  /** The guest progress of some browser was already added (once per account). */
  imported?: boolean;
  settings?: { cls?: 'assault' | 'scout' | 'medic' | 'engineer'; color?: number; difficulty?: 'easy' | 'normal' | 'hard'; roomBots?: boolean; controls?: 'aim' | 'screen'; camo?: string; badge?: string };
}

export async function fetchAccount(): Promise<{ user: Account | null; available: boolean }> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return { user: null, available: false };
    const body = (await res.json()) as { user: Account | null };
    return { user: body.user, available: true };
  } catch {
    return { user: null, available: false };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* the cookie expires on its own */
  }
}

/** The call sign shown in ranked matches and the rating table. */
export async function rename(name: string): Promise<string | null> {
  try {
    const res = await fetch('/api/me/name', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return res.ok ? ((await res.json()) as { name: string }).name : null;
  } catch {
    return null;
  }
}

/** Class, ring colour, difficulty, bots switch: kept on the account. */
export async function saveProfile(settings: NonNullable<Account['settings']>): Promise<void> {
  try {
    await fetch('/api/me/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch {
    /* kept in this browser anyway */
  }
}

/** Adds this browser's guest experience to the account (the server does it once). */
export async function importProgress(xp: number, matches: number): Promise<Account | null> {
  try {
    const res = await fetch('/api/me/progress/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xp, matches }),
    });
    return res.ok ? ((await res.json()) as { user: Account }).user : null;
  } catch {
    return null;
  }
}
