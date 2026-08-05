// First-contact System tips (VOICE.md): the books' System explains rules
// diegetically, just-in-time, and condescendingly — patch notes and pop-ups
// nobody reads until they matter. Each tip fires ONCE per crawler, the first
// time the rule actually touches them, then never again (Player.tipsSeen,
// persisted with the save). Nothing is taught up front; emergent discovery
// stays intact — the System just files a courtesy explanation after the fact.
//
// Authoring rules: System register (show-aware but bored — see VOICE.md),
// 1-2 sentences of rule, one beat of snark. Trigger sites live in game.ts —
// grep systemTip( for all of them.
//
// THE SYSTEM NEVER POINTS AT YOUR CHROME (r4 voice). It audits ledgers, posts
// notices, and files explanations; it has never conceded that you have a HUD,
// a badge, or a bottom of a screen. When a line must direct the player
// somewhere, it names the System's own instrument ("the notice", "a Safe
// Room's ACHIEVEMENTS tab" — a place in the dungeon) and not the player's
// furniture. The onramp names KEYS, because keys are the crawler's own
// equipment; nothing in here names pixels.
export const TIPS: Record<string, string> = {
  interference:
    "COURTESY EXPLANATION: your broadcast flatlined, so the System scheduled content. Sustained hype prevents recurrence. Boring crawlers are corrected; entertaining ones are left alone.",
  sponsors:
    "COURTESY EXPLANATION: hype converts viewers into FAVORITES — sticky fans. Enough favorites attract a SPONSOR, and sponsors send gifts between floors. The show is the economy.",
  favorites:
    "COURTESY EXPLANATION: the crowd has FAVORITES now — fans who keep watching after the excitement fades. They accumulate while your hype runs hot. They are the ones sponsors count.",
  stagger:
    "COURTESY EXPLANATION: you STAGGERED it. Damage builds hidden POISE; enough poise interrupts whatever it was doing. Poise fades fast, so interrupts take a BURST. Heavier creatures have more poise. This was not designed to be fair.",
  staggerGrace:
    "COURTESY EXPLANATION: headliners are professionals. After a stagger, this one keeps its COMPOSURE for a few seconds — poise will not build again until the window passes. Reruns bore the audience.",
  bolt:
    "COURTESY EXPLANATION: your BOLT is thrown by your WEAPON. Crossbows loose physical bolts; wands and staffs cast magic ones. Same button, different physics, different resists.",
  extradition:
    "COURTESY EXPLANATION: that one was too heavy to move, so the chain moved YOU. Mass decides the direction of every extradition. The paperwork is identical.",
  afflicted:
    "COURTESY EXPLANATION: you are AFFLICTED. Status effects tick on their own clock — dashing dodges hits, not chemistry. Time cures everything it doesn't kill first.",
  service:
    "COURTESY EXPLANATION: this room is OPEN FOR BUSINESS. Some rooms still take customers — rarely, and never for free. Terms are posted. The System takes a cut either way.",
  lowhp:
    "COURTESY EXPLANATION: your near-death experience is EXCELLENT television — surviving below a third of your health pays bonus hype. Dying pays nothing. The distinction matters.",
  overrank:
    "COURTESY EXPLANATION: an OVERRANK is a rank past the printed maximum. The draft lottery occasionally offers one. This is not a bug; it is a promotional event.",
  achievementClaim:
    "COURTESY EXPLANATION: that unlock queued a LOOT BOX. It will not open itself — collect it from a Safe Room's ACHIEVEMENTS tab. The System does not ship rewards to your door.",
  collapse:
    "COURTESY EXPLANATION: this floor is on a clock, and the clock has opinions now. When it runs out, the floor becomes the hazard. The stairs are down. Punctuality is survivable. Sentiment is not.",
  draftBanked:
    "COURTESY EXPLANATION: your level-up minted a DRAFT. The System has posted the notice and will keep posting it until the draft is redeemed. Redeem it somewhere quiet — drafts do not spoil, and they do not spend themselves.",
  hype:
    "COURTESY EXPLANATION: that was loud, and your HYPE reading moved. Hype buys VIEWERS, viewers are the meter every payout downstream is read off, and both bleed back down the moment you get careful. The System does not sell tickets to careful.",
  glyph:
    "COURTESY EXPLANATION: that is a GLYPH — firmware for ONE ability. It does not make the ability bigger; it makes it behave differently. It stays banked until a socket and a Safe Room exist at the same time. Firmware is not installed in traffic.",
};
