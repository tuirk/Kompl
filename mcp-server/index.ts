import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KOMPL_URL = process.env.KOMPL_URL ?? "http://localhost:3000";

const server = new McpServer({
  name: "kompl-wiki",
  version: "1.0.0",
});

// ── search_wiki ──────────────────────────────────────────────────────────────
// GET /api/pages/search?q=&limit= → { items: PageRow[], count }

server.tool(
  "search_wiki",
  "Search the Kompl knowledge wiki for pages matching a query. Returns page titles, types, and summaries.",
  {
    query: z.string().describe("Search query — topic, entity name, or keyword"),
    limit: z.number().int().min(1).max(100).default(10).describe("Max results (default 10)"),
  },
  async ({ query, limit }) => {
    let res: Response;
    try {
      res = await fetch(
        `${KOMPL_URL}/api/pages/search?q=${encodeURIComponent(query)}&limit=${limit}`
      );
    } catch {
      return { content: [{ type: "text", text: "Kompl not reachable — is it running?" }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `Search failed: ${res.status}` }] };
    }
    const data = (await res.json()) as { items: PageMeta[]; count: number };
    if (!data.items.length) {
      return { content: [{ type: "text", text: "No results found." }] };
    }
    const formatted = data.items
      .map(
        (p) =>
          `**${p.title}** (${p.page_type})${p.category ? ` [${p.category}]` : ""} — ${p.summary ?? "No summary"}\n  ID: \`${p.page_id}\``
      )
      .join("\n\n");
    return { content: [{ type: "text", text: `${data.count} result(s):\n\n${formatted}` }] };
  }
);

// ── read_page ────────────────────────────────────────────────────────────────
// GET /api/wiki/{page_id}/data → full page JSON with markdown content

server.tool(
  "read_page",
  "Read the full content of a Kompl wiki page by its page_id. Use search_wiki first to find page_ids.",
  {
    page_id: z.string().describe("The page_id from search results"),
  },
  async ({ page_id }) => {
    let res: Response;
    try {
      res = await fetch(`${KOMPL_URL}/api/wiki/${encodeURIComponent(page_id)}/data`);
    } catch {
      return { content: [{ type: "text", text: "Kompl not reachable — is it running?" }] };
    }
    if (res.status === 404) {
      return { content: [{ type: "text", text: `Page not found: ${page_id}` }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `Failed to load page: ${res.status}` }] };
    }
    const data = (await res.json()) as PageData;
    const sourceList =
      data.sources.length
        ? data.sources.map((s) => `  - ${s.title} (${s.contribution_type})`).join("\n")
        : "  (none)";
    const text = [
      `# ${data.title}`,
      `Type: ${data.page_type}${data.category ? ` | Category: ${data.category}` : ""} | Sources: ${data.source_count}`,
      `Last updated: ${data.last_updated}`,
      ``,
      data.content || "(no content)",
      ``,
      `---`,
      `**Provenance sources:**`,
      sourceList,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── list_pages ───────────────────────────────────────────────────────────────
// GET /api/wiki/index → { pages: PageMeta[], categories, total_pages }
// Filter client-side — avoids changes to existing Next.js routes.

server.tool(
  "list_pages",
  "List all pages in the Kompl wiki. Optionally filter by category or page type.",
  {
    category: z.string().optional().describe("Filter by category name (optional)"),
    page_type: z
      .string()
      .optional()
      .describe(
        "Filter by type: entity, concept, comparison, overview, source-summary (optional)"
      ),
  },
  async ({ category, page_type }) => {
    let res: Response;
    try {
      res = await fetch(`${KOMPL_URL}/api/wiki/index`);
    } catch {
      return { content: [{ type: "text", text: "Kompl not reachable — is it running?" }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `Failed: ${res.status}` }] };
    }
    const data = (await res.json()) as { pages: PageMeta[]; total_pages: number };
    let pages = data.pages;
    if (category) {
      pages = pages.filter(
        (p) => p.category?.toLowerCase() === category.toLowerCase()
      );
    }
    if (page_type) {
      pages = pages.filter((p) => p.page_type === page_type);
    }
    if (!pages.length) {
      return { content: [{ type: "text", text: "No pages match the given filters." }] };
    }
    const formatted = pages
      .map(
        (p) =>
          `• **${p.title}** (${p.page_type}) [${p.category ?? "Uncategorized"}] — ${p.source_count} source(s)\n  ID: \`${p.page_id}\``
      )
      .join("\n\n");
    return {
      content: [{ type: "text", text: `${pages.length} page(s):\n\n${formatted}` }],
    };
  }
);

// ── wiki_stats ───────────────────────────────────────────────────────────────
// GET /api/health → page_count, schema_version, table_count, status
// GET /api/wiki/index → category count

server.tool(
  "wiki_stats",
  "Get statistics about the Kompl knowledge wiki — page count, categories, schema version.",
  {},
  async () => {
    let healthRes: Response, indexRes: Response;
    try {
      [healthRes, indexRes] = await Promise.all([
        fetch(`${KOMPL_URL}/api/health`),
        fetch(`${KOMPL_URL}/api/wiki/index`),
      ]);
    } catch {
      return { content: [{ type: "text", text: "Kompl not reachable — is it running?" }] };
    }
    if (!healthRes.ok) {
      return { content: [{ type: "text", text: `Health check failed: ${healthRes.status}` }] };
    }
    let health: HealthData;
    let categoryCount: number | string = "unknown";
    try {
      health = (await healthRes.json()) as HealthData;
      if (indexRes.ok) {
        const indexData = (await indexRes.json()) as { categories: Record<string, unknown> };
        categoryCount = Object.keys(indexData.categories).length;
      }
    } catch {
      return { content: [{ type: "text", text: "Failed to parse Kompl response." }] };
    }
    const text = [
      `**Kompl Wiki Stats**`,
      `• Status: ${health.status}`,
      `• Pages: ${health.page_count}`,
      `• Categories: ${categoryCount}`,
      `• Schema version: ${health.schema_version}`,
      `• Tables: ${health.table_count}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Types ────────────────────────────────────────────────────────────────────

interface PageMeta {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  source_count: number;
  last_updated: string;
}

interface PageData extends PageMeta {
  content: string;
  sources: Array<{ source_id: string; title: string; contribution_type: string }>;
}

interface HealthData {
  status: string;
  page_count: number;
  schema_version: number;
  table_count: number;
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
