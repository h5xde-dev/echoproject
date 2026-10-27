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
