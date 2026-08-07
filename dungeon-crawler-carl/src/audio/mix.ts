import { AUDIO_MANIFEST, type SoundDef, type SoundId } from "./manifest";
import type { AudioSink, PlayOpts } from "./engine";

// ===========================================================================
// THE MIX LAYER — prioritisation and masking in front of the sink.
//
// WHY THIS EXISTS (owner verdict, 2026-08-07, after playing the integrated
// build): "The sound effects for kills is way too much I think... there needs
// to be a masking layer which prioritizes certain sounds over others."
//
// The measurement behind it (tools/_mixsim.ts + tools/_mixbrowser.mjs, the
// census in SOUNDPLAN §2.5):
//   - floor-15/17 pack density runs 18-24 audible voices/second sustained
//     (p99 73-83 inside a single second) against 9.0/s on floor 3;
//   - peak 55-59 CONCURRENT voices, 23.3 clip starts inside the 300ms around
//     one kill;
//   - the engine's per-id spam guard was ALREADY discarding 49-63% of what the
//     director asked for — first-come-first-served, with no idea what matters,
//     so the cue it silenced most often was `tell`, the telegraph (290 of 420
//     attempts at f17 pack), while `hit` ate the budget;
//   - 35-50% of all voices start while another copy of the SAME clip is still
//     sounding (player_hurt 92.8%, five deep; bolt 96.6%);
//   - peakPre 1.146 at the floor-15 boss, breaching §2.2's headroom contract.
//
// So masking already existed and it was BLIND. This file is the missing
// policy, not a new mechanism. Four rules, in the order they are applied:
//
//   1. TIER. Every cue class gets a rank: player-critical > boss/telegraph >
//      progression > act > impact > ambient chatter. Ranks 4-5 are never
//      refused for crowding and are FORCED past the engine's blind guard, so
//      the important cue always wins; the director becomes their rate limit,
//      which is the pattern the boss beats already used (§2.4).
//   2. VOICE BUDGET. Each tier may only be admitted while fewer than CEILING
//      voices are already sounding. As the pile grows the cheap tiers drop
//      out from the bottom, which is the "Nth simultaneous kill cue does not
//      play" the brief asks for — and it costs a LONE kill nothing, because a
//      lone kill arrives into an empty room.
//   3. SELF-OVERLAP. A clip layered five deep over itself is not five times
//      the information, it is one smeared clip. Per tier, at most 1-2 copies
//      of one id may sound at once.
//   4. FOCUS. A telegraph/critical cue opens a short window in which chatter
//      is refused outright and the impact/act ceilings halve — the ducking
//      the brief asks for, expressed where it is measurable and where it does
//      NOT touch the announcer sidechain (§2.3's "at most ONE duck source"
//      rule still holds; level_up stays off the announcer bus per §1.3a and
//      gets its space here instead).
//
// WHAT THIS DELIBERATELY DOES NOT DO: turn anything down. Not one gain in the
// game moves. The owner named the failure as density, and a quieter kill is
// the wrong fix — the twentieth kill in a second should not play, and the
// first one should sound exactly as it does today.
//
// CLOCK: sim time (state.elapsed * 1000), not performance.now(). Deterministic
// — a replay masks identically, and the unit tests and tools/_mixsim.ts see
// exactly what the product sees. Under a dilated frame rate sim ms are longer
// than wall ms, so the mixer is slightly MORE permissive in the browser than
// in the harness; the harness numbers are therefore the strict ones.
// ===========================================================================

/** Cue ranks. Higher wins. */
export const TIER = {
  chatter: 0,
  impact: 1,
  act: 2,
  progression: 3,
  telegraph: 4,
  critical: 5,
} as const;
export type MixTier = (typeof TIER)[keyof typeof TIER];

/**
 * Explicit ranks. Anything not listed falls through to the pattern rules in
 * `tierOf` — new bark/dot/cast families inherit the right rank for free, and
 * an unrecognised one-shot lands on `impact`, the middle of the range.
 */
const TIER_BY_ID: Partial<Record<SoundId, MixTier>> = {
  // 5 — THE PLAYER'S OWN BODY AND THE RUN'S ENDING. Never refused, never
  // throttled away. player_hurt was 38.9% silenced and 81.9% buried at f15.
  player_hurt: TIER.critical,
  death: TIER.critical,
  victory: TIER.critical,
  warning: TIER.critical,
  count_go: TIER.critical,

  // 4 — WHAT YOU MUST REACT TO. The telegraph is the cue the blind guard was
  // eating most often; the boss beats already forced, and now say so in one
  // place instead of at every call site.
  tell: TIER.telegraph,
  boss_intro: TIER.telegraph,
  boss_phase: TIER.telegraph,
  boss_punish: TIER.telegraph,
  boss_down: TIER.telegraph,
  ident_high: TIER.telegraph,
  verdict: TIER.telegraph,

  // 3 — THE SHOW AND THE LADDER. Rewards, transitions, the System's voice.
  level_up: TIER.progression,
  achievement: TIER.progression,
  lootbox: TIER.progression,
  sponsor: TIER.progression,
  band_sting: TIER.progression,
  descend: TIER.progression,
  descend_whoosh: TIER.progression,
  crowd: TIER.progression,
  ident: TIER.progression,
  stamp: TIER.progression,
  till: TIER.progression,
  door_unlock: TIER.progression,
  door_close: TIER.progression,
  ledger_bank: TIER.progression,
  draft_pick: TIER.progression,
  draft_bank: TIER.progression,
  count_tick: TIER.progression,
  announce: TIER.progression,

  // 2 — THE ACT AND ITS PAYOFF. `kill` sits above `hit` because a death is
  // more information than a blow; the casts sit here with it (§2.2a keeps
  // them UNDER impacts in LEVEL, which is a different axis from this one).
  kill: TIER.act,
  gold: TIER.act,
  item: TIER.act,
  equip: TIER.act,
  heal: TIER.act,
  bolt: TIER.act,
  nova: TIER.act,
  buy: TIER.act,

  // 1 — THE BLOWS. Loud, constant, and the thing there are twenty of.
  hit: TIER.impact,
  crit: TIER.impact,
  swing: TIER.impact,

  // 0 — TEXTURE. Barks are 29-31% of the whole voice budget at pack density —
  // the largest single contributor, and the first thing that should go.
  weapon_flash: TIER.chatter,
  chain_line: TIER.chatter,
};

/** Rank for any id, explicit first then by family. */
export function tierOf(id: SoundId): MixTier {
  const t = TIER_BY_ID[id];
  if (t !== undefined) return t;
  if (id.startsWith("bark_") || id.startsWith("dot_")) return TIER.chatter;
  if (id.startsWith("smash_") || id.startsWith("apply_")) return TIER.impact;
  if (id.startsWith("cast_")) return TIER.act;
  if (id.startsWith("music_")) return TIER.progression; // never routed here
  return TIER.impact;
}

/**
 * VOICE BUDGET: how many voices may already be sounding when a cue of this
 * tier asks. Tiers 4-5 are exempt — the whole point is that the important cue
 * is never crowded out. The measured peaks were 31-59 concurrent; this bounds
 * the crowdable part of that at 12.
 */
const CEILING: readonly number[] = [6, 11, 13, 15, Infinity, Infinity];

/** SELF-OVERLAP: copies of ONE id allowed to sound at once, per tier. */
const SELF_MAX: readonly number[] = [2, 2, 1, 1, 2, 1];

/** FOCUS: a headline cue clears space in the chatter for this long. */
const FOCUS_MS = 220;

/**
 * Cues that open a focus window — the ones that are RARE and must land. Every
 * critical-tier cue opens one too (see openFocus).
 *
 * `level_up` is the reason this set exists as something other than "tier >=
 * 4": §1.3a deliberately keeps it OFF the announcer bus (that bus is the
 * sidechain duck source and a level edge would pump the bed all run), so it
 * had no way to clear space for itself — and it measured 90% buried on FLOOR
 * 3. It gets its room here instead, without touching §2.3's duck matrix.
 *
 * `tell` is deliberately NOT here even though it is telegraph-tier. It fires
 * 100-400 times a fight; a focus window on each one is not a duck, it is a
 * permanent gate, and the first cut of this file measured exactly that —
 * creature barks fell to 0% of the mix at pack density, which trades one
 * unreadable mix for a dead one. The telegraph gets its reach from being
 * un-refusable and un-throttleable, not from silencing the room.
 */
const FOCUS_IDS = new Set<SoundId>([
  "level_up", "achievement", "lootbox", "band_sting", "descend",
  "boss_intro", "boss_phase", "boss_punish", "boss_down", "ident_high", "verdict",
]);

/** Assumed clip length when the sink cannot report one (fake sinks, jsdom).
 *  250ms is the short end of the shipped one-shots (kill 240, swing 190, tell
 *  280, hit 430) on purpose: a sink that cannot answer must not have the
 *  self-overlap rule turn into a rate limit nobody specified. */
const NOMINAL_DUR_MS = 250;

interface Voice {
  id: SoundId;
  tier: MixTier;
  until: number;
}

/** Why a cue did not sound — counted, so the policy is auditable. */
export interface MixStats {
  asked: number;
  played: number;
  refusedCooldown: number;
  refusedSelf: number;
  refusedBudget: number;
  refusedFocus: number;
  peakConcurrent: number;
  /** Per-id {asked, played}, for the before/after table. */
  byId: Record<string, { asked: number; played: number }>;
}

/**
 * The priority-aware sink that sits between AudioDirector and AudioEngine.
 * Pure logic over a clock the caller supplies — no WebAudio, unit-testable
 * with the same FakeSink the director already uses.
 */
export class MixBus {
  private now = 0;
  private voices: Voice[] = [];
  private lastAt = new Map<SoundId, number>();
  private focusUntil = -Infinity;
  private stats: MixStats = MixBus.freshStats();

  constructor(private sink: AudioSink) {}

  private static freshStats(): MixStats {
    return {
      asked: 0, played: 0,
      refusedCooldown: 0, refusedSelf: 0, refusedBudget: 0, refusedFocus: 0,
      peakConcurrent: 0, byId: {},
    };
  }

  /** Advance the clock and expire finished voices. `reset` on a run boundary
   *  (new floor / restart) so a fresh run never inherits a full budget. */
  beginFrame(nowMs: number, reset = false): void {
    if (reset) {
      this.voices.length = 0;
      this.lastAt.clear();
      this.focusUntil = -Infinity;
    }
    this.now = nowMs;
    this.prune();
  }

  private prune(): void {
    if (this.voices.length === 0) return;
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i].until > this.now) this.voices[w++] = this.voices[i];
    }
    this.voices.length = w;
  }

  /** Voices currently sounding (as this layer models them). */
  concurrent(): number {
    this.prune();
    return this.voices.length;
  }

  /** Counters since the last resetStats(). */
  readStats(): MixStats {
    return this.stats;
  }

  resetStats(): void {
    this.stats = MixBus.freshStats();
  }

  /**
   * How long this cue occupies the room, in ms.
   *
   * A sink that can answer is BELIEVED, including when it answers "nothing":
   * an id with no decoded buffer makes no sound (engine.play() no-ops on it)
   * and must not be charged a slot in the budget, or a game missing half its
   * clips would mask itself into silence. A sink that cannot answer at all
   * (test fakes, jsdom) gets the nominal length, which keeps the policy
   * deterministic rather than free.
   */
  private durationOf(id: SoundId): number {
    if (!this.sink.duration) return NOMINAL_DUR_MS;
    const d = this.sink.duration(id);
    return d !== undefined && d > 0 ? d * 1000 : 0;
  }

  /**
   * Ask for a cue. Returns true if it was admitted and forwarded to the sink.
   *
   * `tierOverride` is for cues whose IMPORTANCE is not a property of the clip:
   * the multi-kill emphasis is the same `kill` file as an ordinary kill and
   * must not be refused (see AudioDirector.killCue).
   */
  play(id: SoundId, opts: PlayOpts = {}, tierOverride?: MixTier): boolean {
    this.prune();
    const tier = tierOverride ?? tierOf(id);
    const s = this.stats;
    s.asked++;
    const per = (s.byId[id] ??= { asked: 0, played: 0 });
    per.asked++;

    const focused = this.now < this.focusUntil;
    if (!opts.force) {
      // 1. Per-id retrigger cooldown. The floor is the manifest's own
      //    throttleMs, so nothing here can make a clip retrigger FASTER than
      //    it does today — this layer only ever removes voices.
      const def: SoundDef | undefined = AUDIO_MANIFEST[id];
      const gap = def?.throttleMs ?? 70;
      const last = this.lastAt.get(id) ?? -Infinity;
      if (this.now - last < gap) {
        s.refusedCooldown++;
        return false;
      }
      // 2. Self-overlap.
      const selfMax = SELF_MAX[tier] ?? 1;
      let selfLive = 0;
      for (const v of this.voices) if (v.id === id) selfLive++;
      if (selfLive >= selfMax) {
        s.refusedSelf++;
        return false;
      }
      // 3/4. Budget + focus. Tiers 4-5 skip both: they are what the budget is
      //      being kept clear FOR.
      if (tier <= TIER.progression) {
        if (focused && tier === TIER.chatter) {
          s.refusedFocus++;
          return false;
        }
        let cap = CEILING[tier] ?? Infinity;
        if (focused && tier <= TIER.act) cap = Math.ceil(cap / 2);
        if (this.voices.length >= cap) {
          if (focused) s.refusedFocus++;
          else s.refusedBudget++;
          return false;
        }
      }
    }

    this.lastAt.set(id, this.now);
    this.voices.push({ id, tier, until: this.now + this.durationOf(id) });
    if (this.voices.length > s.peakConcurrent) s.peakConcurrent = this.voices.length;
    if (tier >= TIER.critical || FOCUS_IDS.has(id)) this.focusUntil = this.now + FOCUS_MS;
    s.played++;
    per.played++;
    // Tiers 4-5 bypass the engine's blind FIFO guard as well: this layer is
    // now their rate limit, and it has just decided they matter. Everything
    // below keeps the engine guard as a second net — it can only remove more.
    this.sink.play(id, tier >= TIER.telegraph && !opts.force ? { ...opts, force: true } : opts);
    return true;
  }
}
