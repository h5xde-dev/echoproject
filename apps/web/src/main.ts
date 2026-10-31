import './styles.css';
import { Game } from './game/game';
import { Hud } from './ui/hud';
import { loadSettings, saveSettings, type Settings } from './ui/settings';
import { levelOf, loadProgress, RING_COLORS } from './ui/progress';
import { assets } from './render/assets';
import { ARENAS, arenaGrid } from '@echo/shared/game/arenas';
import { modeInfo } from '@echo/shared/game/modes';
import type { GameMode } from '@echo/shared/game/types';
import { fetchAccount, importProgress, logout, rename, saveProfile, type Account } from './ui/account';
import { fetchPublicRooms, inviteLink } from './net/meta';
import { fetchQuests, QuestsPanel, renderQuestBox, type QuestsData } from './ui/quests';
import { classCard, HelpPanel } from './ui/help';

const viewport = must<HTMLElement>('#viewport');
const hudRoot = must<HTMLElement>('#hud');
const menu = must<HTMLElement>('#menu');
const roomResult = must<HTMLElement>('#room-result');
const roomCodeValue = must<HTMLElement>('#room-code-value');
const nameInput = must<HTMLInputElement>('#player-name');
const codeInput = must<HTMLInputElement>('#room-code');
const btnSolo = must<HTMLButtonElement>('#btn-solo');
const btnHost = must<HTMLButtonElement>('#btn-host');
const btnQuick = must<HTMLButtonElement>('#btn-quick');
const btnJoin = must<HTMLButtonElement>('#btn-join');
const btnRanked = must<HTMLButtonElement>('#btn-ranked');
const rankedQueue = must<HTMLElement>('#ranked-queue');
const accountBox = must<HTMLElement>('.account');
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
    for (const b of [btnSolo, btnQuick, btnHost, btnJoin, btnRanked]) b.disabled = false;
    assetsReady = true;
    joinFromLink();
    game.audio.setSamples(assets.sounds);
  });

let assetsReady = false;
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
  duel: '1v1 с другом по коду комнаты',
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
  document.querySelector('.room-bots')?.classList.toggle('hidden', mode === 'waves');
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
              : 'hrxsfnagiuz'.includes(ch) ? '#5dff8a'
              : 'GO+'.includes(ch) ? '#ffd04a'
                : '|-'.includes(ch) ? '#8a6a44'
                  : ch === 'W' ? '#9aa0a6'
                    : ch === '=' || ch === 'o' ? '#2a2216'
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

// One UI scale for the HUD and the menus: 1 at 1600x900, up to 2.2 on 4K, down
// to 0.8 on small laptops. CSS reads --ui (styles.css, "UI scale").
function applyUiScale(): void {
  const scale = Math.min(2.2, Math.max(0.8, Math.min(innerWidth / 1600, innerHeight / 900)));
  document.documentElement.style.setProperty('--ui', scale.toFixed(3));
  hud.uiScale = scale;
}
applyUiScale();
window.addEventListener('resize', applyUiScale);

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
  hideQueue();
  void refreshAccount();
  menu.classList.remove('hidden');
  hudRoot.classList.add('hidden');
  roomResult.classList.add('hidden');
  codeInput.value = '';
  nameInput.focus();
  nameInput.select();
}

// Help: from the menu and from the pause overlay.
const help = new HelpPanel();
must<HTMLButtonElement>('.btn-help').addEventListener('click', () => help.open());
must<HTMLButtonElement>('.pause-help').addEventListener('click', () => help.open('controls'));

// Escape opens the pause overlay; the second Escape closes it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (help.isOpen) {
    e.preventDefault();
    help.close();
    return;
  }
  if (questsPanel.isOpen) {
    e.preventDefault();
    questsPanel.close();
    return;
  }
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
const setControls = must<HTMLSelectElement>('.set-controls');
const setShake = must<HTMLInputElement>('.set-shake');
const setStats = must<HTMLInputElement>('.set-stats');
function applySettings(): void {
  game.audio.setVolume(settings.volume);
  game.renderer.setQuality(settings.quality);
  game.renderer.shakeScale = settings.shake ? 1 : 0;
  game.controls = settings.controls;
  hud.showStats(settings.stats);
}
setVolume.value = String(Math.round(settings.volume * 100));
setQuality.value = settings.quality;
setControls.value = settings.controls;
setControls.addEventListener('change', () => {
  settings.controls = setControls.value === 'screen' ? 'screen' : 'aim';
  game.controls = settings.controls;
  saveSettings(settings);
  syncProfile();
});
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

// Lags on a weak machine: first fewer pixels, then no shadows. Each step is
// remembered (the shadows one through the quality setting) and said once.
let lightened = false;
game.onSlowFrames = () => {
  // At density 1 already (a big screen), go below it: still sharper than no shadows.
  if (!lightened && (game.renderer.capPixelRatio(1) || game.renderer.capPixelRatio(0.75))) {
    lightened = true;
    hud.message('Игра тормозит — снижено разрешение отрисовки', 'warn');
    return;
  }
  lightened = true;
  if (settings.quality === 'high') {
    settings.quality = 'low';
    setQuality.value = 'low';
    game.renderer.setQuality('low');
    saveSettings(settings);
    hud.message('Игра тормозит — тени выключены (вернуть: пауза → Графика)', 'warn');
  }
};

// Bot difficulty (menu), remembered with the other settings.
const diffButtons = document.querySelectorAll<HTMLButtonElement>('.diff-btn[data-difficulty]');
const showDifficulty = () => diffButtons.forEach((b) => b.classList.toggle('active', b.dataset.difficulty === settings.difficulty));
diffButtons.forEach((b) =>
  b.addEventListener('click', () => {
    settings.difficulty = (b.dataset.difficulty as Settings['difficulty']) ?? 'normal';
    saveSettings(settings);
    syncProfile();
    showDifficulty();
  }),
);
showDifficulty();

// Class (menu), remembered too; applied when a game starts or is joined.
const clsButtons = document.querySelectorAll<HTMLButtonElement>('.cls-btn');
const clsCardEl = must<HTMLElement>('.cls-card');
const showClass = () => {
  clsButtons.forEach((b) => b.classList.toggle('active', b.dataset.cls === settings.cls));
  game.playerClass = settings.cls;
  clsCardEl.innerHTML = settings.cls ? classCard(settings.cls) : '';
};
clsButtons.forEach((b) =>
  b.addEventListener('click', () => {
    settings.cls = (b.dataset.cls as Settings['cls']) ?? 'assault';
    saveSettings(settings);
    syncProfile();
    showClass();
  }),
);
showClass();

// Rooms you host: bots on or off (on: they join once a second player is in).
const roomBotsInput = must<HTMLInputElement>('.room-bots-input');
roomBotsInput.checked = settings.roomBots;
roomBotsInput.addEventListener('change', () => {
  settings.roomBots = roomBotsInput.checked;
  saveSettings(settings);
  syncProfile();
});

// Rank and ring colours: level from the account's experience when signed in
// (the server counts it), otherwise from what this browser banked.
const ringBox = must<HTMLElement>('.ring-colors');
/** The signed-in account (null: a guest). Filled by refreshAccount below. */
let account: Account | null = null;
function currentXp(): number {
  return account ? account.xp : loadProgress().xp;
}
function refreshRank(): void {
  const lvl = levelOf(currentXp());
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
      syncProfile();
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
    const code = await game.createRoom(playerName(), { mode: matchMode, arena, fighters, difficulty: settings.difficulty, bots: settings.roomBots });
    roomCodeValue.textContent = code;
    roomResult.classList.remove('hidden');
    hud.showRoomCode(code);
  } catch (err) {
    game.returnToMenu();
    showError(err instanceof Error ? err.message : 'Не удалось открыть комнату');
  } finally {
    btnHost.disabled = !assetsReady;
    btnHost.querySelector('.btn-title')!.textContent = 'СОЗДАТЬ КОМНАТУ';
  }
});

btnJoin.addEventListener('click', async () => {
  game.audio.init();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 5) {
    showError('Введите код комнаты (5 символов)');
    return;
  }
  btnJoin.disabled = true;
  btnJoin.querySelector('.btn-title')!.textContent = 'ПОДКЛЮЧАЕМ...';
  try {
    await game.joinRoom(playerName(), code);
    hud.showRoomCode(code);
  } catch (err) {
    game.returnToMenu();
    showError(err instanceof Error ? err.message : 'Не удалось подключиться');
  } finally {
    btnJoin.disabled = !assetsReady;
    btnJoin.querySelector('.btn-title')!.textContent = 'ВОЙТИ';
  }
});

// Online: the menu gives way only once the server sent the map (no black screen).
game.onMatchStart = () => {
  hideQueue();
  enterGame();
};
game.onFailed = (text) => {
  backToMenu();
  showError(text);
};
game.onProgressSaved = (xp) => {
  if (account) account.xp = xp;
};
// Game over: solo plays again with the same choices; a room host starts a new
// match for everyone; ranked queues again.
hud.onPlayAgain = () => {
  if (game.playAgain()) return;
  const wasRanked = game.ranked;
  const wasSolo = game.mode === 'solo';
  backToMenu();
  if (wasSolo) btnSolo.click();
  else if (wasRanked) btnRanked.click();
};

// ---------------------------------------------------------------- account & ranked


async function refreshAccount(): Promise<void> {
  const { user, available } = await fetchAccount();
  account = user;
  game.signedIn = !!user;
  if (user && !user.imported) {
    // First time signed in on this browser: the guest experience joins the account once.
    const local = loadProgress();
    if (local.xp > 0) {
      const merged = await importProgress(local.xp, local.matches);
      if (merged) account = merged;
    }
  }
  if (account) applyProfile(account);
  refreshRank();
  void refreshQuests();
  // No game server (a static preview): no login, no ranked play.
  accountBox.classList.toggle('hidden', !available);
  btnRanked.classList.toggle('hidden', !available);
  accountBox.querySelector('.btn-yandex')!.classList.toggle('hidden', !!user);
  const box = accountBox.querySelector<HTMLElement>('.account-user')!;
  box.classList.toggle('hidden', !user);
  if (user) {
    box.querySelector('.account-name')!.textContent = user.name;
    box.querySelector('.account-rating')!.textContent = `РЕЙТИНГ ${user.rating}${user.rank ? ` · #${user.rank}` : ''} · БОЁВ ${user.games}`;
    const img = box.querySelector<HTMLImageElement>('.account-avatar')!;
    img.src = user.avatar || '/logo.svg';
    nameInput.value = user.name;
  }
  btnRanked.querySelector('.btn-desc')!.textContent = user ? 'Онлайн-арена, только люди, рейтинг Эло' : 'Войдите через Яндекс, чтобы играть на рейтинг';
}

accountBox.querySelector('.account-logout')!.addEventListener('click', async () => {
  await logout();
  await refreshAccount();
});

// Signed in, the call sign is the account's: changing it renames the account.
nameInput.addEventListener('change', async () => {
  if (!account) return;
  const name = await rename(playerName());
  if (name) {
    account.name = name;
    nameInput.value = name;
  }
});

if (new URLSearchParams(location.search).get('login') === 'failed') showError('Не удалось войти через Яндекс. Попробуйте ещё раз.');
void refreshAccount();

function showQueue(text: string, hint?: string): void {
  rankedQueue.classList.remove('hidden');
  rankedQueue.querySelector('.ranked-count')!.textContent = text;
  if (hint) rankedQueue.querySelector('.ranked-hint')!.textContent = hint;
}

function hideQueue(): void {
  rankedQueue.classList.add('hidden');
  btnRanked.disabled = !assetsReady;
}

game.onQueue = (msg) => {
  if (msg.state === 'queue') {
    showQueue(`${msg.players ?? 1} / ${msg.need ?? 2}`, msg.startIn !== undefined && msg.startIn >= 0 ? `Бой начнётся через ${msg.startIn} с — ждём ещё соперников.` : 'Ждём соперников. Deathmatch на сервере: без ботов, итог меняет рейтинг.');
  } else if (msg.state === 'found') {
    showQueue('БОЙ НАЙДЕН', `${msg.players ?? 2} игроков · загружаем арену…`);
  }
};

btnRanked.addEventListener('click', async () => {
  if (!account) {
    location.href = '/auth/yandex?next=/play';
    return;
  }
  game.audio.init();
  btnRanked.disabled = true;
  showQueue('…', 'Подключаемся к серверу…');
  try {
    await game.startRanked(account.name);
  } catch (err) {
    hideQueue();
    game.returnToMenu();
    if (!(err instanceof Error && err.message === 'cancelled')) showError(err instanceof Error ? err.message : 'Сервер недоступен');
  }
});

rankedQueue.querySelector('.ranked-cancel')!.addEventListener('click', () => {
  game.cancelQueue();
  game.returnToMenu();
  hideQueue();
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
  const link = inviteLink(code);
  void copyText(link).then((ok) =>
    ok
      ? hud.message('Ссылка-приглашение скопирована — отправьте её другу', 'good')
      : hud.message(`Не удалось скопировать, ссылка: ${link}`, 'warn'),
  );
});
must<HTMLButtonElement>('.room-link').addEventListener('click', () => {
  const code = roomCodeValue.textContent ?? '';
  if (code && code !== '-----') void copyText(inviteLink(code)).then((ok) => ok && showError('Ссылка скопирована — отправьте её другу'));
});

// ---------------------------------------------------------------- quick play and open rooms

btnQuick.addEventListener('click', async () => {
  game.audio.init();
  btnQuick.disabled = true;
  btnQuick.querySelector('.btn-title')!.textContent = 'ИЩЕМ БОЙ...';
  try {
    await game.quickPlay(playerName(), matchMode);
    hud.showRoomCode(game.roomCode);
  } catch (err) {
    game.returnToMenu();
    showError(err instanceof Error ? err.message : 'Сервер недоступен');
  } finally {
    btnQuick.disabled = !assetsReady;
    btnQuick.querySelector('.btn-title')!.textContent = 'БЫСТРАЯ ИГРА';
  }
});

const openRoomsList = must<HTMLElement>('.open-rooms-list');
const openRoomsCount = must<HTMLElement>('.open-rooms-count');
async function refreshOpenRooms(): Promise<void> {
  if (menu.classList.contains('hidden') || document.visibilityState !== 'visible') return;
  const rooms = await fetchPublicRooms();
  openRoomsCount.textContent = rooms.length ? `${rooms.reduce((n, r) => n + r.players, 0)} в игре` : '';
  openRoomsList.innerHTML = '';
  if (rooms.length === 0) {
    openRoomsList.innerHTML = '<div class="open-rooms-empty">Пока никого — нажмите «Быстрая игра», и комната появится здесь.</div>';
    return;
  }
  for (const r of rooms.slice(0, 8)) {
    const row = document.createElement('button');
    row.className = 'open-room';
    row.disabled = r.players >= r.max || !assetsReady;
    const arenaName = ARENAS.find((a) => a.id === r.arena)?.name ?? '';
    row.innerHTML = `<b>${modeInfo(r.mode).title}</b><span>${r.mode === 'coop' || r.mode === 'waves' ? 'объект' : arenaName}</span><em>${r.players}/${r.max}</em>`;
    row.addEventListener('click', () => {
      codeInput.value = r.code;
      btnJoin.click();
    });
    openRoomsList.appendChild(row);
  }
}
void refreshOpenRooms();
window.setInterval(() => void refreshOpenRooms(), 5000);

/** /play?room=CODE: a friend's invite drops the player straight into that room. */
function joinFromLink(): void {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') ?? '').trim().toUpperCase();
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  codeInput.value = code;
  btnJoin.click();
}

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

// ---------------------------------------------------------------- profile on the account

/** Signed in: class, ring colour, difficulty and the bots switch come from the account. */
function applyProfile(a: Account): void {
  const p = a.settings ?? {};
  if (p.cls) settings.cls = p.cls;
  if (typeof p.color === 'number') settings.color = p.color;
  if (p.difficulty) settings.difficulty = p.difficulty;
  if (typeof p.roomBots === 'boolean') settings.roomBots = p.roomBots;
  if (p.controls === 'aim' || p.controls === 'screen') {
    settings.controls = p.controls;
    setControls.value = p.controls;
    game.controls = p.controls;
  }
  saveSettings(settings);
  roomBotsInput.checked = settings.roomBots;
  showClass();
  showDifficulty();
}

let profileTimer = 0;
/** Saves the profile to the account a moment after the last change. */
function syncProfile(): void {
  if (!account) return;
  window.clearTimeout(profileTimer);
  profileTimer = window.setTimeout(() => {
    // The whole profile goes each time: camouflage and badge too.
    void saveProfile({ cls: settings.cls, color: settings.color, difficulty: settings.difficulty, roomBots: settings.roomBots, controls: settings.controls, camo: cosmetics.camo, badge: cosmetics.badge });
  }, 600);
}

// ---------------------------------------------------------------- quests and cosmetics

const questsBox = must<HTMLElement>('.quests-box');
const questsPanel = new QuestsPanel();
let quests: QuestsData | null = null;
/** The camouflage and badge on the account (the API keeps only owned ones). */
let cosmetics: { camo?: string; badge?: string } = {};

async function refreshQuests(): Promise<void> {
  quests = account ? await fetchQuests() : null;
  cosmetics = { camo: account?.settings?.camo, badge: account?.settings?.badge };
  renderQuestBox(questsBox, quests, !!account);
  questsBox.querySelector('.quests-open')?.addEventListener('click', () => {
    if (quests) questsPanel.open(quests, cosmetics);
  });
}

questsPanel.onPick = (kind, id) => {
  if (!account || !quests) return;
  cosmetics = { ...cosmetics, [kind]: id };
  account.settings = { ...account.settings, [kind]: id };
  void saveProfile({ ...account.settings, cls: settings.cls, color: settings.color, difficulty: settings.difficulty, roomBots: settings.roomBots, controls: settings.controls });
  questsPanel.render(quests, cosmetics);
};
