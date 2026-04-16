/**
 * POST /api/chat
 *
 * Handles a single chat turn: retrieves relevant wiki pages, synthesises a
 * grounded answer, persists both messages, and optionally creates a
 * compounding draft when the answer spans 3+ pages.
 *
 * Request:  { session_id: string, question: string }
 * Response: { answer: string, citations: Citation[], pages_used: string[] }
 *
 * Architecture rule #3: LLM synthesis goes through POST /chat/synthesize on
 * the nlp-service — never directly from Next.js.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getChatHistory, getPageCategories, getWikiStats, insertChatDraft, insertChatMessage } from '@/lib/db';
import { retrievePages } from '@/lib/retrieval';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

const NO_CONTENT_ANSWER =
  "Your knowledge base doesn't have anything on this topic yet. " +
  'Try ingesting some sources first, then ask again.';

/**
 * Detect meta queries about the knowledge base itself and return an instant
 * DB-backed answer, bypassing LLM retrieval entirely.
 * Returns null if the question is not a meta query.
 */
function detectMetaQuery(question: string): string | null {
  const q = question.toLowerCase();

  if (/how many (sources|articles|documents|files|things)/.test(q)) {
    const stats = getWikiStats();
    return `Your knowledge base has ${stats.source_count} active sources compiled into ${stats.page_count} wiki pages (${stats.entity_count} entities, ${stats.concept_count} concepts).`;
  }

  if (/how many (pages|wiki pages)/.test(q)) {
    const stats = getWikiStats();
    return `Your wiki has ${stats.page_count} pages: ${stats.entity_count} entity pages, ${stats.concept_count} concept pages, and ${stats.page_count - stats.entity_count - stats.concept_count} others.`;
  }

  if (/what was the (last|latest|most recent).*(ingest|add|source)|last.*ingest/.test(q)) {
    const stats = getWikiStats();
    return stats.last_ingested
      ? `The most recent source was ingested on ${stats.last_ingested}.`
      : 'No sources have been ingested yet.';
  }

  if (/when was.*last (compil|updat)|last.*compil/.test(q)) {
    const stats = getWikiStats();
    return stats.last_compiled
      ? `The most recently compiled wiki page was updated on ${stats.last_compiled}.`
      : 'No pages have been compiled yet.';
  }

  if (
    /what (topics|subjects|areas|categories|things).*(cover|know|contain|have|in|about)|what.*in my (wiki|knowledge)|overview of my (wiki|knowledge)|what do you know|(tell me what.*know)/.test(q)
  ) {
    const categories = getPageCategories();
    if (categories.length === 0) {
      return 'Your wiki has no compiled pages yet. Ingest some sources first.';
    }
    // Group by category
    const catMap = new Map<string, string[]>();
    for (const row of categories) {
      const existing = catMap.get(row.category) ?? [];
      existing.push(`${row.count} ${row.page_type}`);
      catMap.set(row.category, existing);
    }
    const catLines = [...catMap.entries()]
      .map(([cat, types]) => `- **${cat}**: ${types.join(', ')}`)
      .join('\n');
    const stats = getWikiStats();
    return `Your wiki has ${stats.page_count} pages across these categories:\n\n${catLines}`;
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      session_id?: string;
      question?: string;
    };

    const sessionId = body.session_id?.trim();
    const question = body.question?.trim();

    if (!sessionId || !question) {
      return NextResponse.json(
        { error: 'session_id and question are required' },
        { status: 400 },
      );
    }

    // 1. Persist user message
    insertChatMessage({ session_id: sessionId, role: 'user', content: question });

    // 1b. Meta query bypass — instant DB answer, no LLM needed
    const metaAnswer = detectMetaQuery(question);
    if (metaAnswer) {
      insertChatMessage({ session_id: sessionId, role: 'assistant', content: metaAnswer, citations: [], pages_used: [] });
      return NextResponse.json({ answer: metaAnswer, citations: [], pages_used: [] });
    }

    // 2. Retrieve relevant pages
    const pages = await retrievePages(question, 10);

    if (pages.length === 0) {
      insertChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: NO_CONTENT_ANSWER,
        citations: [],
        pages_used: [],
      });
      return NextResponse.json({
        answer: NO_CONTENT_ANSWER,
        citations: [],
        pages_used: [],
      });
    }

    // 3. Build conversation history (last 10 messages = 5 exchanges)
    const historyRows = getChatHistory(sessionId, 10);
    // Exclude the user message we just inserted (last row)
    const history = historyRows
      .slice(0, -1)
      .map((r) => ({ role: r.role, content: r.content }));

    // 4. Prepare pages for synthesis:
    //    Top 5 get full content, pages 6-10 get summary only
    const synthPages = pages.map((p, i) => ({
      page_id: p.page_id,
      title: p.title,
      page_type: p.page_type,
      markdown: i < 5 ? p.content.slice(0, 2000) : `[Summary only] ${p.content.slice(0, 300)}`,
    }));

    // 5. Synthesise via nlp-service
    const synthRes = await fetch(`${NLP_SERVICE_URL}/chat/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, pages: synthPages, history }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!synthRes.ok) {
      const errText = await synthRes.text().catch(() => 'unknown');
      return NextResponse.json(
        { error: `synthesis_failed: ${errText}` },
        { status: 502 },
      );
    }

    const synthData = (await synthRes.json()) as {
      answer: string;
      citations: Array<{ page_id: string; page_title: string }>;
    };

    let { answer } = synthData;
    const citations = synthData.citations ?? [];

    // 6. Safety net: no citations but pages available → prepend disclaimer
    if (citations.length === 0 && pages.length > 0) {
      answer =
        '> Note: This answer was generated from your wiki but specific citations could not be determined.\n\n' +
        answer;
    }

    const pagesUsed = pages.map((p) => p.page_id);

    // 7. Persist assistant message
    insertChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: answer,
      citations,
      pages_used: pagesUsed,
    });

    // 8. Compounding: if answer used 3+ pages, create a pending draft
    if (pages.length >= 3) {
      const draftTitle = `FAQ: ${question.slice(0, 100)}`;
      const citedList = citations
        .map((c) => `- [${c.page_title}](/wiki/${c.page_id})`)
        .join('\n');
      const draftContent = [
        `---`,
        `title: "${draftTitle}"`,
        `page_type: query-generated`,
        `draft_status: pending_approval`,
        `pages_referenced: [${pagesUsed.map((id) => `"${id}"`).join(', ')}]`,
        `---`,
        ``,
        `## Question`,
        ``,
        question,
        ``,
        `## Answer`,
        ``,
        answer,
        ``,
        `## Sources Referenced`,
        ``,
        citedList || pagesUsed.map((id) => `- ${id}`).join('\n'),
      ].join('\n');

      // Fire-and-forget — non-fatal if it fails
      try {
        insertChatDraft({
          plan_id: randomUUID(),
          session_id: sessionId,
          title: draftTitle,
          draft_content: draftContent,
          pages_used: pagesUsed,
        });
      } catch {
        // Non-fatal — compounding draft is best-effort
      }
    }

    return NextResponse.json({ answer, citations, pages_used: pagesUsed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
