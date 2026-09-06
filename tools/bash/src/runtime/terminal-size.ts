export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSizeSource {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export const DEFAULT_PTY_SIZE: Readonly<TerminalSize> = { cols: 120, rows: 30 };
export const MAX_PTY_SIZE: Readonly<TerminalSize> = { cols: 500, rows: 200 };
const MIN_PTY_SIZE: Readonly<TerminalSize> = { cols: 20, rows: 5 };
const TOOL_BOX_HORIZONTAL_CELLS = 2;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

export function normalizeTerminalSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: boundedInteger(size?.cols, DEFAULT_PTY_SIZE.cols, MIN_PTY_SIZE.cols, MAX_PTY_SIZE.cols),
    rows: boundedInteger(size?.rows, DEFAULT_PTY_SIZE.rows, MIN_PTY_SIZE.rows, MAX_PTY_SIZE.rows),
  };
}

/** Exact host TTY size adjusted for Pi's one-cell tool box padding on each side. */
export function hostToolTerminalSize(source: TerminalSizeSource = process.stdout): TerminalSize | undefined {
  if (!source.isTTY || !Number.isFinite(source.columns) || !Number.isFinite(source.rows)) return undefined;
  return normalizeTerminalSize({
    cols: source.columns! - TOOL_BOX_HORIZONTAL_CELLS,
    rows: source.rows!,
  });
}
