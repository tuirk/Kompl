/**
 * Small line samples for the graph legend, drawn on the canvas's own
 * background with the canvas's line colours and sizes, so the key matches
 * the map exactly: an arrow, a zigzag, the three brightness tiers, the
 * missing-page dashes, widths and the accent.
 */

import { LINE_PX, zigzagAmplitude, zigzagPeriod } from '../../../lib/graph-line-style';
import { ACCENT_HEX, CANVAS_BG, LINE_ALPHA, LINE_HEX, withAlpha } from '../../../lib/graph-palette';
import { edgeWidth } from '../../../lib/graph-layout';

export const SAMPLE_W = 40;
const H = 14;
const MID = H / 2;
/** 1 px lines sit on a half pixel, so they cover one pixel row as a crisp canvas line does (not two at half strength). */
const MID_THIN = MID + 0.5;
const TYPED = withAlpha(LINE_HEX, LINE_ALPHA.typed);
const WIDTH = edgeWidth(1);

export type SampleKind = 'arrow' | 'zigzag' | 'related' | 'plain' | 'dashed' | 'widths' | 'accent';

function zigzagPoints(): string {
  const period = zigzagPeriod(WIDTH);
  const amp = zigzagAmplitude(WIDTH);
  const span = SAMPLE_W - 4;
  const steps = Math.max(2, 2 * Math.round(span / period));
  const step = span / steps;
  const points = [`2,${MID}`];
  for (let i = 1; i < steps; i++) points.push(`${2 + step * i},${MID + (i % 2 === 1 ? amp : -amp)}`);
  points.push(`${SAMPLE_W - 2},${MID}`);
  return points.join(' ');
}

export default function LineSample({ kind, on = true }: { kind: SampleKind; on?: boolean }) {
  const stroke = (color: string, width = WIDTH, dash?: string) => {
    const y = width % 2 === 1 ? MID_THIN : MID;
    return <line x1={2} y1={y} x2={SAMPLE_W - 2} y2={y} stroke={color} strokeWidth={width} strokeDasharray={dash} />;
  };
  const tip = SAMPLE_W - 3;
  return (
    <svg
      width={SAMPLE_W}
      height={H}
      viewBox={`0 0 ${SAMPLE_W} ${H}`}
      aria-hidden
      style={{ display: 'block', background: CANVAS_BG, borderRadius: 2, opacity: on ? 1 : 0.4, flexShrink: 0 }}
    >
      {kind === 'arrow' && (
        <>
          <line x1={2} y1={MID} x2={tip - 2} y2={MID} stroke={TYPED} strokeWidth={WIDTH} />
          <polygon
            points={`${tip},${MID} ${tip - LINE_PX.arrowLength},${MID - LINE_PX.arrowHalfWidth} ${tip - LINE_PX.arrowLength},${MID + LINE_PX.arrowHalfWidth}`}
            fill={TYPED}
          />
        </>
      )}
      {kind === 'zigzag' && <polyline points={zigzagPoints()} fill="none" stroke={TYPED} strokeWidth={WIDTH} />}
      {kind === 'related' && stroke(withAlpha(LINE_HEX, LINE_ALPHA.related))}
      {kind === 'plain' && stroke(withAlpha(LINE_HEX, LINE_ALPHA.plain), 1)}
      {kind === 'dashed' && stroke(withAlpha(LINE_HEX, LINE_ALPHA.related), 1, '3 3')}
      {kind === 'accent' && stroke(ACCENT_HEX)}
      {kind === 'widths' &&
        [1, 2, 3].map((w, i) => <line key={w} x1={2} y1={2.5 + i * 4.5} x2={SAMPLE_W - 2} y2={2.5 + i * 4.5} stroke={TYPED} strokeWidth={w} />)}
    </svg>
  );
}
