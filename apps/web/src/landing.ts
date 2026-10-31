import './landing.css';

// The landing page: static for search engines; only the top players are
// fetched live (and silently skipped when the game server is not there).

interface Row {
  name: string;
  rating: number;
  games: number;
}

const list = document.getElementById('leaders');

async function loadLeaders(): Promise<void> {
  try {
    const res = await fetch('/api/leaderboard?limit=5');
    if (!res.ok || !list) return;
    const { rows } = (await res.json()) as { rows: Row[] };
    if (rows.length === 0) return;
    list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement('li');
        li.textContent = r.name;
        const score = document.createElement('span');
        score.textContent = String(r.rating);
        li.appendChild(score);
        return li;
      }),
    );
  } catch {
    /* no server: the placeholder stays */
  }
}

void loadLeaders();
