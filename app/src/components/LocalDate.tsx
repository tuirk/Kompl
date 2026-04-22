'use client';

import { useEffect, useState } from 'react';

function parse(iso: string): Date | null {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function fmtDatetime(iso: string, useUTC: boolean): string {
  const d = parse(iso);
  if (!d) return iso;
  const dd   = useUTC ? d.getUTCDate()     : d.getDate();
  const mo   = useUTC ? d.getUTCMonth()    : d.getMonth();
  const yy   = useUTC ? d.getUTCFullYear() : d.getFullYear();
  const hh   = useUTC ? d.getUTCHours()    : d.getHours();
  const mi   = useUTC ? d.getUTCMinutes()  : d.getMinutes();
  return `${pad(dd)}.${pad(mo + 1)}.${yy} ${pad(hh)}.${pad(mi)}`;
}

function fmtTime(iso: string, useUTC: boolean): string {
  const d = parse(iso);
  if (!d) return iso;
  const hh = useUTC ? d.getUTCHours()   : d.getHours();
  const mi = useUTC ? d.getUTCMinutes() : d.getMinutes();
  const ss = useUTC ? d.getUTCSeconds() : d.getSeconds();
  return `${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

function fmtDayMonth(iso: string, useUTC: boolean): string {
  const d = parse(iso);
  if (!d) return iso;
  const mo = useUTC ? d.getUTCMonth() : d.getMonth();
  const dd = useUTC ? d.getUTCDate()  : d.getDate();
  return `${MONTHS[mo]} ${dd}`;
}

function fmtDate(iso: string, useUTC: boolean): string {
  const d = parse(iso);
  if (!d) return iso;
  const yy = useUTC ? d.getUTCFullYear() : d.getFullYear();
  const mo = useUTC ? d.getUTCMonth()    : d.getMonth();
  const dd = useUTC ? d.getUTCDate()     : d.getDate();
  return `${yy}-${pad(mo + 1)}-${pad(dd)}`;
}

export function LocalDatetime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => fmtDatetime(iso, true));
  useEffect(() => setText(fmtDatetime(iso, false)), [iso]);
  return <>{text}</>;
}

export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => fmtTime(iso, true));
  useEffect(() => setText(fmtTime(iso, false)), [iso]);
  return <>{text}</>;
}

export function LocalDayMonth({ iso }: { iso: string }) {
  const [text, setText] = useState(() => fmtDayMonth(iso, true));
  useEffect(() => setText(fmtDayMonth(iso, false)), [iso]);
  return <>{text}</>;
}

export function LocalDate({ iso }: { iso: string }) {
  const [text, setText] = useState(() => fmtDate(iso, true));
  useEffect(() => setText(fmtDate(iso, false)), [iso]);
  return <>{text}</>;
}
