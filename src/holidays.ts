// -----------------------------------------------------------------------------
// Holiday resolution for dayparting
// -----------------------------------------------------------------------------
// Maps holiday names to a concrete { month, day } for a given year. Fixed-date
// holidays ignore the year; computed holidays (Easter, US Thanksgiving, the
// "nth weekday of month" style US holidays) are derived per-year so a daypart
// like `holiday: thanksgiving` lands on the right date every year of a build.
//
// Months are 1..12 and days are 1..31 (calendar convention), NOT the 0-based
// month that JS Date uses — callers convert at the boundary.

export interface MonthDay { month: number; day: number }

/** Nth (1-based) `weekday` of `month` in `year`. weekday: 0=Sun..6=Sat. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): MonthDay {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;      // days until the first such weekday
  return { month, day: 1 + offset + (n - 1) * 7 };
}

/** Last `weekday` of `month` in `year`. weekday: 0=Sun..6=Sat. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): MonthDay {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  const back = (lastDow - weekday + 7) % 7;
  return { month, day: lastDay - back };
}

/** Western (Gregorian) Easter Sunday for `year` — Anonymous/Meeus algorithm. */
function easter(year: number): MonthDay {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Offset a MonthDay by whole days within its year (handles month roll-over). */
function addDays(year: number, md: MonthDay, days: number): MonthDay {
  const d = new Date(Date.UTC(year, md.month - 1, md.day + days));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

type Resolver = (year: number) => MonthDay | null;

// Hanukkah follows the Hebrew calendar: the evening the first candle is lit, per year.
const HANUKKAH: Record<number, MonthDay> = {
  2024: { month: 12, day: 25 }, 2025: { month: 12, day: 14 }, 2026: { month: 12, day: 4 }, 2027: { month: 12, day: 24 },
  2028: { month: 12, day: 12 }, 2029: { month: 12, day: 1 }, 2030: { month: 12, day: 20 }, 2031: { month: 12, day: 9 },
  2032: { month: 11, day: 27 }, 2033: { month: 12, day: 16 }, 2034: { month: 12, day: 6 }, 2035: { month: 12, day: 25 },
  2036: { month: 12, day: 13 }, 2037: { month: 12, day: 2 }, 2038: { month: 12, day: 21 }, 2039: { month: 12, day: 11 },
  2040: { month: 11, day: 29 },
};

// Fixed-date holidays (year-independent).
const FIXED: Record<string, MonthDay> = {
  new_years: { month: 1, day: 1 },
  new_years_day: { month: 1, day: 1 },
  valentines: { month: 2, day: 14 },
  valentines_day: { month: 2, day: 14 },
  st_patricks: { month: 3, day: 17 },
  st_patricks_day: { month: 3, day: 17 },
  april_fools: { month: 4, day: 1 },
  juneteenth: { month: 6, day: 19 },
  independence_day: { month: 7, day: 4 },
  july_fourth: { month: 7, day: 4 },
  fourth_of_july: { month: 7, day: 4 },
  halloween: { month: 10, day: 31 },
  veterans_day: { month: 11, day: 11 },
  christmas_eve: { month: 12, day: 24 },
  christmas: { month: 12, day: 25 },
  christmas_day: { month: 12, day: 25 },
  new_years_eve: { month: 12, day: 31 },
};

// Computed (per-year) holidays.
const COMPUTED: Record<string, Resolver> = {
  mlk_day: (y) => nthWeekdayOfMonth(y, 1, 1, 3),            // 3rd Monday of January
  presidents_day: (y) => nthWeekdayOfMonth(y, 2, 1, 3),    // 3rd Monday of February
  easter: (y) => easter(y),
  good_friday: (y) => addDays(y, easter(y), -2),
  easter_monday: (y) => addDays(y, easter(y), 1),
  mothers_day: (y) => nthWeekdayOfMonth(y, 5, 0, 2),       // 2nd Sunday of May
  memorial_day: (y) => lastWeekdayOfMonth(y, 5, 1),        // last Monday of May
  fathers_day: (y) => nthWeekdayOfMonth(y, 6, 0, 3),       // 3rd Sunday of June
  labor_day: (y) => nthWeekdayOfMonth(y, 9, 1, 1),         // 1st Monday of September
  columbus_day: (y) => nthWeekdayOfMonth(y, 10, 1, 2),     // 2nd Monday of October
  indigenous_peoples_day: (y) => nthWeekdayOfMonth(y, 10, 1, 2),
  thanksgiving: (y) => nthWeekdayOfMonth(y, 11, 4, 4),     // 4th Thursday of November (US)
  thanksgiving_us: (y) => nthWeekdayOfMonth(y, 11, 4, 4),
  thanksgiving_eve: (y) => addDays(y, nthWeekdayOfMonth(y, 11, 4, 4), -1),
  black_friday: (y) => addDays(y, nthWeekdayOfMonth(y, 11, 4, 4), 1),
  cyber_monday: (y) => addDays(y, nthWeekdayOfMonth(y, 11, 4, 4), 4),
  hanukkah: (y) => HANUKKAH[y] ?? null,                    // first night (evening of the 1st candle)
  chanukah: (y) => HANUKKAH[y] ?? null,
};

/** Canonical form of a holiday token (lowercase, non-alnum -> underscore). */
export function normalizeHolidayName(name: string): string {
  return String(name).trim().toLowerCase().replace(/[\s.'-]+/g, "_").replace(/_+/g, "_");
}

/** True if `name` is a holiday this module knows how to resolve. */
export function isKnownHoliday(name: string): boolean {
  const k = normalizeHolidayName(name);
  return k in FIXED || k in COMPUTED;
}

/** All holiday tokens this module understands (for docs / validation). */
export function knownHolidays(): string[] {
  return [...Object.keys(FIXED), ...Object.keys(COMPUTED)].sort();
}

/** Resolve a holiday name to its { month, day } in `year`, or null if unknown. */
export function holidayDate(name: string, year: number): MonthDay | null {
  const k = normalizeHolidayName(name);
  if (k in FIXED) return FIXED[k];
  if (k in COMPUTED) return COMPUTED[k](year);
  return null;
}
