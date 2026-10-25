'use client';

/**
 * Dates and times in the viewer's time zone, in the one format the app uses
 * (lib/date-format.ts). The server doesn't know the viewer's zone, so the
 * first render shows the UTC reading and the browser swaps in local time
 * after hydration.
 */

import { useEffect, useState } from 'react';
import { formatDate, formatDateTime, formatTime } from '../lib/date-format';

function useLocalText(format: (utc: boolean) => string, iso: string): string {
  const [text, setText] = useState(() => format(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setText(format(false)), [iso]);
  return text;
}

/** "10 Oct 2026, 13:51" */
export function LocalDatetime({ iso }: { iso: string }) {
  return <>{useLocalText((utc) => formatDateTime(iso, { utc }), iso)}</>;
}

/** "13:51" */
export function LocalTime({ iso }: { iso: string }) {
  return <>{useLocalText((utc) => formatTime(iso, { utc }), iso)}</>;
}

/** "10 Oct 2026" */
export function LocalDate({ iso }: { iso: string }) {
  return <>{useLocalText((utc) => formatDate(iso, { utc }), iso)}</>;
}
