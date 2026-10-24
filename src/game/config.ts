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

  /** Ceiling lamps players can shoot out. */
  lamp: {
    /** A player's bullet passing this close (metres) breaks the lamp. */
    hitRadius: 0.35,
    /** Breaking glass is heard this far. */
    noise: 12,
  },

  /** Bushes hide whoever walks, crouches or stands in them. */
  bush: {
    radius: { min: 1.2, max: 1.7 },
    /** Bushes per yard room in co-op levels. */
    perYardRoom: { min: 3, max: 5 },
    /** A hidden soldier is still spotted this close. */
    spotDist: 2.5,
    /** Firing gives the shooter away for this long. */
    revealAfterShot: 1.2,
  },

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

  /**
   * Bot difficulty, as factors on the AI: reaction delay, how fast they
   * notice you, how wide their shots spread, how far they see.
   */
  difficulty: {
    easy: { react: 1.6, awareness: 0.6, spread: 1.5, range: 0.85 },
    normal: { react: 1, awareness: 1, spread: 1, range: 1 },
    hard: { react: 0.6, awareness: 1.5, spread: 0.65, range: 1.15 },
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
    nvTime: 10,
    /** Night vision amplifies a flash grenade too. */
    nvBlindMul: 1.5,
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
    /** Smoke and flash grenades each player starts with (co-op and arenas). */
    startUtility: 1,
    /** Most smoke / flash grenades carried, each. */
    maxUtility: 2,
  },

  smoke: {
    fuse: 1.4,
    /** Full cloud radius, reached after `grow` seconds. */
    radius: 4.2,
    grow: 1.2,
    /** Cloud lifetime; it thins out over the last `fade` seconds. */
    life: 14,
    fade: 2.5,
    /** How far you see from inside a cloud. */
    insideSight: 1.5,
  },

  flash: {
    fuse: 1.3,
    /** Blinds those in line of sight within this distance. */
    radius: 16,
    /** Blindness at point blank, looking straight at it (seconds). */
    maxBlind: 2.6,
    /** Fraction of the blindness when the flash goes off behind you. */
    behind: 0.3,
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

  /** Co-op waves on an arena. */
  waves: {
    /** Calm before the first wave and between waves. */
    firstBreak: 5,
    breakTime: 8,
    /** Guards in wave n: base + perWave * (n - 1), capped. */
    base: 3,
    perWave: 2,
    max: 14,
    /** Extra guard health per wave. */
    hpGrowth: 0.12,
  },

  /** Bomb planting (rounds and money as in comp). */
  bomb: {
    plantTime: 3,
    defuseTime: 5,
    /** Fuse once planted. */
    timer: 35,
    /** Site reach, and how close a defuser must stand. */
    siteRadius: 3,
    defuseReach: 1.6,
    /** The blast kills everyone this close, behind walls or not. */
    blastRadius: 12,
    roundTime: 90,
  },

  /** Capture the flag. */
  ctf: {
    capLimit: 3,
    /** A dropped flag goes home on its own after this long. */
    returnTime: 20,
    /** Reach for picking up / returning / capturing. */
    touch: 1.3,
    /** Carrier speed factor. */
    carrySpeed: 0.9,
  },

  /** Team deathmatch: first team to the limit wins; the clock is dm.timeLimit. */
  tdm: {
    scoreLimit: 30,
  },

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
