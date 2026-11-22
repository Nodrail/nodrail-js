// The calendar window a numeric budget counts in (C03): a day in an IANA
// time zone, as people there see it, so a day is 23 or 25 hours long when
// the clocks change. Step and run budgets have no calendar window. Pure:
// Intl does the time zone arithmetic, no clock is read here.

/** Whether `name` is a time zone this runtime knows (IANA, or UTC). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name);
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (timeZone: string) => {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formats.set(timeZone, format);
  }
  return format;
};

/** The local date at an instant, `YYYY-MM-DD`. */
export function localDate(at: Date, timeZone: string): string {
  const parts = formatFor(timeZone).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const HOUR = 3_600_000;

/**
 * The first instant whose local date is `date` or later. Local dates only
 * go forward with time, so a search between 14 hours either side of UTC
 * midnight finds it, even where a clock change skips local midnight.
 */
function startOf(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const utc = Date.UTC(year, month - 1, day);
  let low = utc - 15 * HOUR;
  let high = utc + 15 * HOUR;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(new Date(middle), timeZone) >= date) high = middle;
    else low = middle;
  }
  return new Date(high);
}

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

export type DayWindow = {
  /** The local date, which names the window. */
  key: string;
  start: Date;
  /** Exclusive: the next day's start, when the budget resets. */
  end: Date;
};

/** The day window `at` falls in, in `timeZone`. */
export function dayWindow(at: Date, timeZone: string): DayWindow {
  const key = localDate(at, timeZone);
  return {
    key,
    start: startOf(key, timeZone),
    end: startOf(nextDate(key), timeZone),
  };
}

/** Whether two instants fall in the same local day. */
export const sameDay = (a: Date, b: Date, timeZone: string) =>
  localDate(a, timeZone) === localDate(b, timeZone);
