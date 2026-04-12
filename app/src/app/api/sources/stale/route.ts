import { NextResponse } from 'next/server';
import { getStaleSources } from '../../../../lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '90', 10);
  if (isNaN(days) || days <= 0) {
    return NextResponse.json({ sources: [], count: 0 });
  }
  const sources = getStaleSources(days);
  return NextResponse.json({ sources, count: sources.length });
}
