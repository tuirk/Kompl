'use client';

/**
 * "How to read the map": the key to the dots and lines, in a popover on the
 * ⓘ button next to the legend's "Filters" title. It opens on hover, on
 * keyboard focus and on click or tap (a click keeps it open, a second one
 * closes it), stays open while the pointer is over the button or the
 * popover, and closes on Escape or a click outside. Escape is taken before
 * the page's own handler, so it closes the popover and leaves the details
 * panel open. A non-modal dialog named by its heading; it holds no
 * controls, so focus stays on the button. It sits below the button, or
 * beside it when there is no room, always inside the canvas
 * (lib/graph-legend.ts). Nothing in the key is clickable.
 */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Info } from 'lucide-react';
import { closesPanelOnEscape } from '../../../lib/graph-focus';
import { isKeyPopoverOpen, KEY_POPOVER_CLOSED, keyPopover, placePopover, type PopoverPlace } from '../../../lib/graph-legend';
import { MISSING_HEX } from '../../../lib/graph-missing';
import { CATEGORY_HEX } from '../../../lib/graph-palette';
import { Dot, ICON_BUTTON, LEGEND_HEADING } from './legend-parts';
import LineSample, { SAMPLE_W, type SampleKind } from './LineSamples';

const POPOVER_WIDTH = 284;
/** Time to move the pointer from the button onto the popover before it closes. */
const LEAVE_DELAY_MS = 150;
const KEY_ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, minHeight: 20, cursor: 'default',
  fontFamily: 'var(--font-body)', fontSize: 11, lineHeight: '15px', color: 'var(--fg-muted)',
};
const SUB: CSSProperties = { ...LEGEND_HEADING, fontSize: 9, margin: '6px 0 2px', color: 'var(--fg-dim)' };

function KeyRow({ mark, children, width = 22 }: { mark: ReactNode; children: ReactNode; width?: number }) {
  return (
    <div style={KEY_ROW}>
      <span style={{ width, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, flexShrink: 0 }}>{mark}</span>
      <span>{children}</span>
    </div>
  );
}

function LineKey({ kind, children }: { kind: SampleKind; children: ReactNode }) {
  return <KeyRow mark={<LineSample kind={kind} />} width={SAMPLE_W}>{children}</KeyRow>;
}

/** The key itself: dots (colour, size, ring, dashed, BRIDGE, mint ring) and lines, drawn as the canvas draws them. */
export function KeyBody({ opposed, missing }: { opposed: boolean; missing: boolean }) {
  return (
    <>
      <div style={SUB}>Dots</div>
      <KeyRow mark={[0, 1, 2].map((i) => <Dot key={i} color={CATEGORY_HEX[i]} size={6} />)}>colour = topic (as listed under Topics)</KeyRow>
      <KeyRow mark={<><Dot color="var(--fg-muted)" size={5} /><Dot color="var(--fg-muted)" size={10} /></>}>size = how many sources</KeyRow>
      <KeyRow mark={<Dot color="var(--fg-muted)" ring />}>outer ring = overview or comparison</KeyRow>
      {missing && <KeyRow mark={<Dot color={MISSING_HEX} dashed />}>dashed circle = missing page</KeyRow>}
      <KeyRow mark={<span style={{ fontSize: 7, fontWeight: 700, letterSpacing: '0.5px', color: 'var(--fg-muted)' }}>BRIDGE</span>} width={34}>joins two or more topics</KeyRow>
      <KeyRow mark={<Dot color="var(--fg-muted)" accentRing />}>mint ring = selected page, path end, focus</KeyRow>
      <div style={SUB}>Lines (never coloured by topic)</div>
      <LineKey kind="arrow">typed relation (arrow = how it reads)</LineKey>
      {opposed && <LineKey kind="zigzag">competes / contradicts</LineKey>}
      <LineKey kind="related">“related to”</LineKey>
      <LineKey kind="plain">plain link (wikilink only)</LineKey>
      {missing && <LineKey kind="dashed">leads to a missing page</LineKey>}
      <LineKey kind="widths">thicker = more sources</LineKey>
      <LineKey kind="accent">selected line or path</LineKey>
      <p style={{ ...KEY_ROW, margin: '6px 0 0', display: 'block', color: 'var(--fg-dim)' }}>
        Hover a line or zoom in to read relation names. Click a page or line to see why.
      </p>
    </>
  );
}

/**
 * The ⓘ button and its popover. `frame` is the positioned box the popover is
 * placed in (the legend panel); its parent is the canvas it must stay inside.
 */
export default function LegendKey({ opposed, missing, frame }: { opposed: boolean; missing: boolean; frame: RefObject<HTMLElement | null> }) {
  const [state, dispatch] = useReducer(keyPopover, KEY_POPOVER_CLOSED);
  const open = isKeyPopoverOpen(state);
  const [place, setPlace] = useState<PopoverPlace | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | null>(null);
  const popId = useId();
  const headingId = useId();

  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  // Hover is for pointers that hover; a tap opens it through focus and click.
  const enter = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    cancelLeave();
    dispatch('enter');
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      dispatch('leave');
    }, LEAVE_DELAY_MS);
  };
  useEffect(() => () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
  }, []);

  // Escape (before the page's handler, which then leaves the panel alone) and a press outside close it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!closesPanelOnEscape(e)) return;
      e.preventDefault();
      dispatch('escape');
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (target && (buttonRef.current?.contains(target) || popRef.current?.contains(target))) return;
      dispatch('outside');
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  // Placed before it paints: measured hidden, then put below or beside the button inside the canvas.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const box = frame.current;
      const canvas = box?.parentElement;
      const button = buttonRef.current;
      const pop = popRef.current;
      if (!box || !canvas || !button || !pop) return;
      const c = canvas.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const f = box.getBoundingClientRect();
      const at = placePopover(
        { left: b.left - c.left, top: b.top - c.top, width: b.width, height: b.height },
        { width: pop.offsetWidth, height: pop.scrollHeight },
        { width: c.width, height: c.height }
      );
      // From the canvas's coordinates to the panel's (inside its border).
      setPlace({ ...at, left: at.left - (f.left - c.left + box.clientLeft), top: at.top - (f.top - c.top + box.clientTop) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, frame]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="graph-icon-btn"
        aria-label="How to read the map"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popId}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={() => dispatch('focus')}
        onBlur={(e) => {
          if (!(e.relatedTarget instanceof Node && popRef.current?.contains(e.relatedTarget))) dispatch('blur');
        }}
        onClick={() => dispatch('click')}
        style={ICON_BUTTON}
      >
        <Info size={15} aria-hidden />
      </button>
      <KeyDialog id={popId} headingId={headingId} open={open} place={place} popRef={popRef} onEnter={enter} onLeave={leave}>
        <KeyBody opposed={opposed} missing={missing} />
      </KeyDialog>
    </>
  );
}

/** The popover: a non-modal dialog named "How to read the map"; hidden while closed, invisible until placed. */
export function KeyDialog(props: {
  id: string; headingId: string; open: boolean; place: PopoverPlace | null; children: ReactNode;
  popRef?: RefObject<HTMLDivElement | null>; onEnter?(e: PointerEvent): void; onLeave?(e: PointerEvent): void;
}) {
  const { id, headingId, open, place, children, popRef, onEnter, onLeave } = props;
  return (
    <div
      ref={popRef}
      id={id}
      role="dialog"
      aria-labelledby={headingId}
      hidden={!open}
      data-side={place?.side}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{
        position: 'absolute', zIndex: 30, left: place?.left ?? 0, top: place?.top ?? 0, width: POPOVER_WIDTH,
        maxHeight: place?.maxHeight, overflowY: 'auto', display: open ? 'block' : 'none', visibility: place ? 'visible' : 'hidden',
        padding: '12px 14px', textAlign: 'left', cursor: 'default', textTransform: 'none', letterSpacing: 0,
        background: '#121316', border: '1px solid rgba(71,72,74,0.5)', boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
      }}
    >
      <h3 id={headingId} style={{ ...LEGEND_HEADING, color: 'var(--fg-secondary)', margin: 0 }}>How to read the map</h3>
      {children}
    </div>
  );
}
