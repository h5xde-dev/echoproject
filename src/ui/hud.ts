import type { Buffs, Gait, GameMode, GrenadeKind, MapData, RoomDef, ShopItem } from '../game/types';
import { GUN_LADDER, isArena, SHOP } from '../game/modes';
import type { RoundState } from '../net/protocol';
import { WEAPON_ORDER } from '../game/weapons';
import { CONFIG } from '../game/config';
import { clamp } from '../core/math';
import type { WeaponId } from '../game/weapons';

export interface HudPlayer {
  name: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  isLocal: boolean;
  color: number;
}

export interface HudState {
  hp: number;
  maxHp: number;
  alive: boolean;
  weapon: WeaponId;
  ammo: number;
  mag: number;
  reloading: boolean;
  room: number;
  rooms: number;
  phase: 'fighting' | 'cleared' | 'done';
  players: HudPlayer[];
  enemiesLeft: number;
  flashOn: boolean;
  gait: Gait;
  /** Spread multiplier of the local player's weapon (1 = nominal). */
  spread: number;
  armor: number;
  weapons: WeaponId[];
  buffs: Buffs;
  shield: number;
  /** Seconds until respawn (0 = unknown / alive). */
  respawnIn: number;
  /** Deathmatch clock, seconds. */
  timeLeft: number;
  /** Arena table, best first. */
  scores: HudScore[];
  grenades: number;
  smokes: number;
  flashes: number;
  /** Grenade kind G throws. */
  nadeKind: GrenadeKind;
  /** Seconds left blinded by a flash grenade. */
  blind: number;
  money: number;
  tier: number;
  tierKills: number;
  round: RoundState | null;
  modeTitle: string;
}

export interface HudScore {
  name: string;
  kills: number;
  deaths: number;
  rounds: number;
  /** Gun game progress: tier * 10 + kills on the tier. */
  tier: number;
  isLocal: boolean;
  isBot: boolean;
}

export interface HudPlate {
  id: number;
  x: number;
  y: number;
  name: string;
  hpRatio: number;
  armorRatio: number;
  kind: 'self' | 'ally' | 'enemy';
}

interface FeedEntry {
  el: HTMLDivElement;
  life: number;
}

const WEAPON_LABEL: Record<WeaponId, string> = {
  pistol: 'M9',
  smg: 'ПП',
  shotgun: 'ДРОБ.',
  rifle: 'ВИНТ.',
  sniper: 'СНАЙП.',
};

export class Hud {
  private squadEl: HTMLElement;
  private roomEl: HTMLElement;
  private objectiveEl: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private weaponEl: HTMLElement;
  private ammoEl: HTMLElement;
  private magEl: HTMLElement;
  private reloadEl: HTMLElement;
  private latencyEl: HTMLElement;
  private feedEl: HTMLElement;
  private minimap: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private crosshair: HTMLElement;
  private vignette: HTMLElement;
  private statusEl: HTMLElement;
  private overEl: HTMLElement;
  private overTitle: HTMLElement;
  private overText: HTMLElement;
  private flashEl: HTMLElement;
  private gaitEl: HTMLElement;
  private flashOverlay: HTMLElement;
  /** Crosshair size from stance and movement, before shot bloom. */
  private baseSpread = 1;
  private roomCodePanel: HTMLElement;
  private roomCodeEl: HTMLElement;
  private pauseEl: HTMLElement;

  private platesEl: HTMLElement;
  private dmgEl: HTMLElement;
  private pipsEl: HTMLElement;
  private plates = new Map<number, { el: HTMLElement; fill: HTMLElement; armor: HTMLElement; name: HTMLElement; seen: boolean }>();
  private dmgArcs: { el: HTMLElement; life: number }[] = [];
  private hitT = 0;
  private killT = 0;
  private spread = 0;
  private pipsKey = '';
  private squadKey = '';
  private mode: GameMode = 'coop';
  private armorFill: HTMLElement;
  private armorText: HTMLElement;
  private buffsEl: HTMLElement;
  private slotsEl: HTMLElement;
  private killfeedEl: HTMLElement;
  private respawnEl: HTMLElement;
  private scoreboardEl: HTMLElement;
  private scoreTable: HTMLTableElement;
  private overScores: HTMLTableElement;
  private kills: { el: HTMLElement; life: number }[] = [];
  private slotsKey = '';
  private bannerEl: HTMLElement;
  private bannerT = 0;
  private shopEl: HTMLElement;
  private shopKey = '';
  private extraEl: HTMLElement;
  private ladderEl: HTMLElement;
  private ladderKey = '';
  /** Called when a shop item is clicked. */
  onBuy: (item: ShopItem) => void = () => undefined;
  /** The pause overlay was closed with "продолжить". */
  onPauseResume: () => void = () => undefined;
  /** The pause overlay asked to leave for the main menu. */
  onPauseMenu: () => void = () => undefined;
  private buffsKey = '';
  private scoresKey = '';

  private feed: FeedEntry[] = [];
  private lastHp = 0;
  private vignetteLife = 0;

  constructor(private readonly root: HTMLElement) {
    this.squadEl = must(root, '.squad');
    this.roomEl = must(root, '.objective-room');
    this.objectiveEl = must(root, '.objective-text');
    this.hpFill = must(root, '.hp-fill');
    this.hpText = must(root, '.hp-text');
    this.weaponEl = must(root, '.weapon-name');
    this.ammoEl = must(root, '.ammo-current');
    this.magEl = must(root, '.ammo-mag');
    this.reloadEl = must(root, '.reload-bar');
    this.latencyEl = must(root, '.latency');
    this.feedEl = must(root, '.feed');
    this.minimap = must(root, '.minimap') as HTMLCanvasElement;
    this.minimapCtx = this.minimap.getContext('2d')!;
    this.crosshair = must(root, '.crosshair');
    this.vignette = must(root, '.vignette');
    this.statusEl = must(root, '.status-line');
    this.overEl = must(root, '.gameover');
    this.overTitle = must(root, '.gameover-title');
    this.overText = must(root, '.gameover-text');
    this.flashEl = must(root, '.flashlight-tag');
    this.gaitEl = must(root, '.gait-tag');
    this.flashOverlay = must(root, '.flash-overlay');
    this.roomCodePanel = must(root, '.panel-room');
    this.roomCodeEl = must(root, '.room-code-inline');
    this.platesEl = must(root, '.plates');
    this.dmgEl = must(root, '.dmg-dirs');
    this.pipsEl = must(root, '.ammo-pips');
    this.armorFill = must(root, '.armor-fill');
    this.armorText = must(root, '.armor-text');
    this.buffsEl = must(root, '.buffs');
    this.slotsEl = must(root, '.weapon-slots');
    this.killfeedEl = must(root, '.killfeed');
    this.respawnEl = must(root, '.respawn-banner');
    this.scoreboardEl = must(root, '.scoreboard');
    this.scoreTable = must(root, '.scoreboard-table') as HTMLTableElement;
    this.overScores = must(root, '.gameover-scores') as HTMLTableElement;
    this.bannerEl = must(root, '.banner');
    this.shopEl = must(root, '.shop');
    this.extraEl = must(root, '.weapon-extra');
    this.ladderEl = must(root, '.ladder');
    this.shopEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-item]');
      if (btn && !btn.classList.contains('locked')) this.onBuy(btn.dataset.item as ShopItem);
    });
    must(root, '.gameover-again').addEventListener('click', () => location.reload());
    this.pauseEl = must(root, '.pause');
    must(root, '.pause-resume').addEventListener('click', () => this.onPauseResume());
    must(root, '.pause-menu').addEventListener('click', () => this.onPauseMenu());
  }

  setMode(mode: GameMode, arenaName: string, title = ''): void {
    this.mode = mode;
    const root = this.hudRoot();
    root.classList.toggle('mode-dm', isArena(mode));
    root.classList.toggle('mode-gun', mode === 'gun');
    root.classList.toggle('mode-comp', mode === 'comp');
    if (isArena(mode)) this.roomEl.textContent = `${(title || mode).toUpperCase()} · ${arenaName.toUpperCase()}`;
  }

  /** Big centre message (round start, new gun...). */
  banner(title: string, sub: string): void {
    this.bannerEl.innerHTML = `<b>${escapeHtml(title)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}`;
    this.bannerEl.classList.remove('visible');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('visible');
    this.bannerT = 2.2;
  }

  /** Competitive shop overlay. */
  showBuyMenu(open: boolean, money: number, round: RoundState | null): void {
    this.shopEl.classList.toggle('visible', open);
    this.hudRoot().classList.toggle('shopping', open);
    if (!open) return;
    const key = `${money}|${Math.ceil(round?.t ?? 0)}`;
    if (key === this.shopKey) return;
    this.shopKey = key;
    const items = SHOP.map((e, i) => {
      const locked = money < e.price;
      return `<button class="shop-item${locked ? ' locked' : ''}" data-item="${e.item}"><kbd>${i + 1}</kbd><span>${escapeHtml(e.name)}</span><em>$${e.price}</em></button>`;
    }).join('');
    this.shopEl.innerHTML = `<div class="shop-head"><span>МАГАЗИН</span><b>$${money}</b></div><div class="shop-grid">${items}</div><div class="shop-foot">B — закрыть · клавиши 1–${SHOP.length} или клик</div>`;
  }

  private hudRoot(): HTMLElement {
    return this.root;
  }

  /** "killer ✕ victim" line; `by` empty for suicides and accidents. */
  killFeed(by: string, victim: string, mine: boolean, me: boolean): void {
    const el = document.createElement('div');
    el.className = `kill-line${mine ? ' mine' : ''}${me ? ' me' : ''}`;
    const a = document.createElement('span');
    a.textContent = by;
    const x = document.createElement('i');
    x.textContent = by ? '✕' : '☠';
    const b = document.createElement('span');
    b.textContent = victim;
    el.append(a, x, b);
    this.killfeedEl.prepend(el);
    this.kills.push({ el, life: 6 });
    while (this.kills.length > 5) this.kills.shift()?.el.remove();
  }

  showScores(visible: boolean): void {
    this.scoreboardEl.classList.toggle('visible', visible && isArena(this.mode));
  }

  private fillScores(table: HTMLTableElement, rows: HudScore[]): void {
    const extra = this.mode === 'comp' ? 'Раунды' : this.mode === 'gun' ? 'Оружие' : '';
    let html = `<tr><th></th><th>Боец</th>${extra ? `<th>${extra}</th>` : ''}<th>Фраги</th><th>Смерти</th></tr>`;
    rows.forEach((r, i) => {
      const cls = `${r.isLocal ? 'local' : ''}${r.isBot ? ' bot' : ''}`;
      const col =
        this.mode === 'comp'
          ? `<td>${r.rounds}</td>`
          : this.mode === 'gun'
            ? `<td>${LADDER_LABEL[Math.min(GUN_LADDER.length - 1, Math.floor(r.tier / 10))]}</td>`
            : '';
      html += `<tr class="${cls}"><td>${i + 1}</td><td>${escapeHtml(r.name)}${r.isBot ? ' <em>бот</em>' : ''}</td>${col}<td>${r.kills}</td><td>${r.deaths}</td></tr>`;
    });
    table.innerHTML = html;
  }

  /** Name + health plates over soldiers; `items` are already in screen space. */
  updatePlates(items: HudPlate[]): void {
    for (const p of this.plates.values()) p.seen = false;
    for (const it of items) {
      let p = this.plates.get(it.id);
      if (!p) {
        const el = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'plate-name';
        const bar = document.createElement('span');
        bar.className = 'plate-bar';
        const fill = document.createElement('i');
        const armor = document.createElement('b');
        bar.append(fill, armor);
        el.append(name, bar);
        this.platesEl.appendChild(el);
        p = { el, fill, armor, name, seen: true };
        this.plates.set(it.id, p);
      }
      p.seen = true;
      p.el.className = `plate ${it.kind}`;
      p.el.style.transform = `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px) translate(-50%, -100%)`;
      p.fill.style.width = `${Math.max(0, Math.min(1, it.hpRatio)) * 100}%`;
      p.armor.style.width = `${Math.max(0, Math.min(1, it.armorRatio)) * 100}%`;
      if (p.name.textContent !== it.name) p.name.textContent = it.name;
    }
    for (const [id, p] of this.plates) {
      if (!p.seen) {
        p.el.remove();
        this.plates.delete(id);
      }
    }
  }

  /** Red arc at the screen edge pointing to where damage came from (radians, screen space). */
  damageFrom(angle: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-dir';
    el.style.transform = `rotate(${angle}rad)`;
    this.dmgEl.appendChild(el);
    this.dmgArcs.push({ el, life: 0.9 });
  }

  hitMarker(kill: boolean): void {
    if (kill) this.killT = 0.35;
    else this.hitT = 0.14;
  }

  /** Crosshair blooms open on each shot of the local player. */
  kick(amount: number): void {
    this.spread = Math.min(1, this.spread + amount);
  }

  showRoomCode(code: string): void {
    this.roomCodeEl.textContent = code;
    this.roomCodePanel.classList.remove('hidden');
  }

  hideRoomCode(): void {
    this.roomCodePanel.classList.add('hidden');
  }

  setRooms(count: number): void {
    this.roomEl.textContent = `КОМНАТА 1 / ${count}`;
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('visible');
  }

  setError(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('visible', 'error');
    window.setTimeout(() => this.statusEl.classList.remove('visible', 'error'), 5000);
  }

  setLatency(ms: number): void {
    this.latencyEl.textContent = `${ms} мс`;
    this.latencyEl.classList.toggle('bad', ms > 140);
  }

  message(text: string, kind: 'info' | 'good' | 'warn' = 'info'): void {
    const el = document.createElement('div');
    el.className = `feed-line ${kind}`;
    el.textContent = text;
    this.feedEl.appendChild(el);
    this.feed.push({ el, life: 4.5 });
    while (this.feed.length > 6) {
      const old = this.feed.shift();
      old?.el.remove();
    }
  }

  update(state: HudState): void {
    const hpRatio = Math.max(0, state.hp / state.maxHp);
    this.hpFill.style.width = `${hpRatio * 100}%`;
    this.hpFill.classList.toggle('critical', hpRatio < 0.3);
    this.hpText.textContent = state.alive ? `${Math.ceil(state.hp)}` : '—';

    if (isArena(this.mode)) {
      const me = state.scores.find((s) => s.isLocal);
      const lead = state.scores[0];
      const clock = (sec: number) => {
        const t = Math.max(0, Math.ceil(sec));
        return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      };
      const leader = lead && !lead.isLocal ? lead.name.toUpperCase() : 'ВЫ';
      if (this.mode === 'comp') {
        const r = state.round;
        const phase = !r ? '' : r.phase === 'freeze' ? `ПРИГОТОВЬТЕСЬ ${Math.ceil(r.t)}` : r.phase === 'live' ? clock(r.t) : 'РАУНД ОКОНЧЕН';
        this.objectiveEl.textContent = `РАУНД ${r?.n ?? 1} · ${phase} · ПОБЕД ${me?.rounds ?? 0}/${ROUNDS_TO_WIN} · ЛИДЕР ${leader}`;
      } else if (this.mode === 'gun') {
        this.objectiveEl.textContent = `${clock(state.timeLeft)} · СТУПЕНЬ ${state.tier + 1}/${GUN_LADDER.length} · ЛИДЕР ${leader}`;
      } else {
        this.objectiveEl.textContent =
          `${clock(state.timeLeft)} · ФРАГИ ${me?.kills ?? 0}/${FRAG_LIMIT}` + (lead && !lead.isLocal ? ` · ЛИДЕР ${leader} ${lead.kills}` : ' · ВЫ ЛИДИРУЕТЕ');
      }
      const key = state.scores.map((s) => `${s.name}${s.kills}${s.deaths}${s.rounds}${s.tier}`).join();
      if (key !== this.scoresKey) {
        this.scoresKey = key;
        this.fillScores(this.scoreTable, state.scores);
      }
    } else {
      this.roomEl.textContent = `КОМНАТА ${state.room + 1} / ${state.rooms}`;
      this.objectiveEl.textContent =
        state.phase === 'done'
          ? 'ОБЪЕКТ ЗАЧИЩЕН'
          : state.phase === 'cleared'
            ? 'ДВЕРЬ ОТКРЫТА — ИДИТЕ ДАЛЬШЕ'
            : `ЗАЧИСТИТЕ КОМНАТУ · ОСТАЛОСЬ ${state.enemiesLeft}`;
    }

    // Armor, buffs, carried weapons, respawn banner.
    this.armorFill.style.width = `${Math.min(100, state.armor)}%`;
    this.armorText.textContent = String(Math.ceil(state.armor));
    this.hudRoot().classList.toggle('has-armor', state.armor > 0.5);
    const buffs: [string, string, number, number][] = [
      ['damage', 'УРОН ×1.5', state.buffs.damage, BUFF_TIME.damage],
      ['speed', 'СКОРОСТЬ', state.buffs.speed, BUFF_TIME.speed],
      ['rapid', 'ТЕМП', state.buffs.rapid, BUFF_TIME.rapid],
      ['nv', 'ПНВ', state.buffs.nv, BUFF_TIME.nv],
      ['shield', 'ЗАЩИТА', state.shield, 1.6],
    ];
    const active = buffs.filter((b) => b[2] > 0);
    const bkey = active.map((b) => `${b[0]}${Math.ceil(b[2] * 4)}`).join();
    if (bkey !== this.buffsKey) {
      this.buffsKey = bkey;
      this.buffsEl.innerHTML = active
        .map(([k, label, t, max]) => `<span class="buff buff-${k}"><i style="width:${Math.min(100, (t / max) * 100)}%"></i>${label} ${Math.ceil(t)}</span>`)
        .join('');
    }
    const skey = `${state.weapons.join()}|${state.weapon}`;
    if (skey !== this.slotsKey) {
      this.slotsKey = skey;
      this.slotsEl.innerHTML = WEAPON_ORDER.map((w, i) => {
        const cls = w === state.weapon ? 'active' : state.weapons.includes(w) ? 'owned' : '';
        return `<span class="${cls}"><b>${i + 1}</b>${WEAPON_LABEL[w]}</span>`;
      }).join('');
    }
    this.respawnEl.classList.toggle('visible', !state.alive);
    this.respawnEl.textContent = state.respawnIn > 0 ? `ВОЗРОЖДЕНИЕ ЧЕРЕЗ ${Math.ceil(state.respawnIn)}` : 'ВЫ ВЫБЫЛИ · ВОЗРОЖДЕНИЕ…';

    this.weaponEl.textContent = WEAPON_LABEL[state.weapon];
    this.ammoEl.textContent = state.alive ? String(state.ammo) : '—';
    this.magEl.textContent = `/${state.mag}`;
    this.reloadEl.classList.toggle('active', state.reloading);
    this.crosshair.classList.toggle('reloading', state.reloading);
    this.updatePips(state.alive ? state.ammo : 0, state.mag, state.reloading);
    this.flashEl.classList.toggle('off', !state.flashOn);
    this.flashEl.textContent = state.flashOn ? 'ФОНАРЬ ВКЛ · ВАС ВИДНО' : 'ФОНАРЬ ВЫКЛ · СКРЫТНО';
    // Flashed: the screen whites out, clearing over the last second.
    this.flashOverlay.style.opacity = String(Math.min(1, state.blind / 1.1));
    this.gaitEl.className = `gait-tag ${state.gait}`;
    this.gaitEl.textContent = GAIT_LABEL[state.gait];
    // Eased so the crosshair breathes rather than jumps between stances.
    this.baseSpread += (state.spread - this.baseSpread) * 0.2;

    // Under the ammo: grenades, flashlight, money.
    const money = this.mode === 'comp' ? `<span class="money">$${state.money}</span>` : '';
    const kinds: [GrenadeKind, number, string][] = [
      ['frag', state.grenades, 'осколочная'],
      ['smoke', state.smokes, 'дымовая'],
      ['flash', state.flashes, 'светошумовая'],
    ];
    const groups = kinds
      .map(([k, n, title]) => {
        const sel = k === state.nadeKind ? ' sel' : '';
        return `<em class="nade ${k}${sel}" title="${title}">${n > 0 ? '<i></i>'.repeat(n) : '<s>0</s>'}</em>`;
      })
      .join('');
    const nades = `<span class="nades">${groups}<kbd>Q</kbd><kbd>G</kbd></span>`;
    const light = `<span class="light${state.flashOn ? ' on' : ''}"><kbd>F</kbd>${state.flashOn ? 'свет' : 'тьма'}</span>`;
    const extra = `${money}${nades}${light}`;
    if (this.extraEl.innerHTML !== extra) this.extraEl.innerHTML = extra;

    // Gun game ladder.
    if (this.mode === 'gun') {
      const lkey = `${state.tier}|${state.tierKills}`;
      if (lkey !== this.ladderKey) {
        this.ladderKey = lkey;
        this.ladderEl.innerHTML = GUN_LADDER.map((_w, i) => {
          const cls = i < state.tier ? 'done' : i === state.tier ? 'now' : '';
          const pips = i === state.tier ? `<u>${'<i class="on"></i>'.repeat(state.tierKills)}${'<i></i>'.repeat(KILLS_PER_TIER - state.tierKills)}</u>` : '';
          return `<span class="${cls}">${LADDER_LABEL[i]}${pips}</span>`;
        }).join('<em>›</em>');
      }
    }

    // Rebuild the squad list only when it changes (it ran every frame).
    const squadKey = state.players.map((p) => `${p.name}|${Math.ceil(p.hp)}|${p.alive}`).join(';');
    if (squadKey !== this.squadKey) {
      this.squadKey = squadKey;
      this.renderSquad(state.players);
    }

    if (state.hp < this.lastHp - 0.5) this.vignetteLife = 0.45;
    this.lastHp = state.hp;
  }

  private renderSquad(players: HudPlayer[]): void {
    this.squadEl.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = `squad-row${p.alive ? '' : ' down'}${p.isLocal ? ' local' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'squad-dot';
      dot.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'squad-name';
      name.textContent = p.name;
      const bar = document.createElement('span');
      bar.className = 'squad-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, (p.hp / p.maxHp) * 100)}%`;
      fill.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
      bar.appendChild(fill);
      row.append(dot, name, bar);
      this.squadEl.appendChild(row);
    }
  }

  private updatePips(ammo: number, mag: number, reloading: boolean): void {
    const key = `${ammo}/${mag}/${reloading}`;
    if (key === this.pipsKey) return;
    this.pipsKey = key;
    this.pipsEl.style.display = mag > 40 ? 'none' : '';
    this.pipsEl.classList.toggle('low', ammo <= Math.ceil(mag * 0.25));
    let html = '';
    for (let i = 0; i < mag; i++) html += i < ammo && !reloading ? '<i></i>' : '<i class="spent"></i>';
    this.pipsEl.innerHTML = html;
  }

  tick(dt: number): void {
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.bannerEl.classList.remove('visible');
    }
    for (let i = this.kills.length - 1; i >= 0; i--) {
      const k = this.kills[i];
      k.life -= dt;
      if (k.life <= 0) {
        k.el.remove();
        this.kills.splice(i, 1);
      } else if (k.life < 1) k.el.style.opacity = String(k.life);
    }
    for (let i = this.dmgArcs.length - 1; i >= 0; i--) {
      const a = this.dmgArcs[i];
      a.life -= dt;
      if (a.life <= 0) {
        a.el.remove();
        this.dmgArcs.splice(i, 1);
      } else {
        a.el.style.opacity = String(Math.min(1, a.life * 2));
      }
    }
    this.hitT = Math.max(0, this.hitT - dt);
    this.killT = Math.max(0, this.killT - dt);
    this.crosshair.classList.toggle('hit', this.hitT > 0);
    this.crosshair.classList.toggle('kill', this.killT > 0);
    this.spread = Math.max(0, this.spread - dt * 3.5);
    const size = 30 * clamp(this.baseSpread, 0.5, 2.4) + this.spread * 26;
    this.crosshair.style.width = `${size}px`;
    this.crosshair.style.height = `${size}px`;

    for (let i = this.feed.length - 1; i >= 0; i--) {
      const entry = this.feed[i];
      entry.life -= dt;
      if (entry.life <= 0) {
        entry.el.remove();
        this.feed.splice(i, 1);
      } else if (entry.life < 1) {
        entry.el.style.opacity = String(entry.life);
      }
    }
    if (this.vignetteLife > 0) {
      this.vignetteLife -= dt;
      this.vignette.style.opacity = String(Math.min(0.75, this.vignetteLife * 1.6));
    } else {
      this.vignette.style.opacity = '0';
    }
  }

  moveCrosshair(x: number, y: number): void {
    this.crosshair.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  showGameOver(win: boolean, text: string, title?: string, scores: HudScore[] | null = null): void {
    this.overTitle.textContent = title ?? (win ? 'ОБЪЕКТ ЗАЧИЩЕН' : 'ОПЕРАЦИЯ ПРОВАЛЕНА');
    if (scores) this.fillScores(this.overScores, scores);
    this.overScores.style.display = scores ? '' : 'none';
    this.overTitle.classList.toggle('win', win);
    this.overText.textContent = text;
    this.overEl.classList.add('visible');
  }

  hideGameOver(): void {
    this.overEl.classList.remove('visible');
  }

  /** Show the pause overlay. */
  showPause(): void {
    this.pauseEl.classList.add('visible');
  }

  /** Hide the pause overlay. */
  hidePause(): void {
    this.pauseEl.classList.remove('visible');
  }

  drawMinimap(
    map: MapData,
    actors: { id: number; kind: string; x: number; z: number; ang: number; alive: boolean }[],
    localId: number,
    activeRoom: RoomDef | undefined,
  ): void {
    const ctx = this.minimapCtx;
    const w = this.minimap.width;
    const h = this.minimap.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(0, 0, w, h);

    const spanX = map.maxX - map.minX;
    const spanZ = map.maxZ - map.minZ;
    const scale = Math.min(w / spanX, h / spanZ);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanZ * scale) / 2;
    const px = (x: number) => ox + (x - map.minX) * scale;
    const pz = (z: number) => oy + (z - map.minZ) * scale;

    if (activeRoom) {
      ctx.fillStyle = 'rgba(255, 176, 102, 0.09)';
      ctx.fillRect(px(activeRoom.minX), pz(activeRoom.minZ), (activeRoom.maxX - activeRoom.minX) * scale, (activeRoom.maxZ - activeRoom.minZ) * scale);
    }

    const tile = map.tile * scale;
    for (let z = 0; z < map.gridH; z++) {
      for (let x = 0; x < map.gridW; x++) {
        const v = map.cells[z * map.gridW + x];
        if (v === 1) ctx.fillStyle = '#1b2029';
        else if (v === 2) ctx.fillStyle = '#39414f';
        else continue;
        ctx.fillRect(ox + x * tile, oy + z * tile, tile + 0.5, tile + 0.5);
      }
    }

    for (const a of actors) {
      if (!a.alive) continue;
      const isPlayer = a.kind === 'player';
      const isLocal = a.id === localId;
      ctx.beginPath();
      if (isLocal) {
        ctx.moveTo(px(a.x) + Math.cos(a.ang) * 5.5, pz(a.z) + Math.sin(a.ang) * 5.5);
        ctx.lineTo(px(a.x) + Math.cos(a.ang + 2.5) * 4, pz(a.z) + Math.sin(a.ang + 2.5) * 4);
        ctx.lineTo(px(a.x) + Math.cos(a.ang - 2.5) * 4, pz(a.z) + Math.sin(a.ang - 2.5) * 4);
        ctx.closePath();
        ctx.fillStyle = '#3fd6c8';
        ctx.fill();
      } else {
        ctx.arc(px(a.x), pz(a.z), isPlayer ? 3 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = isPlayer ? '#ffb545' : '#e05268';
        ctx.fill();
      }
    }
  }
}

const FRAG_LIMIT = CONFIG.dm.fragLimit;
const ROUNDS_TO_WIN = CONFIG.comp.roundsToWin;
const KILLS_PER_TIER = CONFIG.gun.killsPerTier;
const LADDER_LABEL = GUN_LADDER.map((w) => ({ pistol: 'M9', smg: 'ПП', shotgun: 'ДРОБ.', rifle: 'ВИНТ.', sniper: 'СНАЙП.' })[w]);
const BUFF_TIME = {
  damage: CONFIG.powerups.damageTime,
  speed: CONFIG.powerups.speedTime,
  rapid: CONFIG.powerups.rapidTime,
  nv: CONFIG.powerups.nvTime,
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function must(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`HUD element not found: ${selector}`);
  return el;
}

const GAIT_LABEL: Record<Gait, string> = {
  run: 'БЕГ · СЛЫШНО',
  walk: 'ШАГ · ТИХО',
  crouch: 'ПРИСЕД · БЕСШУМНО',
};
