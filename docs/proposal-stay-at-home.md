# Proposal: stay-at-home messaging

A design note, not yet agreed. Nothing here is built except the trait it rests on
(`Sim.compliance`, reference "The trait review"). Kettling is a late maybe and is not part
of this.

## What it is

A third citywide channel, beside the rescue broadcast and the reservists' call-up: the
authorities telling everyone to stay indoors. It is the first instruction in the model that
asks people to do *less* — and the first whose answer is governed by a response to
authority rather than to danger.

Two questions decide what each person does with it, and they are different traits:

| Question | Trait | Low end | High end |
|---|---|---|---|
| Is it real? | trust | dismisses it as rumour | believes it |
| Will I do it? | compliance | carries on | stays put |

Only someone who both believes it and complies stays in. A credulous but defiant person
knows the danger and goes out anyway; a sceptic who would obey never hears it as an order.
That split is what lets a sweep say whether staying home saves people, and who.

## When it goes out

Proposed: **when the cordon closes** (`Exit.closedAt`). The city is sealed; the message is
what the authorities have left to say. It must not key on district release or evacuation:
those fields are read only by `release.ts` (CLAUDE.md, restricted reads).

Alternative: a fixed delay after the first 911 calls (earlier, while most people are still
going about their day).

## What it does

- **Heard by everyone tracked**, indoors or out, like the rescue broadcast.
- **It makes the unaware aware.** A citywide message about an outbreak is news, whatever one
  makes of the order. (Open question below.)
- **Believed and obeyed** (trust above a floor, and a compliance roll):
  - *indoors*: stays — no migrating to a better shelter, no scavenging, no supply runs,
    no leaving for an exit — until something overrides it (below);
  - *outdoors*: makes for home if home is near and believed safe, else the nearest shelter
    it knows, and stays there.
- **Disbelieved or defied**: carries on as now.

**What overrides it** (the order is never a cage):
- the building breached, or the dead inside (expulsion by panic stays as it is);
- supplies gone for `supplies.leaveAfter` (hunger beats orders);
- the rescue broadcast — the newer instruction wins for those who answer it.

## What it touches

- **Admission:** fewer people on the move means fewer strangers at doors; the refusal count
  (about 10,000 a run) should fall.
- **The shelter economy:** no scavenging by the obedient means supplies run out sooner in
  obedient households; whether that kills more than staying in saves is a finding, not a
  guess to tune away.
- **Claustrophobes:** a diehard never goes in, order or not; the order meets the enclosure
  trait head on, and the diehard's refusal is the trait, not defiance.
- **Dead air** (open item 3): a city that obeys goes quiet. The ticker may need to say so
  ("The streets are empty; the city is staying in").

## What to measure

Survival by compliance band (the sweep already reports it), by trust × compliance
together, time spent outdoors after the message, refusals at doors, scavenging trips,
households that run out of supplies, and dead-air windows.

## Questions for the user

1. When does it go out: when the cordon closes, or earlier?
2. Does hearing it make the unaware aware?
3. Does it last until the rescue broadcast, or lapse after a while?
4. Should the police enforce it — telling people on the street to go in (no force)? That is
   the first step toward corralling, and toward kettling if that is ever added.
