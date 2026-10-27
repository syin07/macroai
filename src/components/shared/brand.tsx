import Link from "next/link";

export function MacroMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle
        cx="16"
        cy="16"
        r="11"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray="28 42"
        strokeLinecap="round"
        transform="rotate(-90 16 16)"
      />
      <circle
        cx="16"
        cy="16"
        r="11"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray="15 55"
        strokeDashoffset="-33"
        strokeLinecap="round"
        transform="rotate(-90 16 16)"
        opacity=".55"
      />
      <circle
        cx="16"
        cy="16"
        r="11"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray="12 58"
        strokeDashoffset="-53"
        strokeLinecap="round"
        transform="rotate(-90 16 16)"
        opacity=".3"
      />
      <circle cx="16" cy="16" r="3" fill="currentColor" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link
      href="/chat"
      className="brand-link inline-flex min-h-11 items-center gap-2.5 rounded-xl"
      aria-label="MacroAI home"
    >
      <MacroMark className="h-8 w-8 text-[var(--app-accent)]" />
      <span className="text-[17px] font-semibold tracking-[-0.045em]">
        MacroAI
      </span>
    </Link>
  );
}
