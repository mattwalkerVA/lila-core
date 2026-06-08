// Timezone-aware formatting for event times. Every surface that renders a
// stored UTC timestamp to a user MUST go through here — never getUTCHours()
// or getHours() directly. Stored timestamps are UTC; users think in their
// own zone. The user's IANA zone lives on profiles.timezone (default UTC).
//
// History: event times were rendered with getUTCHours(), so a 6pm ET event
// stored as 22:00Z showed as "22:00". This module is the single fix point.

const FALLBACK_TZ = 'UTC'

// "18:00" in the given zone for a UTC timestamp. 24-hour, zero-padded.
export function formatLocalTime(utcString: string, tz: string | null | undefined): string {
  const d = new Date(utcString)
  if (isNaN(d.getTime())) return ''
  // sv-SE gives "HH:MM" 24-hour; en-CA gives "YYYY-MM-DD" for dates.
  return d.toLocaleTimeString('sv-SE', {
    timeZone: tz || FALLBACK_TZ,
    hour: '2-digit',
    minute: '2-digit',
  })
}

// "h:mma" lowercase (e.g. "6:00pm") for a UTC timestamp in the given zone.
export function formatLocalTime12(utcString: string, tz: string | null | undefined): string {
  const d = new Date(utcString)
  if (isNaN(d.getTime())) return ''
  return d
    .toLocaleTimeString('en-US', {
      timeZone: tz || FALLBACK_TZ,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/\s/g, '')
    .toLowerCase()
}

// { date: "YYYY-MM-DD", time: "HH:MM" | null } for a UTC timestamp in the
// given zone. time is null when the source string is date-only (length 10).
export function localDateParts(
  utcString: string,
  tz: string | null | undefined,
): { date: string; time: string | null } {
  const d = new Date(utcString)
  if (isNaN(d.getTime())) return { date: utcString.slice(0, 10), time: null }
  const local = d.toLocaleString('sv-SE', { timeZone: tz || FALLBACK_TZ })
  const [date, timeWithSeconds] = local.split(' ')
  const time = utcString.length > 10 ? timeWithSeconds.slice(0, 5) : null
  return { date, time }
}

// Today's date "YYYY-MM-DD" in the given zone.
export function localToday(tz: string | null | undefined): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz || FALLBACK_TZ })
}
