// CLASS REVISION — milestone castings (VOICE.md: System-voiced, deadpan).
// Clearing a band boss (floors 3/6/9) earns a pick-1 draft on the descent:
// three permanent, build-warping, slightly-cursed recastings plus the option
// to REMAIN UNCAST (defiance pays a small permanent hype bonus). Revisions
// ride the sponsor-draft plumbing (Player.pendingRewards) and their rules
// hook the existing choke points in game.ts — grep hasRevision() for all of
// them. Ids live on Player.revisions and persist for the run.
export interface RevisionDef {
  id: string;
  title: string;
  desc: string;
}

export const REVISIONS: Record<string, RevisionDef> = {
  // Floor 4 pool — identity: how you fight.
  underdog: {
    id: "underdog", title: "THE UNDERDOG",
    desc: "Below 35% HP: +25% damage and DOUBLE hype. Max HP -10% — the audience prefers you hurt",
  },
  heavy: {
    id: "heavy", title: "THE HEAVY",
    desc: "+20% max HP and +10 armor. Dash recharges 50% slower — mass keeps its own schedule",
  },
  parkour: {
    id: "parkour", title: "PARKOUR ARTIST",
    desc: "A third dash charge and +10% move speed. Max HP -15% — insurance application denied",
  },
  // Floor 7 pool — economy: what feeds the run.
  sellout: {
    id: "sellout", title: "CORPORATE SELLOUT",
    desc: "Sponsors sign 25% earlier. The network deducts 15% of every gold pickup",
  },
  typecast: {
    id: "typecast", title: "TYPECAST",
    desc: "All ability cooldowns -15%. THE FIVE lock permanently — no re-slotting, ever",
  },
  scavenger: {
    id: "scavenger", title: "SCAVENGER ROYALTY",
    desc: "Corpses near you crumble into gold — and out of every necromancer's reach",
  },
  // Floor 10 pool — run-definers.
  pet: {
    id: "pet", title: "PRODUCER'S PET",
    desc: "Once per floor a killing blow leaves you at 1 HP — saved in post. The System gets bored of you 50% faster",
  },
  canceled: {
    id: "canceled", title: "CANCELED",
    desc: "Hype resets to ZERO and gains are halved. Undamaged enemies take +50% — nobody sees a dead crawler coming",
  },
  regular: {
    id: "regular", title: "SERIES REGULAR",
    desc: "Level-up drafts deal a 4th card. Every remaining floor's collapse timer runs 15% shorter",
  },
};

/** The pool offered on arrival at a milestone floor (CONFIG.revisionFloors). */
export function revisionPool(arrivalFloor: number, milestoneFloors: number[]): string[] {
  const idx = milestoneFloors.indexOf(arrivalFloor);
  if (idx === 0) return ["underdog", "heavy", "parkour"];
  if (idx === 1) return ["sellout", "typecast", "scavenger"];
  if (idx === 2) return ["pet", "canceled", "regular"];
  return [];
}
