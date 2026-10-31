import './landing.css';

// Rating page: the server renders the table into the HTML; this refreshes it
// and marks the signed-in player's row.

interface Row {
  id: number;
  name: string;
  rating: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
}

const body = document.getElementById('rating-body')!;

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function load(): Promise<void> {
  try {
    const [board, me] = await Promise.all([
      fetch('/api/leaderboard?limit=100').then((r) => r.json() as Promise<{ rows: Row[] }>),
      fetch('/api/me').then((r) => r.json() as Promise<{ user: { id: number } | null }>),
    ]);
    if (board.rows.length === 0) {
      const tr = document.createElement('tr');
      const td = cell('Пока никто не сыграл рейтинговый бой — будьте первым.');
      td.colSpan = 6;
      td.className = 'empty';
      tr.appendChild(td);
      body.replaceChildren(tr);
      return;
    }
    body.replaceChildren(
      ...board.rows.map((r, i) => {
        const tr = document.createElement('tr');
        if (r.id === me.user?.id) tr.className = 'me';
        tr.append(cell(String(i + 1)), cell(r.name), cell(String(r.rating)), cell(String(r.games)), cell(String(r.wins)), cell(r.deaths ? (r.kills / r.deaths).toFixed(2) : String(r.kills)));
        return tr;
      }),
    );
  } catch {
    /* keep whatever the server rendered */
  }
}

void load();
