export const TILE = 3.0;

export const CONFIG = {
  /** Fixed simulation timestep. */
  tickRate: 60,
  tickDt: 1 / 60,

  /** Host -> client snapshot rate. */
  snapshotRate: 20,

  /** Render interpolation delay for remote entities. */
  interpDelayMs: 110,
  /** Most a client's shot is fast-forwarded on the host (seconds). */
  lagCompMax: 0.15,

  /** Run (default), walk (Shift) and crouch (C). */
  gait: {
    speed: { run: 1, walk: 0.55, crouch: 0.38 },
    /** Footstep noise radius, metres; 0 = silent. */
    stepNoise: { run: 11, walk: 4, crouch: 0 },
    /** Distance covered between two footstep noises. */
    stepLength: 2.4,
    /** Spread multiplier for the stance, before movement and recoil. */
    spreadStance: { run: 1, walk: 1, crouch: 0.6 },
    /** Spread multiplier standing still, and extra at full running speed. */
    spreadStill: 0.7,
    spreadMove: 1.1,
    /** Extra spread per unit of accumulated recoil (recoil caps at 0.5). */
    spreadRecoil: 2,
  },

  player: {
    radius: 0.55,
    maxHp: 100,
    accel: 78,
    maxSpeed: 8.2,
    friction: 11,
    radiusFlash: 0.9,
  },

  enemy: {
    radius: 0.52,
    maxHp: 60,
    accel: 52,
    maxSpeed: 6.0,
    friction: 9,
  },

  camera: {
    height: 36,
    back: 6,
    fov: 29,
    lerp: 7,
    /** Max camera shift toward the cursor, metres. */
    lookAhead: 6,
  },

  light: {
    /** Radius of the dim "you can always see yourself" glow. */
    selfRadius: 7.5,
    /** Enemy detection multiplier when the target stands in a lit area. */
    litDetectBonus: 1.9,
    /** Enemy detection multiplier when the target is in the dark. */
    darkDetectMul: 0.55,
  },

  ai: {
    /** No one is spotted during the first seconds of a session. */
    startGrace: 2.5,
    /** Half-angle of a guard's view cone, radians. */
    fovHalf: (62 * Math.PI) / 180,
    /** Guards notice anyone this close regardless of facing. */
    nearSense: 3.5,
    /** Detection range: in the dark, with flashlight on, in a lamp's light. */
    darkRange: 11,
    flashRange: 22,
    litRange: 26,
    /** Awareness per second at mid range (x2.5 once alerted). */
    awarenessRate: 1.1,
    awarenessDecay: 0.35,
    /** Delay between spotting and the first shot. */
    reactMin: 0.7,
    reactRand: 0.6,
  },

  respawnDelay: 5.0,

  powerups: {
    medkitHeal: 50,
    armorAmount: 50,
    maxArmor: 100,
    /** Share of incoming damage that armor soaks up. */
    armorAbsorb: 0.6,
    damageMul: 1.5,
    damageTime: 12,
    speedMul: 1.3,
    speedTime: 10,
    /** Fire-rate and reload-time factor while the buff lasts. */
    rapidMul: 0.6,
    rapidTime: 10,
    /** Chance that a killed guard drops a powerup (co-op). */
    dropChance: 0.35,
    /** Respawn time of map powerups / weapon pickups in deathmatch. */
    dmRespawn: 18,
    pickupRadius: 1.3,
  },

  /** Flashlight on: long sight, but you are easy to spot (and your beam shows). */
  flashlight: {
    visionOn: 24,
    visionOff: 13,
  },

  grenade: {
    fuse: 2.0,
    radius: 6.5,
    damage: 95,
    gravity: 18,
    /** Upward speed at release; horizontal speed is set by the throw distance. */
    lift: 5,
    minDist: 3,
    maxDist: 16,
    /** Speed kept on bounces (floor / walls). */
    bounce: 0.45,
    cooldown: 0.8,
    max: 3,
    startCoop: 2,
    startArena: 1,
    aiCooldown: 7,
  },

  gun: {
    /** Kills needed on each ladder weapon before moving on. */
    killsPerTier: 2,
  },

  comp: {
    startMoney: 800,
    killReward: 300,
    roundWinBonus: 1500,
    roundLossBonus: 900,
    maxMoney: 9000,
    freezeTime: 3,
    buyTime: 15,
    roundTime: 100,
    endDelay: 4,
    roundsToWin: 5,
    maxRounds: 9,
  },

  /** Weapons dropped by the dead stay on the ground this long. */
  dropLife: 30,

  dm: {
    fragLimit: 15,
    timeLimit: 300,
    /** Total fighters including humans; the rest are bots. */
    fighters: 6,
    respawnDelay: 3,
    spawnShield: 1.6,
  },
  roomsMin: 6,
  roomsMax: 8,
} as const;

export const COLORS = {
  ambient: 0x141a26,
  lamp: 0xffb066,
  lampCold: 0x9fd8ff,
  player: 0x3fd6c8,
  player2: 0xffb545,
  enemy: 0xb4344a,
  enemyDark: 0x3a1a24,
  muzzle: 0xfff0c0,
  tracer: 0xffe6a0,
  enemyTracer: 0xff7a5c,
  floor: 0x161a22,
  wall: 0x2b313d,
} as const;
