import type { Macros } from "@/types/api";

// One circle split into four equal wedges (calories, protein, carbs, fat). Each wedge fills from the
// center outward by consumed / target. The fill radius grows with the square root of the fraction so
// the *area* matches the percentage; a plain radius would make 50% look like a quarter. Over-target
// wedges stay full and get an outer "over" arc, so progress remains readable past a goal (PRD §13).

export const PIE_FIELDS = [
  { key: "calories", label: "Calories", short: "Cal", unit: "kcal" },
  { key: "protein_g", label: "Protein", short: "Pro", unit: "g" },
  { key: "carbs_g", label: "Carbs", short: "Carb", unit: "g" },
  { key: "fat_g", label: "Fat", short: "Fat", unit: "g" },
] as const;

export type PieField = (typeof PIE_FIELDS)[number];

export function fraction(consumed: number, target: number): number {
  if (target <= 0) return consumed > 0 ? 1 : 0;
  return Math.max(0, consumed / target);
}

const SIZE = 260;
const CENTER = SIZE / 2;
const RADIUS = 96;
const LABEL_RADIUS = RADIUS + 20;
const OVER_RADIUS = RADIUS + 6;
// Wedges run clockwise from 12 o'clock: calories, protein, carbs, fat.
const START = -Math.PI / 2;
const SPAN = Math.PI / 2;
const GAP = 0.035; // radians trimmed from each wedge edge so the seams read as four pieces
const OPACITY = [1, 0.82, 0.64, 0.48];

const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

function point(angle: number, radius: number): string {
  return `${(CENTER + radius * Math.cos(angle)).toFixed(2)} ${(CENTER + radius * Math.sin(angle)).toFixed(2)}`;
}

function wedgePath(index: number, radius: number): string {
  const from = START + index * SPAN + GAP;
  const to = START + (index + 1) * SPAN - GAP;
  return `M ${CENTER} ${CENTER} L ${point(from, radius)} A ${radius} ${radius} 0 0 1 ${point(to, radius)} Z`;
}

function arcPath(index: number, radius: number): string {
  const from = START + index * SPAN + GAP;
  const to = START + (index + 1) * SPAN - GAP;
  return `M ${point(from, radius)} A ${radius} ${radius} 0 0 1 ${point(to, radius)}`;
}

export function MacroPie({ consumed, targets }: { consumed: Macros; targets: Macros }) {
  const wedges = PIE_FIELDS.map((field, index) => {
    const part = fraction(consumed[field.key], targets[field.key]);
    return {
      ...field,
      index,
      part,
      percent: Math.round(part * 100),
      radius: RADIUS * Math.sqrt(Math.min(1, part)),
      over: consumed[field.key] - targets[field.key],
    };
  });
  const description = wedges
    .map(
      (w) =>
        `${w.label} ${number(consumed[w.key])} of ${number(targets[w.key])} ${w.unit}, ${w.percent}%${w.over > 0 ? `, ${number(w.over)} ${w.unit} over` : ""}`,
    )
    .join(". ");
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Today's progress toward each goal. ${description}.`}
      className="mx-auto block h-auto w-full max-w-[300px]"
    >
      {wedges.map((w) => (
        <g key={w.key} data-wedge={w.key} data-percent={w.percent}>
          <path d={wedgePath(w.index, RADIUS)} fill="var(--app-surface)" stroke="var(--app-line)" strokeWidth="1.5" />
          {w.radius > 0 && (
            <path
              data-fill="true"
              d={wedgePath(w.index, w.radius)}
              fill="var(--app-accent)"
              fillOpacity={OPACITY[w.index]}
            />
          )}
          {w.over > 0 && (
            <path
              data-overflow="true"
              d={arcPath(w.index, OVER_RADIUS)}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.55"
              strokeWidth="3"
              strokeLinecap="round"
            />
          )}
          <text
            x={CENTER + LABEL_RADIUS * Math.cos(START + (w.index + 0.5) * SPAN)}
            y={CENTER + LABEL_RADIUS * Math.sin(START + (w.index + 0.5) * SPAN)}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-current text-[11px] font-medium"
          >
            {w.short} {w.percent}%
          </text>
        </g>
      ))}
    </svg>
  );
}
