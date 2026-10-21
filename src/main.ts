import './styles.css';
import { Game } from './game/game';
import { Hud } from './ui/hud';
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
            : '1234'.includes(ch) ? '#ffb066'
              : 'hrxsf'.includes(ch) ? '#5dff8a'
                : 'CBKVTPDMAtc'.includes(ch) ? '#26303c'
                  : '#121820';
      ctx.fillRect(ox + x * cell, oy + z * cell, Math.ceil(cell), Math.ceil(cell));
    });
  });
}

document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((btn) => {
  btn.addEventListener('click', () => selectMode((btn.dataset.mode as GameMode) ?? 'coop'));
});
document.querySelectorAll<HTMLButtonElement>('.arena-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    arena = btn.dataset.arena ?? 'sklad';
    document.querySelectorAll('.arena-btn').forEach((b) => b.classList.toggle('active', b === btn));
    drawPreview();
  });
});
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

function showError(message: string): void {
  const status = document.createElement('div');
  status.className = 'menu-error';
  status.textContent = message;
  menu.querySelector('.menu-right')?.appendChild(status);
  window.setTimeout(() => status.remove(), 6000);
}

btnSolo.addEventListener('click', () => {
  game.audio.init();
  game.startSolo(playerName(), { mode: matchMode, arena, fighters });
  enterGame();
});

btnHost.addEventListener('click', async () => {
  game.audio.init();
  btnHost.disabled = true;
  btnHost.querySelector('.btn-title')!.textContent = 'СОЗДАЁМ...';
  try {
    const code = await game.startHost(playerName(), { mode: matchMode, arena, fighters });
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

roomPanel.addEventListener('click', () => {
  const code = roomPanel.querySelector('.room-code-inline')?.textContent ?? '';
  if (!code || code === '-----') return;
  void navigator.clipboard?.writeText(code);
  hud.message('Код скопирован в буфер обмена', 'good');
});

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}
