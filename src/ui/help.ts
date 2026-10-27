import { CLASS_INFO, CONTROLS, OBJECT_INFO, POWERUP_INFO } from '../game/info';
import { MODES } from '../game/modes';
import { WEAPON_ORDER, WEAPONS, weaponCooldown } from '../game/weapons';
import type { PlayerClass, PowerupKind } from '../game/types';

// The help panel ("Справка"): classes, modes, weapons, powerups, objects,
// controls and ranked play, built from the game's own tables.

type Tab = 'classes' | 'modes' | 'weapons' | 'bonuses' | 'objects' | 'controls' | 'ranked';

const TABS: [Tab, string][] = [
  ['classes', 'Классы'],
  ['modes', 'Режимы'],
  ['weapons', 'Оружие'],
  ['bonuses', 'Бонусы'],
  ['objects', 'Объекты и тактика'],
  ['controls', 'Управление'],
  ['ranked', 'Рейтинг'],
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class HelpPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private tab: Tab = 'classes';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'help hidden';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Справка');
    this.root.innerHTML = `
      <div class="help-card">
        <div class="help-head">
          <span class="help-title">СПРАВКА</span>
          <nav class="help-tabs">${TABS.map(([id, name]) => `<button data-tab="${id}">${name}</button>`).join('')}</nav>
          <button class="help-close" aria-label="Закрыть">✕</button>
        </div>
        <div class="help-body"></div>
      </div>`;
    this.body = this.root.querySelector('.help-body')!;
    this.root.querySelectorAll<HTMLButtonElement>('.help-tabs button').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.tab as Tab)));
    this.root.querySelector('.help-close')!.addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    // Clicks here must not reach the game as shots.
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(tab?: Tab): void {
    this.show(tab ?? this.tab);
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  private show(tab: Tab): void {
    this.tab = tab;
    this.root.querySelectorAll<HTMLButtonElement>('.help-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    this.body.innerHTML = RENDER[tab]();
    this.body.scrollTop = 0;
  }
}

/** The card under the class buttons in the menu. */
export function classCard(cls: PlayerClass): string {
  const c = CLASS_INFO[cls];
  return `<b>${esc(c.name)}</b> — ${esc(c.role)}<ul>${c.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
}

const RENDER: Record<Tab, () => string> = {
  classes: () =>
    `<p class="help-lead">Класс выбирается в меню перед игрой и действует во всех режимах, в том числе в рейтинговом бою.</p>
    <div class="help-grid">${(Object.keys(CLASS_INFO) as PlayerClass[])
      .map((k) => `<article><h3>${esc(CLASS_INFO[k].name)}</h3><p class="help-role">${esc(CLASS_INFO[k].role)}</p><ul>${CLASS_INFO[k].perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></article>`)
      .join('')}</div>`,

  modes: () =>
    `<div class="help-grid">${MODES.map(
      (m) => `<article><h3>${esc(m.title)}</h3><p>${esc(m.desc)}</p><p class="help-role">${m.arena ? 'Арена · боты по желанию' : 'Сгенерированный объект · до 4 игроков'}</p></article>`,
    ).join('')}</div>`,

  weapons: () => {
    const ids = WEAPON_ORDER;
    const dps = (id: (typeof ids)[number]) => {
      const w = WEAPONS[id];
      return (w.damage * w.pellets) / weaponCooldown(w);
    };
    const max = Math.max(...ids.map(dps));
    const maxRange = Math.max(...ids.map((id) => WEAPONS[id].falloffStart));
    const bar = (v: number, of: number) => `<i class="help-bar"><u style="width:${Math.round((v / of) * 100)}%"></u></i>`;
    return `<table class="help-table"><thead><tr><th>Оружие</th><th>Урон</th><th>Темп</th><th>Магазин</th><th>Урон/с</th><th>Дальность</th><th>Шум</th></tr></thead><tbody>${ids
      .map((id) => {
        const w = WEAPONS[id];
        const melee = w.melee;
        return `<tr><td>${esc(w.name)}</td><td>${w.damage}${w.pellets > 1 ? ` ×${w.pellets}` : ''}</td><td>${w.rpm}/мин</td><td>${melee ? '—' : w.mag}</td><td>${bar(dps(id), max)}</td><td>${melee ? 'вплотную' : bar(w.falloffStart, maxRange)}</td><td>${w.noise <= 0 ? 'бесшумно' : w.noise < 10 ? 'тихо' : w.noise < 25 ? 'средне' : 'громко'}</td></tr>`;
      })
      .join('')}</tbody></table>
      <p class="help-lead">Пули летят с реальной скоростью, разброс растёт на бегу и падает в шаге и присяде. Урон снижается с расстоянием. Нож со спины убивает сразу.</p>`;
  },

  bonuses: () =>
    `<p class="help-lead">Бонусы лежат на картах и возрождаются на аренах; иногда их роняют убитые. Активные бонусы видны над патронами.</p>
    <div class="help-list">${(Object.keys(POWERUP_INFO) as PowerupKind[])
      .map((k) => `<div class="help-row"><b class="pw pw-${k}">${esc(POWERUP_INFO[k].name)}</b><span>${esc(POWERUP_INFO[k].desc)}</span></div>`)
      .join('')}</div>`,

  objects: () =>
    `<div class="help-list">${OBJECT_INFO.map((o) => `<div class="help-row"><b>${esc(o.name)}</b><kbd>${esc(o.key)}</kbd><span>${esc(o.desc)}</span></div>`).join('')}</div>
    <p class="help-lead">Свет — главное оружие: в темноте вас не видно, но и вы не видите никого. Лампы можно прострелить или выключить рубильником, фонарь выдаёт владельца.</p>`,

  controls: () => `<div class="help-list">${CONTROLS.map(([k, d]) => `<div class="help-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`,

  ranked: () =>
    `<p class="help-lead">Рейтинговый бой — deathmatch на сервере, только живые игроки, без ботов. Войдите через Яндекс и нажмите «Рейтинговый бой»: бой начнётся, когда наберётся от 2 до 6 игроков.</p>
    <ul class="help-ul">
      <li>Место в бою (убийства, затем меньше смертей) меняет рейтинг по системе Эло; старт — 1000.</li>
      <li>Ушедший из боя получает последнее место. Вернуться можно в течение 30 секунд.</li>
      <li>Таблица лучших — на странице <a href="/rating" target="_blank">Рейтинг</a>.</li>
    </ul>`,
};
