import io, json
base = "src/sim/bosses.ts"
s = io.open(base, encoding="utf-8", newline="").read()

anchor = "const BY_ID = new Map<BossId, BossDef>();"
assert s.count(anchor) == 1

block = '''// ---------------------------------------------------------------------------
// THE BAND SIGNATURES, IN EACH BOSS'S OWN VOICE.
//
// Acceptance review, round 3: "ENTANGLING ROOTS" was the live beat line on the
// Topiary Warden (break-the-shield), the Zoning Board (kill-the-adds) AND the
// Condemned Architect (use-the-arena). Three different bosses, three different
// asks, ONE readout. The four shipped band signatures are shared HAZARDS - the
// arena director fires them on floors 6/9/15 whoever the boss is, and a boss
// past phase 1 alternates into the previous band's (BORROWED in ai.ts) - but a
// shared hazard must not mean a shared NAME, exactly as RITUAL_LABEL already
// established for the tier-3 channel.
//
// So the mechanic stays shared and the label is identity. Every boss that can
// ever be standing next to one of these four owns its own word for it.
// ---------------------------------------------------------------------------

/** The band signature's own name when nobody has renamed it. */
export const BAND_SIG_DEFAULT: Record<string, string> = {
  flood: "FLOOD SURGE",
  roots: "ENTANGLING ROOTS",
  debris: "DEBRIS RAIN",
  flamewall: "FLAME SWEEP",
  graverising: "CHECK-IN",
};

/**
 * Per-boss renames. A row exists for every (boss, signature) pair the sim can
 * actually produce: the boss's OWN band signature, the one its arena director
 * fires at it, and the one BORROWED hands it from phase 1.
 */
export const BAND_SIG_LABEL: Partial<Record<BossId, Partial<Record<string, string>>>> = {
  // ---- floor 6: the arena director floods for all three ---------------------
  sumpking: { flood: "FLOOD SURGE", graverising: "THE DROWNED RISE" },
  inspector: { flood: "SEWER BACKUP", graverising: "CONDEMNED, RISING" },
  greasetrap: { flood: "THE GREASE RISES", graverising: "SKIMMED OFF THE TOP" },
  // ---- floor 9: the director regrows for all three -------------------------
  topiary: { roots: "HEDGE GRASP", flood: "IRRIGATION SURGE" },
  zoningboard: { roots: "EASEMENT CLAIMED", flood: "STORMWATER VARIANCE" },
  pollinator: { roots: "RUNNER ROOTS", flood: "GROUNDWATER BLOOM" },
  // ---- floor 12: no director, so only its own and its borrowed one ---------
  architect: { debris: "DEBRIS RAIN", roots: "CREEPING RUIN" },
  permitoffice: { debris: "CONDEMNATION NOTICE", roots: "UNPERMITTED GROWTH" },
  foundation: { debris: "SPALL", roots: "SUBSIDENCE" },
  // ---- floor 15: the director vents for all three --------------------------
  marshal: { flamewall: "FLAME SWEEP", debris: "CEILING FAILURE" },
  linesupervisor: { flamewall: "LINE PURGE", debris: "TOOL DROP" },
  safetyofficer: { flamewall: "EVACUATION DRILL", debris: "OVERHEAD HAZARD" },
  // ---- floor 18: a finale can wear any of them, so all four are named ------
  showrunner: {
    flamewall: "PYRO CUE", debris: "SET COLLAPSE",
    roots: "GREEN ROOM", flood: "WATER FEATURE",
  },
  standards: {
    flamewall: "CENSURE", debris: "STRUCK FROM THE RECORD",
    roots: "TABLED", flood: "MOTION TO FLOOD",
  },
  sponsor: {
    flamewall: "AD SPOT: FIRE", debris: "PRODUCT PLACEMENT",
    roots: "ORGANIC REACH", flood: "SPONSORED CONTENT",
  },
  // ---- floor 3 (the Concierge's own graverising keeps its shipped name) -----
  rentcollector: { graverising: "PAST-DUE ACCOUNTS" },
  temp: { graverising: "PREVIOUS TEMPS" },
};

/**
 * What THIS boss calls a shared band signature. Pure, total, and the one
 * source of truth for the label the sim puts on the `telegraph` event - the
 * plate's beat line, the per-boss FX and the per-boss telegraph SOUND all key
 * off that label, so renaming here renames the whole beat.
 */
export function bandSignatureLabel(sig: string, bossId?: BossId): string {
  const fallback = BAND_SIG_DEFAULT[sig] ?? sig.toUpperCase();
  if (!bossId) return fallback;
  return BAND_SIG_LABEL[bossId]?.[sig] ?? fallback;
}

/** Every distinct label the band signatures can emit (host FX/sound tables). */
export function allBandSignatureLabels(): string[] {
  const out = new Set<string>(Object.values(BAND_SIG_DEFAULT));
  for (const row of Object.values(BAND_SIG_LABEL)) {
    for (const label of Object.values(row ?? {})) if (label) out.add(label);
  }
  return [...out];
}

'''
s = s.replace(anchor, block + anchor, 1)
io.open(base, "w", encoding="utf-8", newline="").write(s)
print("ok")
