# Dayparting

Dayparting lets one channel run **different programming depending on the day and
time** — weekday mornings, weekend afternoons, overnight blocks, and special
**holiday / seasonal** programming — instead of a single linear playout.

A channel opts into dayparting by adding a `dayparts:` grid to its YAML. Each
rule points at a `sequence`, and the engine runs whichever rule covers the
current instant, fills that window with its sequence, then re-evaluates.

- [Quick start](#quick-start)
- [How matching works](#how-matching-works)
- [Rule reference](#rule-reference)
  - [Days of week](#days-of-week)
  - [Time window](#time-window)
  - [Months](#months)
  - [Specific dates](#specific-dates)
  - [Date ranges](#date-ranges)
  - [Holidays](#holidays)
- [Precedence & ordering](#precedence--ordering)
- [Window boundaries (soft edges)](#window-boundaries-soft-edges)
- [Per-channel model](#per-channel-model)
- [Worked examples](#worked-examples)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```yaml
# ... content: and sequence: blocks define what MORNING/DAYTIME/etc. play ...

dayparts:
  - label: Weekday mornings
    days: [mon, tue, wed, thu, fri]
    from: "06:00"
    to: "12:00"
    sequence: MORNING
  - label: Weekend mornings
    days: [sat, sun]
    from: "06:00"
    to: "12:00"
    sequence: WEEKEND
  - label: Daytime            # no days -> every day
    from: "12:00"
    to: "20:00"
    sequence: DAYTIME
  - label: Overnight (default)  # no constraints -> catch-all, put it LAST
    sequence: OVERNIGHT
```

A full runnable example lives at `examples/channels/example-dayparts.yml`.

---

## How matching works

For the instant being scheduled, the engine walks the `dayparts:` list **top to
bottom and uses the first rule that matches** (first-match-wins). A rule matches
when **every** constraint it declares is satisfied:

```
match = days-of-week matches
    AND time-of-day is inside [from, to)
    AND every date facet present (months / dates / ranges / holidays) matches
```

Any constraint you omit is treated as "matches anything". A rule with **no**
constraints at all is a catch-all that always matches — which is why it belongs
last, as the default.

All day/time/date reasoning happens in the channel's **local wall clock**, using
the fixed UTC offset the build runs with (`--offset` minutes, e.g. `-300` for
US Central). Weekday, time-of-day, and calendar date are all derived from that
local clock.

---

## Rule reference

Every rule needs a `sequence:` (the content to run) and usually a `label:` (for
readability and preview/logs). Everything else is an optional filter.

### Days of week

```yaml
days: [mon, tue, wed, thu, fri]
```

Accepted tokens (case-insensitive): `sun mon tue wed thu fri sat` (plus long
forms `sunday`…`saturday` and `tues/thur/thurs`), and the groups `weekday` /
`weekdays` (Mon–Fri), `weekend` / `weekends` (Sat+Sun), and `all` / `daily`.
Omit `days` to match every day.

### Time window

```yaml
from: "06:00"   # inclusive, minutes from local midnight
to:   "12:00"   # exclusive
```

- `from` defaults to `00:00`, `to` defaults to end-of-day.
- `to: "24:00"` (or `"00:00"`) means end-of-day (`1440`).
- Windows are half-open `[from, to)`, so back-to-back windows like `06:00→12:00`
  and `12:00→20:00` don't overlap or leave a gap.

A window that crosses midnight is expressed as two rules (e.g. `20:00→24:00` and
`00:00→06:00`) both pointing at the same sequence.

### Months

```yaml
months: [dec]          # or [12], or [nov, dec], or [11, 12]
```

Matches when the current month is in the list. Month tokens: `jan…dec` (and long
names), or numbers `1`–`12`. Great for "December holiday look" seasonal skins.

### Specific dates

```yaml
date: "2026-07-04"     # a single calendar day in one specific year
# or annual (no year), repeats every year:
date: "07-04"
# or several at once:
dates: ["12-24", "12-25", "12-31"]
```

Formats: `YYYY-MM-DD` (one specific year) or `MM-DD` / `M/D` (annual — matches
that month/day **every** year). `date:` and `dates:` are interchangeable and may
be combined.

### Date ranges

```yaml
date_from: "12-20"     # inclusive
date_to:   "12-31"
```

or on one line:

```yaml
date_range: "12-26 .. 01-02"   # separators: "..", "~", or "to"
```

- Annual ranges (`MM-DD`) repeat every year and **may wrap the year end** —
  `12-26 .. 01-02` correctly covers Dec 26 → Jan 2.
- Dated ranges (`YYYY-MM-DD` on both ends) match one specific span.
- Aliases: `from_date` / `to_date` also work.

### Holidays

```yaml
holiday: christmas        # resolves to the right date every year
# or several:
holidays: [thanksgiving, black_friday]
```

Holiday names are resolved **per build year**, so fixed-date and computed
holidays (e.g. the 4th-Thursday-of-November US Thanksgiving, or Easter) always
land correctly. Names are case-insensitive and accept spaces, dots, apostrophes,
or hyphens (e.g. `"New Year's Eve"` == `new_years_eve`).

A holiday is a single day. For a multi-day holiday block, combine a `holiday:`
rule (the day itself) with a `date_from`/`date_to` range for the surrounding
days, or just use a range.

**Known holiday tokens**

| Category | Tokens |
| --- | --- |
| Fixed date | `new_years` (`new_years_day`), `valentines` (`valentines_day`), `st_patricks` (`st_patricks_day`), `april_fools`, `juneteenth`, `independence_day` (`july_fourth`, `fourth_of_july`), `halloween`, `veterans_day`, `christmas_eve`, `christmas` (`christmas_day`), `new_years_eve` |
| Computed (per year) | `mlk_day`, `presidents_day`, `good_friday`, `easter`, `easter_monday`, `mothers_day`, `memorial_day`, `fathers_day`, `labor_day`, `columbus_day` (`indigenous_peoples_day`), `thanksgiving` (`thanksgiving_us`), `thanksgiving_eve`, `black_friday`, `cyber_monday` |

Computed holidays currently follow **US** conventions. If you need a holiday not
listed, use an explicit `date:` / `date_range:` instead.

---

## Precedence & ordering

Because matching is first-match-wins:

1. Put the **most specific** rules first — holidays and specific dates at the
   very top, then seasonal (`months` / ranges), then the weekly grid, then the
   catch-all default **last**.
2. A holiday rule with no `from`/`to` covers the **entire** holiday and will
   pre-empt every normal rule that day, because it appears earlier in the list.
3. A specific date rule beats a `months` rule beats a plain weekday rule — but
   only if you order them that way. The engine does not sort for you.

```yaml
dayparts:
  - {label: Christmas Day, holiday: christmas, sequence: XMAS_MARATHON}   # 1: exact day
  - {label: Christmas week, date_from: "12-20", date_to: "12-31", sequence: HOLIDAY}  # 2: block
  - {label: December, months: [dec], sequence: WINTER}                    # 3: month
  - {label: Weekday AM, days: [weekday], from: "06:00", to: "12:00", sequence: MORNING}  # 4
  - {label: Default, sequence: OVERNIGHT}                                 # 5: catch-all
```

---

## Window boundaries (soft edges)

Daypart boundaries are **soft**: an item that starts before a boundary is allowed
to finish cleanly rather than being cut off. When the active rule changes (a new
window, a date rollover at midnight, the start/end of a holiday), the engine
picks up the new rule at the next item. This means the visible switch can land a
few minutes after the nominal boundary — by design, so nothing is chopped.

The engine detects rule changes at every window edge **and every midnight** in
its look-ahead horizon, so date- and holiday-based transitions are honored even
when no `from`/`to` edge coincides with them.

---

## Per-channel model

Dayparting is defined **per channel** — each channel's YAML carries its own
`dayparts:` grid, so channels are independent by construction and one channel's
holiday block never affects another. To reuse a grid across channels, copy the
`dayparts:` block between files (they're plain YAML). A channel with no
`dayparts:` simply runs its linear `playout:` as before; adding the grid is
purely additive and backward-compatible.

---

## Worked examples

**Holiday marathon all day, normal grid otherwise**

```yaml
dayparts:
  - {label: Christmas, holiday: christmas, sequence: XMAS_MARATHON}
  - {label: Weekday AM, days: [weekday], from: "06:00", to: "12:00", sequence: MORNING}
  - {label: Daytime, from: "12:00", to: "20:00", sequence: DAYTIME}
  - {label: Overnight, sequence: OVERNIGHT}
```

**"Spooky season" for all of October, ramping to a Halloween-night block**

```yaml
dayparts:
  - {label: Halloween night, holiday: halloween, from: "18:00", to: "24:00", sequence: HALLOWEEN_PRIMETIME}
  - {label: October, months: [oct], sequence: SPOOKY}
  - {label: Default, sequence: NORMAL}
```

**New Year's Eve countdown window**

```yaml
dayparts:
  - {label: NYE countdown, date: "12-31", from: "22:00", to: "24:00", sequence: COUNTDOWN}
  - {label: Default, sequence: NORMAL}
```

**Year-end holiday week (wraps into January)**

```yaml
dayparts:
  - {label: Holiday week, date_range: "12-26 .. 01-02", sequence: HOLIDAY}
  - {label: Default, sequence: NORMAL}
```

---

## Troubleshooting

- **A holiday/date rule never fires.** Check ordering — a broader rule above it
  is matching first. Move the specific rule higher.
- **The default runs on a holiday.** The holiday rule is probably below the
  weekday/daytime rules. Holiday and date rules must come first.
- **A range didn't cover the days I expected.** Ranges are inclusive on both
  ends; annual `MM-DD` ranges wrap the year end, dated `YYYY-MM-DD` ranges do
  not. Mixing a dated end with an annual end is not supported — use the same
  style on both ends.
- **The switch happened a few minutes late.** That's the soft-boundary behavior;
  the in-progress item finishes before the new window takes over.
- **Wrong local time.** Day/time/date use the build's fixed `--offset`. DST-aware
  IANA time zones are a planned upgrade; for now pick the offset your channel
  should run at.
