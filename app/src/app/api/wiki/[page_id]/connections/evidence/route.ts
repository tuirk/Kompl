import { NextResponse } from 'next/server';
import { getPage } from '@/lib/db';
import { getConnectionEvidence, type ConnectionEnd } from '@/lib/relations';

export const dynamic = 'force-dynamic';

/** GET /api/wiki/[page_id]/connections/evidence?type=uses&direction=out&page=<page_id>
 *  (or &name=<name> for a name with no page) — one connection of the page
 *  with every source behind it, as `{ items, count }` of the connections
 *  route's items (lib/relations.ts getConnectionEvidence). That route keeps
 *  three sources per connection; the graph panels ask here when the viewer
 *  opens "+N more sources". 400 without a type, a direction (out | in) and
 *  exactly one of page / name; 404 for an unknown page. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ page_id: string }> }
) {
  const { page_id } = await params;
  const query = new URL(request.url).searchParams;
  const type = query.get('type');
  const direction = query.get('direction');
  const page = query.get('page');
  const name = query.get('name');
  if (!type || (direction !== 'out' && direction !== 'in') || (page === null) === (name === null) || (page ?? name) === '') {
    return NextResponse.json(
      { error: 'Give type, direction (out or in) and exactly one of page or name' },
      { status: 400 }
    );
  }
  if (!getPage(page_id)) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  const other: ConnectionEnd = page !== null ? { page_id: page } : { name: name as string };
  const items = getConnectionEvidence(page_id, other, type, direction);
  return NextResponse.json({ items, count: items.length });
}
