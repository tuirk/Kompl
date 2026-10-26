// One pass over the rendered page, run inside the browser (page.evaluate):
// horizontal overflow and its causes, content cut off at a screen edge, text
// cut off without an ellipsis, controls covered by other elements, broken
// images and in-page anchors, broken text ("undefined", "NaN", "[object
// Object]"), error and not-found screens, the links on the page and the counts
// it states ("12 pages"). Self-contained: no imports reach the page.
// Rects from getBoundingClientRect are viewport px, the app's html zoom
// included, so they compare directly with innerWidth.

export function domChecks({ maxElements = 6000 } = {}) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const clean = (s, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const sel = (el) => {
    if (!(el instanceof Element)) return null;
    const parts = [];
    for (let e = el, depth = 0; e && e.nodeType === 1 && depth < 7; e = e.parentElement, depth++) {
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id) && document.querySelectorAll(`#${e.id}`).length === 1) { parts.unshift(`#${e.id}`); break; }
      let p = e.tagName.toLowerCase();
      if (p === "html" || p === "body") { parts.unshift(p); break; }
      const cls = [...e.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) p += "." + cls.join(".");
      const parent = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(p);
      const s = parts.join(" > ");
      try { if (document.querySelectorAll(s).length === 1 && depth >= 1) return s; } catch { /* keep walking */ }
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  const label = (el) => clean(el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.textContent, 60);
  const root = document.scrollingElement || document.documentElement;

  // Does the page scroll sideways?
  const sx = window.scrollX, sy = window.scrollY;
  window.scrollTo(1e6, sy);
  const hScroll = Math.round(window.scrollX);
  window.scrollTo(sx, sy);

  // Each element's clip [left, top, right, bottom] from its overflow ancestors (html and body
  // aside: they are the page). A fixed element escapes its ancestors' clips.
  const clipMemo = new Map();
  const NONE = [-Infinity, -Infinity, Infinity, Infinity];
  const clipOf = (el) => {
    if (clipMemo.has(el)) return clipMemo.get(el);
    const parent = el.parentElement;
    let c = NONE;
    if (parent && parent !== document.body && parent !== document.documentElement && getComputedStyle(el).position !== "fixed") {
      c = clipOf(parent).slice();
      const cs = getComputedStyle(parent);
      const paint = cs.contain.includes("paint");
      const r = parent.getBoundingClientRect();
      if (cs.overflowX !== "visible" || paint) { c[0] = Math.max(c[0], r.left); c[2] = Math.min(c[2], r.right); }
      if (cs.overflowY !== "visible" || paint) { c[1] = Math.max(c[1], r.top); c[3] = Math.min(c[3], r.bottom); }
    }
    clipMemo.set(el, c);
    return c;
  };
  const shownX = (el) => {
    const r = el.getBoundingClientRect(), c = clipOf(el);
    return [Math.max(r.left, c[0]), Math.min(r.right, c[2])];
  };
  /** The middle of the part of an element its scroll containers let the user see, or null. */
  const shownMiddle = (el) => {
    const r = el.getBoundingClientRect(), c = clipOf(el);
    const l = Math.max(r.left, c[0], 0), t = Math.max(r.top, c[1], 0), rr = Math.min(r.right, c[2], vw), b = Math.min(r.bottom, c[3], vh);
    return rr - l >= 4 && b - t >= 4 ? { x: (l + rr) / 2, y: (t + b) / 2, whole: l === Math.max(r.left, 0) && rr === Math.min(r.right, vw) && t === Math.max(r.top, 0) && b === Math.min(r.bottom, vh) } : null;
  };

  const all = [...document.body.querySelectorAll("*")].slice(0, maxElements);
  const overflow = [], clipped = [], cutText = [], ellipsisNoTitle = [], emptyHeadings = [];
  for (const el of all) {
    if (el.closest("svg *")) continue;
    if (!visible(el)) continue;
    const [left, right] = shownX(el);
    if (right <= left) continue;
    const parent = el.parentElement;
    const pRight = parent && parent !== document.body ? shownX(parent)[1] : vw;
    if (right > vw + 1 && pRight <= vw + 1) {
      const item = { sel: sel(el), text: clean(el.textContent, 60), left: Math.round(left), right: Math.round(right) };
      if (hScroll > 0) overflow.push(item);
      else if (left < vw - 1) clipped.push({ ...item, edge: "right" });
    }
    if (left < -1 && right > 1 && !(parent && shownX(parent)[0] < -1)) clipped.push({ sel: sel(el), text: clean(el.textContent, 60), left: Math.round(left), right: Math.round(right), edge: "left" });

    const text = ownText(el);
    if (text) {
      const cs = getComputedStyle(el);
      const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (clipsX && el.scrollWidth > el.clientWidth + 1) {
        if (cs.textOverflow !== "ellipsis") cutText.push({ sel: sel(el), text: clean(text), how: "sideways, no ellipsis" });
        else if (!el.closest("[title]") && !el.closest("[aria-label]")) ellipsisNoTitle.push({ sel: sel(el), text: clean(el.textContent) });
      }
      if (clipsY && el.clientHeight > 4 && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === "none") {
        cutText.push({ sel: sel(el), text: clean(text), how: "bottom cut off" });
      }
    }
    if (/^H[1-3]$/.test(el.tagName) && !clean(el.textContent) && !el.querySelector("img[alt],svg[aria-label]")) emptyHeadings.push({ sel: sel(el) });
  }

  // A fixed or sticky bar along the top or bottom edge (an action bar, a nav bar) covers what
  // scrolls under it; that is only a problem when the page cannot scroll the control out from under it.
  const underScrollableBar = (hit) => {
    for (let e = hit; e && e !== document.body; e = e.parentElement) {
      const pos = getComputedStyle(e).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      const b = e.getBoundingClientRect();
      if (b.width < vw * 0.6 || b.height > vh * 0.25) return false;
      const atBottom = b.bottom >= vh - 2, atTop = b.top <= 2;
      if (atBottom) return window.scrollY + vh < root.scrollHeight - 2;
      if (atTop) return window.scrollY > 2;
      return false;
    }
    return false;
  };
  // Controls whose middle is covered by another element.
  const covered = [];
  for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=separator][tabindex]")) {
    if (!visible(el)) continue;
    // Only controls shown whole (by the screen and by their scroll containers): one scrolled
    // out of its list is hidden, not covered.
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) continue;
    const m = shownMiddle(el);
    if (!m || !m.whole) continue;
    const hit = document.elementFromPoint(m.x, m.y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (hit.closest("label")?.control === el || (el.labels && [...el.labels].some((l) => l.contains(hit)))) continue;
    if (underScrollableBar(hit)) continue;
    covered.push({ sel: sel(el), name: label(el), by: sel(hit), byText: clean(hit.textContent, 40) });
  }

  const brokenImages = [...document.images]
    .filter((img) => img.getAttribute("src") && img.complete && img.naturalWidth === 0 && visible(img))
    .map((img) => ({ sel: sel(img), src: img.currentSrc || img.src }));

  const brokenAnchors = [];
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const id = decodeURIComponent(a.getAttribute("href").slice(1));
    if (!id || id === "top") continue;
    if (!document.getElementById(id) && !document.getElementsByName(id).length) brokenAnchors.push({ sel: sel(a), href: a.getAttribute("href"), text: clean(a.textContent, 40) });
  }

  // Broken text: values that leaked through as their JavaScript spelling.
  const badText = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && badText.length < 20; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t || !n.parentElement || !visible(n.parentElement)) continue;
    if (n.parentElement.closest("script,style,noscript")) continue;
    const inProse = n.parentElement.closest("article,pre,code,.markdown,.prose");
    const always = /\[object Object\]|Invalid Date|\bNaN\b/;
    const ui = /^(undefined|null)$|\bundefined\b/;
    if (always.test(t) || (!inProse && ui.test(t))) badText.push({ sel: sel(n.parentElement), text: clean(t) });
  }

  const bodyText = document.body.innerText || "";
  const notFound = /This page could not be found|^404$/m.test(bodyText);
  const appError = (bodyText.match(/Application error: a client-side exception has occurred[^\n]*|Internal Server Error|Unhandled Runtime Error/) || [null])[0];

  // "12 pages"-style counts: all of them, and those in headings, headers and live regions (a screen's headline numbers).
  const countsIn = (text) => {
    const out = [], seen = new Set();
    for (const m of text.matchAll(/(\d[\d,]*)\s+(pages?|sources?|connections?|categories|category|links?|relations?|sessions?)\b/gi)) {
      const key = `${m[1]} ${m[2].toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); out.push({ n: Number(m[1].replace(/,/g, "")), noun: m[2].toLowerCase().replace(/s$/, "").replace(/ie$/, "y"), text: key }); }
    }
    return out;
  };
  const counts = countsIn(bodyText);
  const heads = [...document.querySelectorAll("h1, h2, h3, header, [aria-live], [role=status]")].filter((e) => e.checkVisibility());
  const headCounts = countsIn(heads.map((e) => e.innerText).join("\n"));

  const links = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /^https?:/.test(h)))];
  return {
    vw, vh, hScroll, docHeight: root.scrollHeight,
    overflow: overflow.sort((a, b) => b.right - a.right).slice(0, 5),
    clipped: clipped.slice(0, 8), cutText: cutText.slice(0, 10), ellipsisNoTitle: ellipsisNoTitle.slice(0, 10),
    emptyHeadings: emptyHeadings.slice(0, 5), covered: covered.slice(0, 8), brokenImages, brokenAnchors: brokenAnchors.slice(0, 10),
    badText, notFound, appError, counts, headCounts, links, title: document.title,
  };
}
