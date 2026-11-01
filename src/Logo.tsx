import { useId } from "react";

/** UAT's icon (`brand/uat-icon.svg`) for small sizes: the tile and its trace,
 *  without the dotted canvas, glow and shadow, which only blur at this size. */
export function Logo({ size = 28 }: { size?: number }) {
  // Gradient ids must be unique on the page and usable in url(#…)
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg className="logo" width={size} height={size} viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f2c46" />
          <stop offset="1" stopColor="#0c111b" />
        </linearGradient>
        <linearGradient id={`${id}-trace`} x1="294" y1="0" x2="730" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3a6cf0" />
          <stop offset="1" stopColor="#82abff" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${id}-tile)`} />
      <g stroke="#3f5378" strokeWidth="22" strokeLinecap="round" fill="none">
        <path d="M294 529 L322 300" />
        <path d="M439 674 L664 770" />
        <path d="M730 360 L586 236" />
      </g>
      <g fill="#3f5378">
        <circle cx="322" cy="300" r="32" />
        <circle cx="664" cy="770" r="32" />
        <circle cx="586" cy="236" r="32" />
      </g>
      <path
        d="M294 529 L439 674 L730 360"
        fill="none"
        stroke={`url(#${id}-trace)`}
        strokeWidth="70"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g fill="#ffffff">
        <circle cx="294" cy="529" r="56" />
        <circle cx="439" cy="674" r="56" />
        <circle cx="730" cy="360" r="56" />
      </g>
    </svg>
  );
}
