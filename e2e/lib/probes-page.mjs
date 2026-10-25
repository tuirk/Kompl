// Interaction probes on a wiki article's page card: the numbers it states
// against what it lists (Sources (N), citation markers, the Connections
// count), a relation's "Why" evidence (labelled as Kompl's summary, not as a
// quote, with working source links), "Show all N", "See in graph" and Back,
// and a source row opening the same source.
import { headerCounts, waitForSettledGraph } from "./graph-util.mjs";
import { gotoWithRetry } from "./net.mjs";
import { runProbe, skip } from "./probe.mjs";
import { safeClick } from "./safety.mjs";

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** What the card says and lists, read in the page. */
const readCard = (page) => page.evaluate(() => {
  const t = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const h1 = t(document.querySelector("main h1, article h1, h1"));
  const srcHead = [...document.querySelectorAll("h2")].find((h) => /^Sources \(\d+\)$/.test(t(h)));
  const srcList = srcHead?.nextElementSibling;
  const markers = [...document.querySelectorAll('a[href^="#src-"]')].map((a) => Number(a.getAttribute("href").slice(5))).filter(Number.isFinite);
  const sec = [...document.querySelectorAll("section")].find((s) => /^Connections\b/.test(t(s.querySelector("h2"))));
  let conn = null;
  if (sec) {
    const countText = t(sec.querySelector("h2 span"));
    const ends = new Set();
    const groups = [];
    for (const h3 of sec.querySelectorAll("h3")) {
      const box = h3.parentElement;
      const label = t(h3.firstChild);
      const rows = [...box.querySelectorAll('a[href^="/wiki/"]:not([href*="graph"]), div[title$=": no page yet"]')];
      const keys = rows.map((r) => r.getAttribute("href") ?? `name:${r.getAttribute("title").replace(/: no page yet$/, "").toLowerCase()}`);
      groups.push({ label, rows: new Set(keys).size, stated: Number(t(h3.querySelector("span"))) || null });
      if (label !== "Also linked") keys.forEach((k) => ends.add(k));
    }
    conn = { count: countText ? Number(countText) : null, uniqueEnds: ends.size, groups };
  }
  return {
    h1, sourcesStated: srcHead ? Number(t(srcHead).match(/\d+/)[0]) : null,
    sourcesListed: srcList ? srcList.querySelectorAll(":scope > li").length : null,
    firstSource: srcList?.querySelector("li a[href^='/source/']") ? { href: srcList.querySelector("li a[href^='/source/']").getAttribute("href"), text: t(srcList.querySelector("li a[href^='/source/']")) } : null,
    maxMarker: markers.length ? Math.max(...markers) : 0, conn,
  };
});

async function numbers(p, page) {
  const c = await readCard(page);
  if (c.sourcesStated !== null) {
    await p.expect(c.sourcesStated === c.sourcesListed, "Sources (N) matches the sources listed", { severity: "medium", detail: `heading says ${c.sourcesStated}, list has ${c.sourcesListed}` });
    await p.expect(c.maxMarker <= c.sourcesListed, "citation numbers stay within the source list", { severity: "medium", detail: `highest marker [${c.maxMarker}], ${c.sourcesListed} sources` });
  }
  if (c.conn) {
    const relations = c.conn.groups.filter((g) => g.label !== "Also linked");
    if (relations.length) await p.expect(c.conn.count === c.conn.uniqueEnds, "the Connections count matches the pages it lists", { severity: "medium", detail: `header ${c.conn.count}, pages listed under relations ${c.conn.uniqueEnds} (${relations.map((g) => `${g.label}: ${g.rows}`).join(", ")})` });
    const also = c.conn.groups.find((g) => g.label === "Also linked");
    if (also && also.stated !== null) await p.expect(also.stated === also.rows, '"Also linked" count matches its rows', { severity: "medium", detail: `says ${also.stated}, lists ${also.rows}` });
  }
  return c;
}

async function why(p, page) {
  const toggle = page.locator('summary[aria-label^="Why"]').first();
  if (!(await toggle.count())) return p.note("no Why toggle", "this page has no relation with evidence");
  await toggle.scrollIntoViewIfNeeded();
  await safeClick(toggle);
  await p.quiet();
  const ev = await toggle.evaluate((s) => {
    const d = s.closest("details");
    const list = d?.querySelector("ul");
    const items = [...(list?.querySelectorAll("li") ?? [])].map((li) => {
      const sentence = li.querySelector("span")?.textContent?.trim() ?? "";
      return { sentence, note: li.textContent.replace(sentence, "").trim(), links: [...li.querySelectorAll('a[href^="/source/"]')].map((a) => a.getAttribute("href")),
        quoted: /^["“‘«]/.test(sentence) || !!li.querySelector("q, blockquote") };
    });
    return { open: !!d?.open && !!list?.checkVisibility(), items };
  });
  await p.expect(ev.open, "the Why toggle opens the evidence", { severity: "medium" });
  if (!ev.items.length) return;
  const withSentence = ev.items.filter((i) => i.sentence && i.links.length);
  await p.expect(ev.items.some((i) => i.links.length), "the evidence names its source", { severity: "medium", detail: JSON.stringify(ev.items.slice(0, 3)) });
  for (const i of withSentence.slice(0, 3)) {
    await p.expect(/Kompl.?s summary/i.test(i.note), "a relation's sentence is labelled as Kompl's summary", { severity: "medium", detail: `"${i.sentence}" — ${i.note}` });
    await p.expect(!i.quoted, "a summary is not dressed as a quote", { severity: "medium", detail: i.sentence });
  }
  for (const href of [...new Set(ev.items.flatMap((i) => i.links))].slice(0, 4)) {
    const res = await page.context().request.get(`${p.base}${href}`).catch(() => null);
    await p.expect(res?.ok(), `evidence source link opens (${href})`, { severity: "high", detail: `HTTP ${res?.status() ?? "no response"}` });
  }
}

async function showAll(p, page) {
  const sum = page.locator("details.wiki-rp-more > summary").first();
  if (!(await sum.count())) return p.note("no Show all", "every group fits");
  const total = Number(((await sum.textContent()) ?? "").match(/Show all (\d+)/)?.[1]);
  await sum.scrollIntoViewIfNeeded();
  await safeClick(sum);
  await p.quiet();
  const rows = await sum.evaluate((s) => {
    const box = s.closest("details").parentElement;
    return [...box.querySelectorAll('a[href^="/wiki/"], div[title$=": no page yet"]')].filter((r) => r.checkVisibility()).length;
  });
  await p.expect(rows === total, '"Show all N" then shows N rows', { severity: "medium", detail: `said ${total}, shows ${rows}` });
}

async function seeInGraph(p, page, pageId, title) {
  const link = page.getByRole("link", { name: /See in graph/i }).first();
  if (!(await link.count())) return p.note("no See in graph", "");
  await safeClick(link);
  await page.waitForURL(/\/wiki\/graph/, { timeout: 15000 }).catch(() => {});
  await waitForSettledGraph(page, p.session.tracker);
  const hc = await headerCounts(page);
  await p.expect(new URL(page.url()).searchParams.get("focus") === pageId, "See in graph opens the map focused on this page", { detail: page.url() });
  await p.expect(hc.focusTitle && norm(hc.focusTitle) === norm(title), "the map names the same page", { severity: "medium", detail: `article "${title}", map "${hc.focusTitle}"` });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await p.quiet();
  await p.expect(new URL(page.url()).pathname === `/wiki/${pageId}`, "Back returns to the article", { detail: page.url() });
}

async function sourceRow(p, page, card) {
  if (!card.firstSource) return;
  const link = page.locator(String.raw`h2:text-matches("^Sources \\(\\d+\\)$") + ol a[href^="/source/"]`).first();
  await link.scrollIntoViewIfNeeded();
  await safeClick(link);
  await page.waitForURL(/\/source\//, { timeout: 15000 }).catch(() => {});
  await p.quiet();
  const h1 = await page.locator("h1").first().textContent().catch(() => "");
  await p.expect(new URL(page.url()).pathname === card.firstSource.href, "a source row opens that source", { detail: page.url() });
  await p.expect(norm(h1).includes(norm(card.firstSource.text)) || norm(card.firstSource.text).includes(norm(h1)), "the source page has the title the row showed",
    { severity: "medium", detail: `row "${card.firstSource.text}", source page "${h1}"` });
}

export async function runPageProbes(store, session, base, pages) {
  for (const { page_id: id, title } of pages) {
    const route = `/wiki/${encodeURIComponent(id)}`;
    await runProbe(store, session, base, `page-card/${id.slice(0, 40)}`, route, async (p) => {
      const page = p.page;
      const res = await gotoWithRetry(page, `${base}${route}`, { waitUntil: "domcontentloaded" });
      if (!res?.ok()) skip(`HTTP ${res?.status()}`);
      await p.quiet();
      const card = await numbers(p, page);
      if (card.h1) await p.expect(norm(card.h1) === norm(title), "the article title matches the wiki index", { severity: "low", detail: `h1 "${card.h1}", index "${title}"` });
      await why(p, page);
      await showAll(p, page);
      await seeInGraph(p, page, id, card.h1 || title);
      await sourceRow(p, page, card);
    });
  }
}
