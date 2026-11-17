/** Above this many line pairs the diff is summarised rather than computed. */
const MAX_CELLS = 4_000_000;
const CONTEXT = 2;

type Line = { mark: " " | "-" | "+"; text: string };

function lcsTable(a: string[], b: string[]) {
  const table = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  return table;
}

function walk(a: string[], b: string[]): Line[] {
  const table = lcsTable(a, b);
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i === a.length || table[i]![j + 1]! > table[i + 1]![j]!)
    ) {
      lines.push({ mark: "+", text: b[j]! });
      j += 1;
    } else {
      lines.push({ mark: "-", text: a[i]! });
      i += 1;
    }
  }
  return lines;
}

/** Changed lines with a little context, `@@` between distant changes. */
function hunks(lines: Line[]) {
  const near = (index: number) =>
    lines
      .slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1)
      .some((line) => line.mark !== " ");
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (!near(index)) {
      skipped = true;
      return;
    }
    if (skipped || out.length === 0) out.push("@@");
    skipped = false;
    out.push(`${line.mark} ${line.text}`);
  });
  return out;
}

const split = (text: string) => text.replace(/\n$/, "").split("\n");

/** A line diff of two files, or an empty list when they are the same. */
export function lineDiff(before: string, after: string): string[] {
  if (before === after) return [];
  const a = split(before);
  const b = split(after);
  if (a.length * b.length > MAX_CELLS)
    return [`(files too large to compare: ${a.length} → ${b.length} lines)`];
  return hunks(walk(a, b));
}
