const DATE_TIME = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
});

// A protocol time in the viewer's zone, with the zone named so a screenshot
// shared with someone elsewhere still reads correctly.
export function formatDateTime(value: string | number): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : DATE_TIME.format(date);
}

const DATE = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});

const TIME = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
});

// The same moment split for a narrow column: the date, then the time.
export function formatDateParts(value: string | number): { date: string; time: string } {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? { date: String(value), time: '' }
        : { date: DATE.format(date), time: TIME.format(date) };
}

export function relativeTime(value: string, now = Date.now()): string {
    const difference = Date.parse(value) - now;
    const absolute = Math.abs(difference);
    const units: Array<[number, string]> = [
        [86_400_000, 'day'],
        [3_600_000, 'hour'],
        [60_000, 'minute'],
    ];
    for (const [milliseconds, label] of units) {
        if (absolute >= milliseconds) {
            const count = Math.max(1, Math.round(absolute / milliseconds));
            return difference >= 0
                ? `in ${count} ${label}${count === 1 ? '' : 's'}`
                : `${count} ${label}${count === 1 ? '' : 's'} ago`;
        }
    }
    return difference >= 0 ? 'in less than a minute' : 'just now';
}
