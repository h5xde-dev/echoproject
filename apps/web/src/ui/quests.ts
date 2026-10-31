// Quests, achievements and cosmetics (signed-in players; the API counts them).
// A short list of today's quests in the menu, and a window with everything
// plus the camouflage and badge pickers.

export interface QuestView {
  id: string;
  text: string;
  goal: number;
  progress: number;
  done: boolean;
  xp: number;
}

export interface QuestsData {
  daily: QuestView[];
  weekly: QuestView[];
  dailyEndsIn: number;
  weeklyEndsIn: number;
  achievements: { id: string; title: string; desc: string; goal: number; progress: number; done: boolean; xp: number }[];
  camos: { id: string; name: string; colors: number[]; owned: boolean }[];
  badges: { id: string; name: string; glyph: string; color: number; owned: boolean }[];
}

export async function fetchQuests(): Promise<QuestsData | null> {
  try {
    const res = await fetch('/api/me/quests', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok ? ((await res.json()) as QuestsData) : null;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function left(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h >= 24) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  return `${h} ч ${Math.floor((ms % 3600_000) / 60_000)} мин`;
}

function questLine(q: QuestView): string {
  const pct = Math.round((q.progress / q.goal) * 100);
  return `<div class="quest${q.done ? ' done' : ''}"><span>${esc(q.text)}</span><em>${q.done ? '✓' : `${q.progress}/${q.goal}`}</em><i style="width:${pct}%"></i><small>+${q.xp}</small></div>`;
}

/** The menu block: today's quests, or why to sign in. */
export function renderQuestBox(box: HTMLElement, data: QuestsData | null, signedIn: boolean): void {
  if (!signedIn) {
    box.innerHTML = `<div class="quests-head"><span>ЗАДАНИЯ</span></div><div class="quests-guest">Войдите через Яндекс — ежедневные и недельные задания, достижения, камуфляжи и значки.</div>`;
    return;
  }
  if (!data) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="quests-head"><span>ЗАДАНИЯ ДНЯ</span><em>обновятся через ${left(data.dailyEndsIn)}</em></div>${data.daily.map(questLine).join('')}<button class="quests-open" type="button">ВСЕ ЗАДАНИЯ, ДОСТИЖЕНИЯ, КАМУФЛЯЖ</button>`;
}

/** The window: quests of the day and week, achievements, cosmetics. */
export class QuestsPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  /** Picked a camo or badge ('' takes it off). */
  onPick: (kind: 'camo' | 'badge', id: string) => void = () => undefined;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'help hidden';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Задания и награды');
    this.root.innerHTML = `
      <div class="help-card">
        <div class="help-head"><span class="help-title">ЗАДАНИЯ И НАГРАДЫ</span><span style="flex:1"></span><button class="help-close" aria-label="Закрыть">✕</button></div>
        <div class="help-body quests-body"></div>
      </div>`;
    this.body = this.root.querySelector('.help-body')!;
    this.root.querySelector('.help-close')!.addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
      const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
      if (pick && !pick.classList.contains('locked')) this.onPick(pick.dataset.pick as 'camo' | 'badge', pick.dataset.id ?? '');
    });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  open(data: QuestsData, current: { camo?: string; badge?: string }): void {
    this.render(data, current);
    this.root.classList.remove('hidden');
  }

  render(data: QuestsData, current: { camo?: string; badge?: string }): void {
    const ach = data.achievements
      .map(
        (a) =>
          `<div class="ach${a.done ? ' done' : ''}"><b>${a.done ? '✓ ' : ''}${esc(a.title)}</b><span>${esc(a.desc)}</span><em>${a.done ? `+${a.xp}` : `${a.progress}/${a.goal}`}</em></div>`,
      )
      .join('');
    const camos = [{ id: '', name: 'Без камуфляжа', colors: [0x4a5058], owned: true }, ...data.camos]
      .map(
        (c) =>
          `<button class="pick${c.owned ? '' : ' locked'}${(current.camo ?? '') === c.id ? ' active' : ''}" data-pick="camo" data-id="${c.id}" title="${c.owned ? esc(c.name) : `${esc(c.name)} — за достижение`}"><span class="swatch">${c.colors.map((x) => `<i style="background:${hex(x)}"></i>`).join('')}</span>${esc(c.name)}</button>`,
      )
      .join('');
    const badges = [{ id: '', name: 'Без значка', glyph: '—', color: 0x8090a0, owned: true }, ...data.badges]
      .map(
        (b) =>
          `<button class="pick${b.owned ? '' : ' locked'}${(current.badge ?? '') === b.id ? ' active' : ''}" data-pick="badge" data-id="${b.id}"><span class="glyph" style="color:${hex(b.color)}">${esc(b.glyph)}</span>${esc(b.name)}</button>`,
      )
      .join('');
    this.body.innerHTML = `
      <div class="quests-cols">
        <section><h3>День <small>· обновятся через ${left(data.dailyEndsIn)}</small></h3>${data.daily.map(questLine).join('')}
          <h3>Неделя <small>· обновятся через ${left(data.weeklyEndsIn)}</small></h3>${data.weekly.map(questLine).join('')}</section>
        <section><h3>Камуфляж</h3><div class="picks">${camos}</div><h3>Значок у имени</h3><div class="picks">${badges}</div></section>
      </div>
      <h3>Достижения</h3><div class="achs">${ach}</div>`;
  }
}
