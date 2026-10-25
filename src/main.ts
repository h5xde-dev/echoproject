import './styles.css';
import { Game } from './game/game';
import { Hud } from './ui/hud';
import { loadSettings, saveSettings, type Settings } from './ui/settings';
import { levelOf, loadProgress, RING_COLORS } from './ui/progress';
import { assets } from './render/assets';
import { ARENAS, arenaGrid } from './game/arenas';
import { modeInfo } from './game/modes';
import type { GameMode } from './game/types';

const viewport = must<HTMLElement>('#viewport');
const hudRoot = must<HTMLElement>('#hud');
const menu = must<HTMLElement>('#menu');
const roomResult = must<HTMLElement>('#room-result');
const roomCodeValue = must<HTMLElement>('#room-code-value');
const nameInput = must<HTMLInputElement>('#player-name');
const codeInput = must<HTMLInputElement>('#room-code');
const btnSolo = must<HTMLButtonElement>('#btn-solo');
const btnHost = must<HTMLButtonElement>('#btn-host');
const btnJoin = must<HTMLButtonElement>('#btn-join');
const roomPanel = must<HTMLElement>('.panel-room');

const loadingFill = must<HTMLElement>('#loading-fill');
const loadingText = must<HTMLElement>('#loading-text');
const loadingBox = must<HTMLElement>('#loading');

// Models and textures must be in before the first map is built.
void assets
  .load((f) => {
    loadingFill.style.width = `${Math.round(f * 100)}%`;
    loadingText.textContent = `Загрузка снаряжения… ${Math.round(f * 100)}%`;
  })
  .then(() => {
    loadingBox.classList.add('done');
    for (const b of [btnSolo, btnHost, btnJoin]) b.disabled = false;
    game.audio.setSamples(assets.sounds);
  });

const hud = new Hud(hudRoot);

// Mode, arena and head-count pickers (the host decides; joiners get the host's).
let matchMode: GameMode = 'coop';
let arena = 'sklad';
let fighters = 6;
const arenaBox = must<HTMLElement>('.arena-select');
const detailTitle = must<HTMLElement>('.mode-detail-title');
const detailDesc = must<HTMLElement>('.mode-detail-desc');
const preview = must<HTMLCanvasElement>('.arena-preview');
const fightersRange = must<HTMLInputElement>('.fighters-range');
const fightersValue = must<HTMLElement>('.fighters-value');

const SOLO_DESC: Record<GameMode, string> = {
  coop: 'Пройти объект в одиночку',
  dm: 'Арена против ботов',
  gun: 'Гонка против ботов',
  comp: 'Раунды против ботов',
  tdm: 'Ваша команда с ботами против ботов',
  waves: 'Продержаться как можно дольше',
  ctf: 'Ваша команда с ботами против ботов',
  bomb: 'Ваша команда с ботами против ботов',
};

function selectMode(mode: GameMode): void {
  matchMode = mode;
  const info = modeInfo(mode);
  document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  detailTitle.textContent = info.title;
  detailDesc.textContent = info.desc;
  arenaBox.classList.toggle('hidden', !info.arena);
  // Waves bring their own guards: the head count does not apply.
  fightersRange.closest('.fighters')?.classList.toggle('hidden', mode === 'waves');
  btnSolo.querySelector('.btn-desc')!.textContent = SOLO_DESC[mode];
  if (info.arena) drawPreview();
}

/** Arena thumbnail straight from its layout grid. */
function drawPreview(): void {
  const info = ARENAS.find((a) => a.id === arena) ?? ARENAS[0];
  const grid = arenaGrid(info);
  const ctx = preview.getContext('2d')!;
  const w = preview.width;
  const h = preview.height;
  const cell = Math.min(w / grid[0].length, h / grid.length);
  const ox = (w - grid[0].length * cell) / 2;
  const oy = (h - grid.length * cell) / 2;
  ctx.clearRect(0, 0, w, h);
  grid.forEach((row, z) => {
    [...row].forEach((ch, x) => {
      ctx.fillStyle =
        ch === '#' ? '#3a4352'
          : ch === 'S' ? '#3fd6c8'
            : '123456'.includes(ch) ? '#ffb066'
              : 'hrxsfn'.includes(ch) ? '#5dff8a'
                : 'CBKVTPDMAtc'.includes(ch) ? '#26303c'
                  : '#121820';
      ctx.fillRect(ox + x * cell, oy + z * cell, Math.ceil(cell), Math.ceil(cell));
    });
  });
}

document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((btn) => {
  btn.addEventListener('click', () => selectMode((btn.dataset.mode as GameMode) ?? 'coop'));
});
// One button per arena, straight from the arena list.
const arenaList = must<HTMLElement>('.arena-list');
for (const info of ARENAS) {
  const btn = document.createElement('button');
  btn.className = `arena-btn${info.id === arena ? ' active' : ''}`;
  btn.dataset.arena = info.id;
  btn.textContent = info.name;
  btn.addEventListener('click', () => {
    arena = info.id;
    arenaList.querySelectorAll('.arena-btn').forEach((b) => b.classList.toggle('active', b === btn));
    drawPreview();
  });
  arenaList.appendChild(btn);
}
fightersRange.addEventListener('input', () => {
  fighters = Number(fightersRange.value);
  fightersValue.textContent = String(fighters);
});
selectMode('coop');

const game = new Game(viewport, hud);

// Handy for debugging and automated smoke checks.
(window as unknown as { echo: unknown }).echo = { game, hud };

window.addEventListener('mousemove', (e) => hud.moveCrosshair(e.clientX, e.clientY));

// The browser only allows audio to start after a user gesture.
const unlockAudio = () => game.audio.init();
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

function playerName(): string {
  const value = nameInput.value.trim();
  return value.length > 0 ? value : 'оператор';
}

function enterGame(): void {
  menu.classList.add('hidden');
  hudRoot.classList.remove('hidden');
}

/** Leave the session and show the main menu again. */
function backToMenu(): void {
  game.returnToMenu();
  refreshRank();
  menu.classList.remove('hidden');
  hudRoot.classList.add('hidden');
  roomResult.classList.add('hidden');
  codeInput.value = '';
  nameInput.focus();
  nameInput.select();
}

// Escape opens the pause overlay; the second Escape closes it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menu.classList.contains('hidden')) return;
  if (!game.inSession) return;
  e.preventDefault();
  if (game.isPaused) game.resume();
  else game.pause();
});

hud.onPauseResume = () => game.resume();
// Lobby: the host starts the match, a client toggles ready.
hud.onLobbyAction = () => (game.isHost ? game.startMatch() : game.toggleReady());

// Settings in the pause menu, applied at once and remembered.
const settings = loadSettings();
const setVolume = must<HTMLInputElement>('.set-volume');
const setQuality = must<HTMLSelectElement>('.set-quality');
const setShake = must<HTMLInputElement>('.set-shake');
const setStats = must<HTMLInputElement>('.set-stats');
function applySettings(): void {
  game.audio.setVolume(settings.volume);
  game.renderer.setQuality(settings.quality);
  game.renderer.shakeScale = settings.shake ? 1 : 0;
  hud.showStats(settings.stats);
}
setVolume.value = String(Math.round(settings.volume * 100));
setQuality.value = settings.quality;
setShake.checked = settings.shake;
setStats.checked = settings.stats;
setVolume.addEventListener('input', () => {
  settings.volume = Number(setVolume.value) / 100;
  game.audio.setVolume(settings.volume);
  saveSettings(settings);
});
setQuality.addEventListener('change', () => {
  settings.quality = setQuality.value === 'low' ? 'low' : 'high';
  game.renderer.setQuality(settings.quality);
  saveSettings(settings);
});
setShake.addEventListener('change', () => {
  settings.shake = setShake.checked;
  game.renderer.shakeScale = settings.shake ? 1 : 0;
  saveSettings(settings);
});
setStats.addEventListener('change', () => {
  settings.stats = setStats.checked;
  hud.showStats(settings.stats);
  saveSettings(settings);
});
applySettings();

// Bot difficulty (menu), remembered with the other settings.
const diffButtons = document.querySelectorAll<HTMLButtonElement>('.diff-btn[data-difficulty]');
const showDifficulty = () => diffButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === settings.difficulty));
diffButtons.forEach((b) =>
  b.addEventListener('click', () => {
    settings.difficulty = (b.dataset.difficulty as Settings['difficulty']) ?? 'normal';
    saveSettings(settings);
    showDifficulty();
  }),
);
showDifficulty();

// Class (menu), remembered too; applied when a game starts or is joined.
const clsButtons = document.querySelectorAll<HTMLButtonElement>('.cls-btn');
const showClass = () => {
  clsButtons.forEach((b) => b.classList.toggle('active', b.dataset.cls === settings.cls));
  game.playerClass = settings.cls;
};
clsButtons.forEach((b) =>
  b.addEventListener('click', () => {
    settings.cls = (b.dataset.cls as Settings['cls']) ?? 'assault';
    saveSettings(settings);
    showClass();
  }),
);
showClass();

// Rank and ring colours: level from banked experience, colours it unlocks.
const ringBox = must<HTMLElement>('.ring-colors');
function refreshRank(): void {
  const lvl = levelOf(loadProgress().xp);
  must<HTMLElement>('.rank-level').textContent = `УРОВЕНЬ ${lvl.level}`;
  must<HTMLElement>('.rank-xp').textContent = `${lvl.into} / ${lvl.need} опыта`;
  must<HTMLElement>('.rank-fill').style.width = `${(lvl.into / lvl.need) * 100}%`;
  // A colour only counts once it is unlocked.
  const open = (c: number) => RING_COLORS.some((r) => r.color === c && r.level <= lvl.level);
  if (settings.color >= 0 && !open(settings.color)) settings.color = -1;
  game.playerColor = settings.color;
  ringBox.innerHTML = '';
  for (const r of RING_COLORS) {
    const b = document.createElement('button');
    const locked = r.level > lvl.level;
    b.className = `ring-color${locked ? ' locked' : ''}${r.color === settings.color || (settings.color < 0 && r.level === 1) ? ' active' : ''}`;
    b.style.setProperty('--ring', `#${r.color.toString(16).padStart(6, '0')}`);
    b.title = locked ? `${r.name} — с уровня ${r.level}` : r.name;
    b.disabled = locked;
    b.addEventListener('click', () => {
      settings.color = r.level === 1 ? -1 : r.color;
      saveSettings(settings);
      refreshRank();
    });
    ringBox.appendChild(b);
  }
}
refreshRank();
hud.onPauseMenu = () => backToMenu();

function showError(message: string): void {
  const status = document.createElement('div');
  status.className = 'menu-error';
  status.textContent = message;
  menu.querySelector('.menu-right')?.appendChild(status);
  window.setTimeout(() => status.remove(), 6000);
}

btnSolo.addEventListener('click', () => {
  game.audio.init();
  game.startSolo(playerName(), { mode: matchMode, arena, fighters, difficulty: settings.difficulty });
  enterGame();
});

btnHost.addEventListener('click', async () => {
  game.audio.init();
  btnHost.disabled = true;
  btnHost.querySelector('.btn-title')!.textContent = 'СОЗДАЁМ...';
  try {
    const code = await game.startHost(playerName(), { mode: matchMode, arena, fighters, difficulty: settings.difficulty });
    roomCodeValue.textContent = code;
    roomResult.classList.remove('hidden');
    hud.showRoomCode(code);
    enterGame();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Не удалось открыть комнату');
  } finally {
    btnHost.disabled = false;
    btnHost.querySelector('.btn-title')!.textContent = 'СОЗДАТЬ КОМНАТУ';
  }
});

btnJoin.addEventListener('click', async () => {
  game.audio.init();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    showError('Введите код комнаты (5 символов)');
    return;
  }
  btnJoin.disabled = true;
  btnJoin.querySelector('.btn-title')!.textContent = 'ПОДКЛЮЧАЕМ...';
  try {
    await game.startClient(playerName(), code);
    enterGame();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Не удалось подключиться');
  } finally {
    btnJoin.disabled = false;
    btnJoin.querySelector('.btn-title')!.textContent = 'ВОЙТИ';
  }
});

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSolo.click();
});

// Input listens for mousedown on the window: without this a click on the
// panel would also fire the weapon.
roomPanel.addEventListener('mousedown', (e) => e.stopPropagation());
roomPanel.addEventListener('click', () => {
  const code = roomPanel.querySelector('.room-code-inline')?.textContent ?? '';
  if (!code || code === '-----') return;
  void copyText(code).then((ok) =>
    ok
      ? hud.message('Код скопирован в буфер обмена', 'good')
      : hud.message(`Не удалось скопировать, код: ${code}`, 'warn'),
  );
});

/** Clipboard API where available (secure contexts), else the legacy copy command. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}
