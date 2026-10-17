/** Text helpers shared by the tools' plain-text output. */

/** Cut a long value to `max` characters, ending in an ellipsis. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
