/**
 * Turning a RunTimes cron expression into a local wall-clock time.
 *
 * The orchestrator's schedules are stored and run in UTC -- `0 13 * * *` fires at
 * 13:00 UTC -- but nobody here works in UTC, so reading a schedule off the screen
 * means doing the offset in your head and getting it wrong twice a year. These
 * render the same expression in Central, which is the time everyone means when
 * they say "it runs at eight".
 *
 * The conversion is anchored to *today*, deliberately: a fixed UTC cron moves
 * against the local clock when DST flips, so `0 13 * * *` genuinely is 8:00 AM in
 * summer and 7:00 AM in winter. Showing today's answer, with today's CST/CDT
 * label, is the honest reading -- there is no single correct local time to show.
 */

const CENTRAL = 'America/Chicago'

/** Formats without a zone label, so a list of times can carry one at the end. */
const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL,
  hour: 'numeric',
  minute: '2-digit',
})

const TIME_WITH_ZONE = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL,
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
})

/** Today's date at `hour:minute` UTC. Converting UTC -> local is always
 *  well-defined, including on the spring-forward day, so this cannot land on a
 *  local time that does not exist. */
function instant(hour: number, minute: number): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute),
  )
}

/** "CST" or "CDT", whichever is in force today. */
function zoneLabel(at: Date): string {
  const part = TIME_WITH_ZONE.formatToParts(at).find((p) => p.type === 'timeZoneName')
  return part?.value ?? 'Central'
}

/** `hourCycle: 'h23'` rather than `hour12: false`, which renders midnight as
 *  "24:00" in some engines and would sort to the end of the day. */
const TIME_24 = new Intl.DateTimeFormat('en-GB', {
  timeZone: CENTRAL,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Minutes past local midnight, for ordering times the UTC hour list scrambles:
 *  `0 2,3,12 * * *` is 8 PM, 9 PM, 6 AM in Central, which reads backwards. */
function localMinutes(at: Date): number {
  const [hour, minute] = TIME_24.format(at).split(':').map((n) => Number.parseInt(n, 10))
  return hour * 60 + minute
}

/**
 * A RunTimes cron rendered in Central, e.g. `0 9,18 * * *` -> "4:00 AM, 1:00 PM CDT".
 *
 * Only plain daily schedules are converted, which is every schedule in the data
 * today. Anything else -- weekly, monthly, an interval -- is handed back as the
 * raw expression tagged UTC, because converting the *time* of a weekly job can
 * move it onto a different weekday than the cron names, and a schedule labelled
 * with the wrong day would be worse than one nobody has translated.
 *
 * Returns null only for an empty value, so callers can drop the whole "runs at"
 * clause rather than print a placeholder. Anything non-empty comes back verbatim
 * if it cannot be read as a cron -- showing what is actually stored beats
 * inventing a time for it.
 */
export function centralSchedule(runTimes: string | null | undefined): string | null {
  const value = (runTimes ?? '').trim()
  if (!value) return null

  const fields = value.split(/\s+/)
  if (fields.length !== 5) return value

  const [minuteText, hourText, dayText, monthText, weekdayText] = fields
  const minute = Number.parseInt(minuteText, 10)
  const hours = hourText
    .split(',')
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)

  const daily = dayText === '*' && monthText === '*' && weekdayText === '*'
  if (!daily || !hours.length || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return `${value} UTC`
  }

  const instants = hours
    .map((hour) => instant(hour, minute))
    .sort((a, b) => localMinutes(a) - localMinutes(b))

  return `${instants.map((at) => TIME.format(at)).join(', ')} ${zoneLabel(instants[0])}`
}
