import { CONFIG, floorBand } from "../sim/config";
// The signature TABLE only (bossSignatures.ts imports nothing but types) —
// the audio director must not drag three.js into the 2D host's bundle to
// find out how a boss's tell is pitched.
import { signatureFor } from "../render3d/bossSignatures";
import type { AbilityId } from "../sim/abilities";
import type { Announcement, BossEvent, GameState, HitEvent, HitKind, MonsterKind, Player, StatusKind } from "../sim/types";
import type { AudioSink } from "./engine";
import type { SoundId } from "./manifest";

// Maps sim feedback to sound triggers. This is the ONLY audio integration point:
// the host feeds it the same per-frame hit/announcement buffers it already gives
// the particle system, plus the state itself for edge-detection (phase changes,
// skills, doors, music selection). Pure logic over the sim's public data — no
// WebAudio here, so it's unit-testable with a fake sink and works identically
// in solo and network mode (server-relayed events arrive in the same buffers).

const HIT_SOUNDS: Record<HitKind, SoundId> = {
  enemy: "hit",
  crit: "crit",
  player: "player_hurt",
  heal: "heal",
  gold: "gold",
  // The weapon FLASH, not a pickup. Audio r2 fix round: this was `item`, the
  // coin-pickup chime, and it is the last of the borrowed clips row E-21 was
  // written about. Scope matters here, because E-21 itself got it wrong: this
  // is not "the juice poofs seven casts emit". `"weapon"` has 30 emitters in
  // src/sim/game.ts and most are MONSTER-side — adds arriving (2094, 2275,
  // 2290, 2908), risers (2238, 2459), boss children (4588), the orbit parry
  // (3265), the snare snip (4074). A boss spawning adds rang a pickup chime.
  weapon: "weapon_flash",
  // The chain whips out; the arrival's weapon flash adds the clink. Audio r2:
  // this used to be the `dash` whoosh — four unrelated things emit "chain"
  // hits (Extradition's pull, cables, monster grabs), so a dash cue fired for
  // all of them. `chain_line` is a taut-line tick that belongs to none of the
  // casts and reads under the impact rather than over it.
  chain: "chain_line",
};

// THE ACT (SOUNDPLAN §1.4 row E-21): one cue per ability the crawler CASTS.
// The old director voiced three of SIXTEEN (AbilityId has 16 members — the
// r2 build said 17 in five places, including the row whose entire job was to
// be the auditable count of the roster) and the inventory was written by
// walking THIS TABLE instead of the roster, which is why the other thirteen
// were never listed as shipped, deferred, or anywhere — they just spoke in
// whatever borrowed clip their juice poof happened to trigger.
//
// `melee` is a deliberate ABSENCE, not an oversight: `swing` on the
// attackSwing edge already IS its cast cue (a whiff sounds), and its
// consequence is hit/crit/kill. Its cooldown floor is ~0.19s under Swift plus
// the 0.4 CDR cap, so a second cue on it would be the exact fatigue that got
// the footsteps deleted by owner order. The next audit should read a decision
// here, not a hole.
const CAST_SOUNDS: Partial<Record<AbilityId, SoundId>> = {
  dash: "cast_dash", bolt: "bolt", nova: "nova",
  orbit: "cast_orbit", stance: "cast_stance", overcharge: "cast_overcharge",
  cutto: "cast_cutto", crowdsurf: "cast_crowdsurf", stuntdouble: "cast_stuntdouble",
  bulwark: "cast_bulwark", cables: "cast_cables",
  airstrike: "cast_airstrike", cataclysm: "cast_cataclysm",
  bullettime: "cast_bullettime", injunction: "cast_injunction",
};
/**
 * The two CHARGE abilities, which the cooldown rule cannot see correctly in
 * EITHER direction and which therefore detect on their charge counter alone.
 *
 * - It MISSES casts: `doDash` / `doCutTo` set the cooldown only when it was
 *   already 0 (game.ts:5762, 6399), so spending a second banked charge while
 *   the recharge runs raises nothing.
 * - It also INVENTS them, which the design of this round did not anticipate:
 *   the recharge blocks (game.ts:7740-7742, 7755-7757) bank a charge when the
 *   timer expires and, while still below max, immediately RE-ARM `cd` to a
 *   full cooldown. That is a rise from 0 with nobody pressing anything — a
 *   phantom cast every recharge on any build with more than one charge.
 *
 * The counters have no such ambiguity: each is decremented in exactly one
 * place, the cast itself, and every other write is an increment or a refill.
 */
const CHARGE_CASTS = new Set<AbilityId>(["dash", "cutto"]);

/** Ultimates carry further and sit 2.5dB hotter (§2.2): an ally's Fault Line
 *  is a room event you need to know about, for the same reason a boss beat
 *  gets the wider circle. */
const ULTIMATE_CASTS = new Set<AbilityId>(["airstrike", "cataclysm", "bullettime", "injunction"]);
/** Cooldown-rise epsilon — the SAME one renderer3d.castCommitEdges uses, so
 *  the cue, the commit flash and the animation fire off one fact. */
const CAST_EPS = 1e-6;

// DoT ticks read as their ELEMENT, not as blows — burn crackles, venom
// bubbles, frost chimes (throttled in the manifest; ticks come fast).
const STATUS_SOUNDS: Record<StatusKind, SoundId> = {
  burn: "dot_burn",
  poison: "dot_poison",
  chill: "dot_chill",
};

// The moment a status LANDS (SOUNDPLAN §1.4 row 1): apply cues, distinct
// from the tick voices — ignition catch, splat, crystallize. Edge-detected
// from entity status lists (the sim emits no apply event; the lists are
// deterministic data, so replays cue identically).
const STATUS_APPLY_SOUNDS: Record<StatusKind, SoundId> = {
  burn: "apply_burn",
  poison: "apply_poison",
  chill: "apply_chill",
};

/** Hits farther than this (in tiles) from the local player are inaudible. */
const EARSHOT = 24;

/** Breakable prop keys that shatter (ceramic/glass) rather than splinter. */
const CLAY_KEY = /pot|plate|dish|bottle|goblet|mug|vase|jar|potion|glass|gem/;

// Creature bark FAMILIES (SOUNDPLAN §1.4 row 9): every archetype speaks as
// one of five species — skeletal rattle, organic beast/plant, humanoid
// show-cast, machine servo, airy phantom/witch. Bosses are deliberately
// absent: the boss-beat channel owns their voice. Unmapped kinds (crafted
// defs, future mobs) stay silent rather than guessing wrong.
type BarkFamily = "skel" | "org" | "hum" | "mech" | "air";
const BARK_FAMILY: Partial<Record<MonsterKind, BarkFamily>> = {
  grunt: "skel", swarmer: "skel", ranged: "skel", cutpurse: "skel", warden: "skel",
  brute: "org", charger: "org", spitter: "org", broodmother: "org", lasher: "org",
  understudy: "org", filcher: "org", suitactor: "org",
  bomber: "hum", drummer: "hum", digger: "hum", shieldbearer: "hum", cleric: "hum",
  duelist: "hum", sniper: "hum", stagehand: "hum", darling: "hum", canceled: "hum",
  suitguy: "hum", archivist: "hum", colossus: "hum",
  lineworker: "mech", sentinel: "mech", slagbreaker: "mech", toysoldier: "mech",
  greeter: "mech", foreman: "mech",
  phantom: "air", shaman: "air", necromancer: "air", hexer: "air",
};
/** One pain bark per monster per this many seconds (§2.4). */
const BARK_PAIN_GAP = 4;

// Soundtrack pools. Regular fights rotate the battle bed per floor so runs
// don't wear one track out; boss arenas get dedicated themes that escalate
// toward the final floor.
// Ambience is PER BAND (SOUNDPLAN §3, Music r1): the six generated beds,
// indexed by floorBand() — same six bands the art direction reskins by.
// `music_dungeon` is the graceful-degradation fallback for ANY bed that isn't
// PLAYABLE (sink.has — see bed()), mirroring the model loader's stand-ins.
// Audio r2: beds stream rather than decode, so "playable" is optimistic and
// only turns false when the element actually fails (404 / undecodable /
// stalled). The director re-asks has() every frame, so a bed that dies
// mid-run falls back on the very next frame — but only because every request
// goes through bed(); the first r2 cut routed 9 of the 16 around it.
const BAND_BEDS: SoundId[] = [
  "music_band_undercroft", "music_band_sewers", "music_band_garden",
  "music_band_ruins", "music_band_ironworks", "music_band_approach",
];
const BATTLE_TRACKS: SoundId[] = ["music_battle_a", "music_battle_b", "music_battle_c"];
const CITY_BOSS_TRACKS: SoundId[] = ["music_boss_epic", "music_boss_tides"];
// A pack inside aggro range is actively hunting you (sim rule), so it reads
// as a fight even before first blood.
const PACK_RADIUS = CONFIG.monsterAggroRange;
const PACK_SIZE = 3;
const BATTLE_LINGER = 6; // seconds of quiet before battle music stands down
const BOSS_EARSHOT = 26; // a living boss within this range owns the soundtrack
// BOSSES V2 §5.1 — THE APPROACH. A boss that exists but has not been
// introduced yet, this close, means the party is in the corridor. The bed
// ducks to a drone and stays there until the ringside reveal.
const APPROACH_RANGE = 34;
const APPROACH_DUCK = 0.22;

/**
 * BOSSES V2 §5.4 — the boss beat sound map. Semantic reuse of shipped clips,
 * because the game has no boss-specific audio and inventing files is not this
 * round's job. What makes them read as DIFFERENT beats is the pairing plus
 * the per-boss playback rate on the telegraph.
 */
const BEAT_SOUNDS: Record<BossEvent["kind"], SoundId | null> = {
  intro: "boss_intro",
  phase: "boss_phase", // dedicated phase HIT (row 15 — band_sting retired from double duty)
  intermission: "sponsor", // THE COMMERCIAL BREAK, and the clip is literally a jingle
  punish: "boss_punish", // the unload window OPENS: crowd-gasp + crack
  plate: "item", // armour coming off, metal on stone
  shieldbreak: "door_unlock", // a lock giving way
  enrage: "warning",
  prop: "door_unlock",
  telegraph: "tell", // pitched per boss — see signatureFor()
};

/** The final floor gets the colossal theme; city-boss arenas rotate the rest. */
function bossTrack(floor: number): SoundId {
  if (floor >= CONFIG.finalFloor) return "music_boss_colossal";
  const arena = Math.max(0, Math.floor(floor / CONFIG.bossFloorEvery) - 1);
  return CITY_BOSS_TRACKS[arena % CITY_BOSS_TRACKS.length];
}

interface Prev {
  phase: GameState["phase"];
  floor: number;
  status: GameState["status"];
  inSafeRoom: boolean;
  locked: boolean;
  level: number;
  lootBoxes: number;
  achievements: number;
  pendingRewards: boolean;
  attackSwing: number;
  frenzy: boolean;
  encounter: boolean;
  bulletTime: boolean;
  flask: number;
  conceded: boolean;
}

/** Per-player cast bookkeeping (see castEdges). `cutCharges` is optional on
 *  Player, so it is carried as `number | undefined` and an undefined on
 *  EITHER side of a comparison means "prime", never "cast". */
interface CastPrev {
  cd: Record<string, number>;
  dashCharges: number;
  cutCharges: number | undefined;
  overcharged: boolean;
}

export class AudioDirector {
  private prev: Prev | null = null;
  // The check-in menu is host UI, not sim state, so the host flags it here.
  // While it's up the campfire bed owns the room (SOUNDPLAN §3 row 7).
  private menuOpen = false;
  // Monsters currently winding up an attack — a new id is a fresh "tell".
  private winding = new Set<number>();
  // Pings already chimed (same pattern as winding: a new id is a fresh mark).
  private pinged = new Set<number>();
  // Loot drops already chimed (worthy drops ring once; cleared on descent).
  private chimed = new Set<number>();
  private battleUntil = 0; // state.elapsed until which the battle bed persists
  private ducked = false; // §5.1: the approach duck is riding
  // Status-apply edges: keys "m:<id>:<kind>" / "p:<id>:<kind>" currently
  // afflicted. A key appearing = the status landed. Primed on first frame so
  // a mid-run join doesn't replay every ongoing affliction.
  private afflicted = new Set<string>();
  // Breakables last seen, by id: gone = smashed (pop), hp dropped = cracked.
  private crockery = new Map<number, { x: number; y: number; hp: number; clay: boolean }>();
  // Creature bark bookkeeping: last seen state per monster id.
  private mobs = new Map<number, { fam: BarkFamily; x: number; y: number; hp: number; flash: boolean; engaged: boolean; painAt: number }>();
  // Cast edges, per player id. Absent = first sight = PRIME (store, fire
  // nothing), so a load, a mid-run join or a squadmate walking into the
  // interest set cannot replay the whole roster as fresh casts.
  private casts = new Map<number, CastPrev>();
  // Last frame's state.elapsed. A DECREASE is a fresh run (the sim's clock
  // only ever advances within one), which is the only run-boundary signal that
  // survives a restart on the same floor — see castEdges.
  private lastElapsed = -Infinity;

  constructor(private sink: AudioSink) {}

  /** Host hook: the RINGSIDE CHECK-IN (menu/campfire) opened or closed. */
  setMenu(open: boolean): void {
    this.menuOpen = open;
  }

  /**
   * ANY bed request, degraded to the generic dungeon ambience when the wanted
   * bed isn't playable.
   *
   * This used to be `ambientBed()` and it only covered the six band beds and
   * `music_menu` — 7 of 16. The engine and this file both carried a comment
   * promising that a dead bed "falls back to music_dungeon on the very next
   * frame, by itself", and for music_collapse, music_safe, the three battle
   * tracks and the three boss themes that was simply untrue: they were
   * requested unconditionally, so a streamBad demotion on any of them left
   * engine.music() taking the pendingMusic branch — silence for the entire
   * mood, at the two moments (the collapse timer, a boss arena) where silence
   * is most expensive. Streaming introduced that failure class; the decode
   * path could not reach it, because a bed either had a decoded buffer or was
   * never requested. So every request goes through here now.
   *
   * If `music_dungeon` is itself unplayable the engine holds the outgoing bed
   * rather than cutting to silence (see engine.music()'s hand-off).
   */
  private bed(id: SoundId): SoundId {
    return (this.sink.has?.(id) ?? true) ? id : "music_dungeon";
  }

  /** The band's ambient bed (the per-band half of the same rule). */
  private ambientBed(floor: number): SoundId {
    return this.bed(BAND_BEDS[floorBand(floor)] ?? "music_dungeon");
  }

  /** One creature bark: family voice, variant + rate hashed from the monster
   *  id (a given creature keeps ITS voice; replays sound identical). */
  private bark(p: { pos: { x: number; y: number } }, id: number, fam: BarkFamily, ev: "aggro" | "pain" | "death", x: number, y: number): void {
    const dx = x - p.pos.x, dy = y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > EARSHOT) return;
    const h = Math.imul(id + 1, 0x9e3779b1) >>> 0;
    this.sink.play(`bark_${fam}_${ev}_${(h & 1) === 0 ? "a" : "b"}` as SoundId, {
      gain: 0.85 / (1 + d / 5),
      pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      rate: 0.94 + (((h >> 8) & 0xff) / 255) * 0.12,
    });
  }

  /** One breakable voicing: material clip, positioned, hash-jittered rate
   *  (deterministic per id — replays sound identical). Cracks (hp chipped,
   *  still standing) play lighter and higher than the pop. */
  private smashAt(p: { pos: { x: number; y: number } }, id: number, x: number, y: number, clay: boolean, cracked: boolean): void {
    const dx = x - p.pos.x, dy = y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > EARSHOT) return;
    const h = Math.imul(id + 1, 2654435761) >>> 0;
    this.sink.play(clay ? "smash_clay" : "smash_wood", {
      gain: (cracked ? 0.45 : 1) / (1 + d / 6),
      pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      rate: (cracked ? 1.12 : 0.92) + ((h & 0xff) / 255) * 0.16,
    });
  }

  /** One cast cue. The LOCAL crawler's own act is centred and unattenuated —
   *  my cast is never off to one side and never quiet. A squadmate's is
   *  attenuated and panned exactly like their hits, with an extra 0.75 so my
   *  own cast always wins a tie against an identical one six tiles away.
   *  Ultimates use the boss-beat circle (EARSHOT * 1.6) and its gentler
   *  falloff instead. */
  private castCue(
    p: { pos: { x: number; y: number }; id: number },
    caster: Player, ability: AbilityId, sound: SoundId,
    extra?: { rate?: number; gainMul?: number; force?: boolean },
  ): void {
    const mul = extra?.gainMul ?? 1;
    const extras = {
      ...(extra?.rate !== undefined ? { rate: extra.rate } : {}),
      ...(extra?.force ? { force: true } : {}),
    };
    if (caster.id === p.id) {
      this.sink.play(sound, { gain: mul, pan: 0, ...extras });
      return;
    }
    const ult = ULTIMATE_CASTS.has(ability);
    const dx = caster.pos.x - p.pos.x, dy = caster.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > EARSHOT * (ult ? 1.6 : 1)) return;
    this.sink.play(sound, {
      gain: mul * (ult ? 1 / (1 + d / 14) : 0.75 / (1 + d / 6)),
      pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      ...extras,
    });
  }

  /**
   * THE ACT: a general cast detector over the one fact every castable ability
   * writes — a rising edge on `p.cd[abilityId]`. This mirrors, deliberately
   * and down to the epsilon, what renderer3d.castCommitEdges already does
   * host-side for the visual commit kits, so the cue, the flash and the
   * animation fire off ONE fact instead of five ad-hoc flags.
   *
   * Why cd is the right general signal: `castAbility` refuses to run at all
   * while cd > 0, and every cooldown-reduction path in the sim (rank + glyph
   * CDR clamped at the 0.4 cap, the per-frame tick, Bullet Time's adrenaline,
   * frenzy/tempo multipliers, Executioner's Rebate, Footwork, AWARD SEASON,
   * Sponsor Loyalty, the overtime passive) only ever makes cd SMALLER or
   * makes it tick DOWN faster. None can raise it without a cast, so the
   * rising edge is cast-EXACT regardless of build, and overranks are free:
   * the edge compares a value to its own previous frame, never to a table.
   *
   * The two exceptions are the CHARGE abilities (see CHARGE_CASTS), where the
   * cooldown both misses real casts and invents phantom ones, so they read
   * their charge counters instead. That is also strictly better than the old
   * `dashTime` rule, since three non-dash things write dashTime (Extradition's
   * heavy pull, Phase Etch Blindside, the PET revision's i-frames) and the
   * game used to play a dash whoosh for every one of them.
   *
   * A RUN BOUNDARY IS NOT A VOLLEY. The first version of this block claimed a
   * descent needed no guard, reasoning that the floor reset assigns `p.cd = {}`
   * and refills charges — all movement in the safe direction. That is true for
   * two of the three fields it reads and false for the third: game.ts:1399
   * (resetForFloor) and game.ts:8087 (rivals descend) also clear
   * `p.overcharged`, and the Breaker SPEND detector is a bare falling edge on
   * exactly that flag. Descending with Breaker banked — bank before a fight,
   * fight ends, take the stairs, i.e. ordinary play — fired a phantom
   * pitched-up Breaker release on top of the descend stinger, the game's most
   * deliberate transition. Verified by driving the real director against a
   * real GameState, which is also how the r2 critics found it.
   *
   * So the block re-PRIMES (stores, fires nothing) on any run boundary, the
   * same shape the smash and bark blocks already use. Two boundaries, because
   * a floor number alone does not catch a restart on the same floor:
   *   - the floor changed; or
   *   - `state.elapsed` went BACKWARDS, which only a fresh run can do. The
   *     director is module-scope in main3d.ts and `casts` is pruned only on
   *     player disappearance, so a run that ended with Breaker banked used to
   *     seed the next one.
   */
  private castEdges(p: Player, state: GameState, boundary: boolean): void {
    const seen = new Set<number>();
    for (const pl of state.players) {
      seen.add(pl.id);
      const cds = pl.cd as Partial<Record<string, number>>;
      const snap: Record<string, number> = {};
      for (const k in cds) snap[k] = cds[k] ?? 0;
      const prev = boundary ? undefined : this.casts.get(pl.id);
      if (prev) {
        for (const ab in CAST_SOUNDS) {
          const sound = CAST_SOUNDS[ab as AbilityId];
          if (!sound || CHARGE_CASTS.has(ab as AbilityId)) continue;
          if ((snap[ab] ?? 0) > (prev.cd[ab] ?? 0) + CAST_EPS) this.castCue(p, pl, ab as AbilityId, sound);
        }
        // The charge abilities, off their counters alone (see CHARGE_CASTS):
        // one cue per charge SPENT, whatever the recharge timer is doing.
        if (pl.dashCharges < prev.dashCharges) this.castCue(p, pl, "dash", CAST_SOUNDS.dash!);
        // `cutCharges` is optional on Player — undefined on either side of the
        // comparison is a PRIME, never a cast, or the frame the field first
        // appears would fire a phantom Blindside.
        if (
          prev.cutCharges !== undefined && pl.cutCharges !== undefined &&
          pl.cutCharges < prev.cutCharges
        ) this.castCue(p, pl, "cutto", CAST_SOUNDS.cutto!);
        // Breaker's SPEND: one file, two moments. The cast BANKS the power
        // (the clip stops instead of resolving); this is its release, the
        // same sample pitched up and pulled back. Without it the spend is
        // indistinguishable from an ordinary swing.
        //
        // `force` because bank and spend share one sound id and the engine's
        // spam guard is per-id: at throttleMs 600, spending on the next landed
        // hit — which is the intended rhythm ("charge -> pick the moment ->
        // spend") — produced NO CUE AT ALL. The feature was asserted at the
        // director, where FakeSink has no throttle, and discarded at the
        // engine. Forcing is the right escape here for the same reason the
        // boss beats force: the SPEND edge is already rate-limited upstream by
        // the sim — `overcharged` can only fall once per bank, per player.
        if (prev.overcharged && !pl.overcharged) {
          this.castCue(p, pl, "overcharge", CAST_SOUNDS.overcharge!, { rate: 1.3, gainMul: 0.55, force: true });
        }
      }
      this.casts.set(pl.id, {
        cd: snap,
        dashCharges: pl.dashCharges,
        cutCharges: pl.cutCharges,
        overcharged: pl.overcharged === true,
      });
    }
    // Prune on disappearance so a rejoin re-primes rather than diffing
    // against stale numbers.
    for (const id of this.casts.keys()) if (!seen.has(id)) this.casts.delete(id);
  }

  /**
   * Call once per render frame with the frame's buffered feedback.
   * `bossEvents` is the BOSSES-V2 §7.4 channel, buffered by the host across
   * sub-steps exactly like hits and announcements.
   */
  frame(
    state: GameState, hits: HitEvent[], announcements: Announcement[], localId: number,
    bossEvents: BossEvent[] = [],
  ): void {
    const p = state.players.find((pl) => pl.id === localId) ?? state.players[0];
    if (!p) return;

    // Combat feedback: attenuate + pan by position relative to the local player.
    // Screen-x under the fixed iso camera grows with (world x - world y), so a
    // simple (dx - dy) pan matches what the player sees.
    let combat = false; // a real blow landed in earshot this frame
    for (const h of hits) {
      const dx = h.pos.x - p.pos.x;
      const dy = h.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT) continue;
      // DoT ticks don't count as combat (they linger after a fight and would
      // pin the battle bed up) and sound as their element instead of a blow.
      if (!h.effect && (h.kind === "enemy" || h.kind === "crit" || h.kind === "player")) combat = true;
      const opts = {
        gain: 1 / (1 + d / 6),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      };
      this.sink.play(h.effect ? STATUS_SOUNDS[h.effect] : HIT_SOUNDS[h.kind], opts);
      // Killing blows on monsters get a meatier thump layered on top.
      if (h.killed && h.kind !== "player") this.sink.play("kill", opts);
    }

    // Enemy windup tells: one cue per attack, positioned like the hits, so
    // danger is audible even when the telegraph starts off-screen.
    const winding = new Set<number>();
    for (const m of state.monsters) {
      if (m.windup <= 0) continue;
      winding.add(m.id);
      if (this.winding.has(m.id)) continue; // already announced this attack
      const dx = m.pos.x - p.pos.x;
      const dy = m.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT) continue;
      this.sink.play("tell", {
        gain: 0.9 / (1 + d / 6),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      });
    }
    this.winding = winding;

    // NO FOOTSTEPS (owner call, audio r2): "the footsteps are really
    // annoying.. let's not have any footsteps sound effects". The whole stride
    // system — distance-driven cadence, per-band surfaces, deterministic
    // per-step jitter — was correct engineering on a sound the game should
    // never have had: at ~4 footfalls/s the most-repeated clip in the game is
    // the one the player never chose to make. Removed wholesale (director,
    // manifest, files, tests) rather than muted, so it cannot drift back in
    // through a volume pass. Squadmate presence still reads through hits,
    // barks and casts, all of which are CHOSEN moments.

    // Status APPLY cues (row 1): a key appearing in the afflicted set = the
    // status landed this frame. Primed on the first frame so a mid-run join
    // or load doesn't replay every ongoing affliction as a fresh cue.
    {
      const primed = this.prev !== null;
      const seen = new Set<string>();
      const cue = (key: string, kind: StatusKind, x: number, y: number) => {
        const fresh = !this.afflicted.has(key);
        seen.add(key);
        if (!primed || !fresh) return;
        const dx = x - p.pos.x, dy = y - p.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > EARSHOT) return;
        this.sink.play(STATUS_APPLY_SOUNDS[kind], {
          gain: 0.9 / (1 + d / 6),
          pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
        });
      };
      for (const pl of state.players) {
        if (pl.statuses) for (const s of pl.statuses) cue(`p:${pl.id}:${s.kind}`, s.kind, pl.pos.x, pl.pos.y);
      }
      for (const m of state.monsters) {
        if (m.statuses) for (const s of m.statuses) cue(`m:${m.id}:${s.kind}`, s.kind, m.pos.x, m.pos.y);
      }
      this.afflicted = seen;
    }

    // Breakable smashes (row 5): the pot pops the frame it leaves the list,
    // voiced by material (clay vs wood from the prop key), rate-spread by a
    // hash of the id so a storeroom sweep isn't a machine gun. A floor
    // change replaces the whole list — that is a descent, not a demolition.
    {
      const floorChanged = !this.prev || this.prev.floor !== state.floor;
      const seen = new Set<number>();
      for (const b of state.breakables ?? []) {
        seen.add(b.id);
        const known = this.crockery.get(b.id);
        if (!known || floorChanged) {
          this.crockery.set(b.id, { x: b.pos.x, y: b.pos.y, hp: b.hp, clay: CLAY_KEY.test(b.key) });
          continue;
        }
        if (b.hp < known.hp) this.smashAt(p, b.id, b.pos.x, b.pos.y, known.clay, true); // cracked
        known.hp = b.hp;
        known.x = b.pos.x;
        known.y = b.pos.y;
      }
      for (const [id, c] of this.crockery) {
        if (seen.has(id)) continue;
        this.crockery.delete(id);
        if (!floorChanged) this.smashAt(p, id, c.x, c.y, c.clay, false); // the pop
      }
    }

    // Creature barks (row 9): the roster finally has voices. Aggro = the
    // moment a monster first comes hunting (once per lifetime), pain = the
    // hitFlash edge gated per-monster (§2.4: one per 4s), death = the id
    // leaving the list (layers under the `kill` thump). Same floor-change
    // guard as smashes: a descent is not a massacre.
    {
      const floorChanged = !this.prev || this.prev.floor !== state.floor;
      const seen = new Set<number>();
      for (const m of state.monsters) {
        seen.add(m.id);
        const fam = BARK_FAMILY[m.kind];
        if (!fam) continue;
        const known = this.mobs.get(m.id);
        const dNear = state.players.reduce((best, pl) => {
          if (!pl.alive) return best;
          return Math.min(best, Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y));
        }, Infinity);
        const flash = m.hitFlash > 0;
        if (!known || floorChanged) {
          this.mobs.set(m.id, { fam, x: m.pos.x, y: m.pos.y, hp: m.hp, flash, engaged: false, painAt: -Infinity });
          continue;
        }
        if (!known.engaged && !m.dormant && m.hp > 0 && dNear <= PACK_RADIUS) {
          known.engaged = true;
          this.bark(p, m.id, fam, "aggro", m.pos.x, m.pos.y);
        }
        if (flash && !known.flash && m.hp > 0 && state.elapsed - known.painAt >= BARK_PAIN_GAP) {
          known.painAt = state.elapsed;
          this.bark(p, m.id, fam, "pain", m.pos.x, m.pos.y);
        }
        if (m.hp <= 0 && known.hp > 0) this.bark(p, m.id, fam, "death", m.pos.x, m.pos.y);
        known.x = m.pos.x;
        known.y = m.pos.y;
        known.hp = m.hp;
        known.flash = flash;
      }
      for (const [id, k] of this.mobs) {
        if (seen.has(id)) continue;
        this.mobs.delete(id);
        // Reaped between frames without a seen hp<=0 edge: still a death.
        if (!floorChanged && k.hp > 0) this.bark(p, id, k.fam, "death", k.x, k.y);
      }
    }

    // Party pings: one soft System chime per fresh mark, panned toward it.
    const pinged = new Set<number>();
    for (const pg of state.pings) {
      pinged.add(pg.id);
      if (this.pinged.has(pg.id)) continue;
      const dx = pg.pos.x - p.pos.x;
      const dy = pg.pos.y - p.pos.y;
      this.sink.play("announce", {
        gain: 0.55,
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      });
    }
    this.pinged = pinged;

    // BOSSES V2 §5.4 — the boss beats. Each one is a single, unmissable cue,
    // positioned like combat hits so an off-screen telegraph is still audible
    // (the 0.2s rule is easier to hit with sound than with pixels, which is
    // exactly why every named signature gets its own pitch).
    for (const be of bossEvents) {
      const id = BEAT_SOUNDS[be.kind];
      if (!id) continue;
      const bx = be.pos?.x ?? p.pos.x, by = be.pos?.y ?? p.pos.y;
      const dx = bx - p.pos.x, dy = by - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT * 1.6) continue;
      const opts = {
        gain: 1 / (1 + d / 14),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
        force: true, // one cue per sim beat; the caller IS the rate limit
        rate: be.kind === "telegraph" ? signatureFor(be.label, be.bossId).rate : 1,
      };
      this.sink.play(id, opts);
      // Crowd swell on the beats the crowd would actually react to: the
      // reveal's downbeat, a phase the PLAYER caused, and the punish window.
      if (
        be.kind === "intro" ||
        be.kind === "punish" ||
        (be.kind === "phase" && be.reason === "mechanic")
      ) this.sink.play("crowd");
      // The kill: the sim marks it as a phase edge labelled DEFEATED. The
      // low tail (boss_down) settles the building over the corpse (row 15).
      if (be.kind === "phase" && be.label === "DEFEATED") {
        this.sink.play("kill", { gain: 1, force: true });
        this.sink.play("boss_down", { force: true });
        this.sink.play("crowd");
      }
    }

    // A multi-kill this step: the crowd loves it. (Throttled in the engine.)
    if (state.killsThisStep >= 3) this.sink.play("crowd");
    // The System speaks — one IDENT regardless of how many lines queued
    // (row 8): normal lines get the 2-note blip, a headline anywhere in the
    // batch upgrades it to the heavy ident. TODAY'S RULE additionally gets
    // its paper stamp — bureaucracy, audible (row 11).
    if (announcements.length > 0) {
      this.sink.play(announcements.some((a) => a.priority === "high") ? "ident_high" : "ident");
      if (announcements.some((a) => a.text.startsWith("TODAY'S RULE"))) this.sink.play("stamp");
      // Row 6, the pickup half: a room going OPEN FOR BUSINESS rings the
      // same till the purchases use — the System's cash register is ONE
      // sound, whichever direction the money moves.
      if (announcements.some((a) => a.text.startsWith("OPEN FOR BUSINESS"))) this.sink.play("till");
    }

    // THE ACT — every crawler's cast cues, off the one general fact (see
    // castEdges). This runs BEFORE the Prev block on purpose: Bullet Time's
    // cast and its muffle() land on the same frame, and the engine sweeps a
    // 700Hz master low-pass on that edge — the cue has to be in flight before
    // the filter closes over it.
    const runBoundary = !this.prev || this.prev.floor !== state.floor || state.elapsed < this.lastElapsed;
    this.lastElapsed = state.elapsed;
    this.castEdges(p, state, runBoundary);

    const cur: Prev = {
      phase: state.phase,
      floor: state.floor,
      status: state.status,
      inSafeRoom: state.safeRoom !== null,
      locked: state.map.locked,
      level: p.level,
      lootBoxes: state.lootBoxes,
      achievements: p.achievements.length,
      pendingRewards: p.pendingRewards.length > 0,
      attackSwing: p.attackSwing,
      frenzy: p.frenzy,
      encounter: state.encounter !== null,
      bulletTime: state.bulletTimeLeft > 0,
      flask: p.flaskCharges,
      conceded: p.conceded === true,
    };

    const prev = this.prev;
    this.prev = cur;
    if (prev) {
      // BULLET TIME: the mix goes underwater while the world is slowed.
      if (cur.bulletTime !== prev.bulletTime) this.sink.muffle?.(cur.bulletTime);
      // World beats (state edges the hit channel doesn't carry).
      if (prev.phase === "safe" && cur.phase === "warning") this.sink.play("warning");
      if (cur.floor !== prev.floor) {
        this.sink.play("descend");
        this.sink.play("descend_whoosh"); // row 17: the portal swallows you
        // Crossing into a new 3-floor band: the season enters a new act.
        if (Math.floor((cur.floor - 1) / 3) !== Math.floor((prev.floor - 1) / 3)) {
          this.sink.play("band_sting");
        }
      }
      if (prev.status === "playing" && cur.status === "dead") this.sink.play("death");
      // DEATH IS A DOOR (row 14): the concede is a single cold door-close.
      // Terminal, dry, no musical comment — the race forgets nobody.
      if (cur.conceded && !prev.conceded) this.sink.play("door_close", { force: true });
      if (prev.status === "playing" && cur.status === "won") this.sink.play("victory");
      if (prev.locked && !cur.locked) this.sink.play("door_unlock");
      // Local player beats.
      if (cur.level > prev.level) this.sink.play("level_up");
      if (cur.lootBoxes > prev.lootBoxes) this.sink.play("lootbox");
      if (cur.achievements > prev.achievements) this.sink.play("achievement");
      if (!prev.pendingRewards && cur.pendingRewards) this.sink.play("sponsor");
      // Crowd Frenzy kicks in: the arena roars.
      if (cur.frenzy && !prev.frenzy) this.sink.play("crowd");
      // Ringside introduction: the boss sting over the frozen reveal.
      if (cur.encounter && !prev.encounter) this.sink.play("boss_intro");
      // The melee whoosh triggers on the swing itself — a whiff still sounds.
      // It is ALSO melee's cast cue, which is why melee has no entry in
      // CAST_SOUNDS (see the table's comment).
      if (cur.attackSwing > prev.attackSwing + 1e-6) this.sink.play("swing");
      // The flask keeps its borrowed bottle clink under the heal: it is a
      // consumable, not an ability, so no cast cue covers it.
      if (cur.flask < prev.flask) this.sink.play("item");
      // AUDIO R2 — the ad-hoc cast block that used to live here is gone. Five
      // hand-rolled edges (dashTime / novaFlash / boltCd / cataCd / doubleCd)
      // plus four borrowed layers (crit for Fault Line, equip for the Stunt
      // Double, dash at 0.8 for Bullet Time) are all subsumed by castEdges.
      // novaFlash is the good riddance: it is SHARED by nova and cataclysm,
      // which is why the renderer had to disambiguate it with the cataclysm
      // cooldown edge — reading cd.nova and cd.cataclysm separately removes
      // the ambiguity entirely. `bulletTime` stays in Prev for muffle() only:
      // that is a STATE, not an edge.
    }

    // Worthwhile drops CHIME as they hit the floor (the loot-beam moment):
    // gear above common + tomes, positioned like combat hits; commons stay
    // quiet so the chime keeps meaning. Seen-set clears on descent.
    if (prev && state.floor !== prev.floor) this.chimed.clear();
    for (const l of state.loot) {
      if (this.chimed.has(l.id)) continue;
      const worthy = (l.kind === "item" && l.rarity && l.rarity !== "common") || l.kind === "tome";
      if (!worthy) continue;
      this.chimed.add(l.id);
      const dx = l.pos.x - p.pos.x, dy = l.pos.y - p.pos.y;
      if (Math.hypot(dx, dy) > EARSHOT) continue;
      this.sink.play("equip", { gain: 0.8, pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)) });
    }

    // Battle/boss detection. Blows landing in earshot (or a pack closing in)
    // raise the battle bed and keep it up; it stands down after a quiet spell.
    // A living boss nearby owns the soundtrack outright.
    let pack = 0;
    let bossNear = false;
    let approaching = false; // §5.1: a boss we have not been introduced to yet
    let finalPhase = false; // §5.4: the low-HP layer
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (m.kind === "boss") {
        if (d <= BOSS_EARSHOT) bossNear = true;
        if (!m.introduced && d <= APPROACH_RANGE) approaching = true;
        if (m.introduced && (m.phase ?? 0) >= (m.maxPhase ?? 2)) finalPhase = true;
      }
      if (d <= PACK_RADIUS) pack++;
    }
    if (combat || pack >= PACK_SIZE) this.battleUntil = state.elapsed + BATTLE_LINGER;

    // §5.1 — THE APPROACH. Ambient ducks to a single drone in the corridor
    // into an arena, and comes back up the instant the reveal fires. This is
    // the run's last quiet moment, and quiet is the whole point of it.
    const wantDuck = approaching && !bossNear && state.encounter === null;
    if (wantDuck !== this.ducked) {
      this.ducked = wantDuck;
      this.sink.duck?.(wantDuck ? APPROACH_DUCK : 1);
    }

    // Music bed follows the run's mood; the engine crossfades on change and
    // no-ops when the requested track isn't present. The campfire check-in
    // outranks everything — while the menu is up (fresh season, mid-run
    // resume screen, even over a corpse) the player is AT the campfire, and
    // the bed says so; the run's mood takes back over the moment it closes.
    this.sink.music(
      this.menuOpen && (this.sink.has?.("music_menu") ?? true) ? "music_menu"
      : cur.status !== "playing" ? null
      : cur.inSafeRoom ? this.bed("music_safe")
      // §5.4 — the LOW-HP LAYER: on the final phase every boss escalates to
      // the colossal bed, whatever floor it is on. The finale's theme stops
      // being the finale's and starts meaning "this one is nearly over".
      : bossNear ? this.bed(finalPhase ? "music_boss_colossal" : bossTrack(state.floor))
      : cur.phase === "collapse" ? this.bed("music_collapse")
      : state.elapsed < this.battleUntil ? this.bed(BATTLE_TRACKS[state.floor % BATTLE_TRACKS.length])
      : this.ambientBed(state.floor),
    );
  }
}
