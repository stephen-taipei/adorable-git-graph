import type { CSSProperties } from 'react';

import type { MascotVariant } from '../themes/config';

export type MascotMood = 'happy' | 'sad' | 'sleepy';

const INK = '#2b2140';
const IMP_INK = '#06231d';
const IMP_HORN = '#ff4f8b';
const PUMPKIN_INK = '#2a1405';
const PUMPKIN_STEM = '#5bbf3a';
const PUMPKIN_GLOW = '#ffe27a';

/** 南瓜燈：三角眼、鋸齒笑臉，眼睛與嘴巴裡透出燭光。 */
function Pumpkin({ mood, color, ink }: { mood: MascotMood; color: string; ink: string }) {
  return (
    <>
      <path
        d="M50 18 q-2 -10 6 -14"
        fill="none"
        stroke={PUMPKIN_STEM}
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M56 10 q12 -6 18 4 q-10 4 -18 -4 z"
        fill={PUMPKIN_STEM}
        stroke={ink}
        strokeWidth="3"
      />
      <ellipse cx="50" cy="56" rx="42" ry="36" fill={color} stroke={ink} strokeWidth="6" />
      <g fill="none" stroke={ink} strokeWidth="3.5" opacity="0.45">
        <path d="M50 21 q-14 35 0 70" />
        <path d="M50 21 q14 35 0 70" />
        <path d="M30 26 q-14 30 0 62" />
        <path d="M70 26 q14 30 0 62" />
      </g>
      <ellipse
        cx="30"
        cy="36"
        rx="9"
        ry="5"
        fill="#fff"
        opacity="0.55"
        transform="rotate(-30 30 36)"
      />
      {mood === 'sleepy' ? (
        <g stroke={ink} strokeWidth="5" strokeLinecap="round" fill="none">
          <path d="M26 50 q7 6 14 0" />
          <path d="M60 50 q7 6 14 0" />
        </g>
      ) : (
        <g fill={PUMPKIN_GLOW} stroke={ink} strokeWidth="3.5" strokeLinejoin="round">
          {mood === 'sad' ? (
            <>
              <path d="M24 46 l18 -4 l-6 14 z" />
              <path d="M76 46 l-18 -4 l6 14 z" />
            </>
          ) : (
            <>
              <path d="M33 38 l10 16 l-20 0 z" />
              <path d="M67 38 l10 16 l-20 0 z" />
            </>
          )}
        </g>
      )}
      {mood === 'sad' ? (
        <path
          d="M34 78 l8 -6 l8 4 l8 -4 l8 6"
          fill="none"
          stroke={ink}
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : mood === 'sleepy' ? (
        <ellipse cx="50" cy="72" rx="6" ry="7" fill={ink} />
      ) : (
        <path
          d="M26 64 q24 24 48 0 l-8 2 l-4 6 l-6 -5 l-6 6 l-6 -6 l-6 5 l-4 -6 z"
          fill={PUMPKIN_GLOW}
          stroke={ink}
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
      )}
    </>
  );
}

/**
 * 小球吉祥物（loading / error / logo 共用）。`imp` 是加上角、尾巴與小虎牙的小惡魔；
 * `pumpkin` 是南瓜燈。
 */
export function Mascot({
  mood = 'happy',
  color = '#4fdc9a',
  size = 96,
  variant = 'blob',
  className,
  style,
}: {
  mood?: MascotMood;
  color?: string;
  size?: number;
  variant?: MascotVariant;
  className?: string;
  style?: CSSProperties;
}) {
  const imp = variant === 'imp';
  const ink = imp ? IMP_INK : INK;
  if (variant === 'pumpkin')
    return (
      <svg
        className={className}
        style={style}
        width={size}
        height={size}
        viewBox="0 0 100 100"
        aria-hidden="true"
        data-variant={variant}
      >
        <Pumpkin mood={mood} color={color} ink={PUMPKIN_INK} />
      </svg>
    );
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-variant={variant}
    >
      {imp && (
        <g fill={IMP_HORN} stroke={ink} strokeWidth="4.5" strokeLinejoin="round">
          {/* tail with a heart-ish spade tip, behind the body */}
          <path
            d="M80 70 q16 6 12 -12"
            fill="none"
            stroke={ink}
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path d="M92 58 l-7 -4 l9 -7 l3 10 z" />
          <path d="M26 22 q-4 -16 6 -20 q-1 10 8 16 z" />
          <path d="M74 22 q4 -16 -6 -20 q1 10 -8 16 z" />
        </g>
      )}
      <circle cx="50" cy="50" r="40" fill={color} stroke={ink} strokeWidth="6" />
      <ellipse
        cx="36"
        cy="30"
        rx="11"
        ry="7"
        fill="#fff"
        opacity="0.7"
        transform="rotate(-30 36 30)"
      />
      {mood === 'sleepy' ? (
        <g stroke={ink} strokeWidth="5" strokeLinecap="round" fill="none">
          <path d="M28 46 q7 6 14 0" />
          <path d="M58 46 q7 6 14 0" />
        </g>
      ) : (
        <g>
          <circle cx="36" cy="46" r="9" fill="#fff" stroke={ink} strokeWidth="3.5" />
          <circle cx="64" cy="46" r="9" fill="#fff" stroke={ink} strokeWidth="3.5" />
          <circle cx="37" cy="48" r="4.2" fill={ink} />
          <circle cx="63" cy="48" r="4.2" fill={ink} />
        </g>
      )}
      <ellipse cx="25" cy="62" rx="7" ry="4.5" fill="#ff6b94" opacity="0.5" />
      <ellipse cx="75" cy="62" rx="7" ry="4.5" fill="#ff6b94" opacity="0.5" />
      {mood === 'sad' ? (
        <path
          d="M38 74 q12 -12 24 0"
          fill="none"
          stroke={ink}
          strokeWidth="5"
          strokeLinecap="round"
        />
      ) : mood === 'sleepy' ? (
        <ellipse cx="50" cy="68" rx="6" ry="7" fill={ink} />
      ) : (
        <path
          d="M37 64 q13 14 26 0"
          fill="none"
          stroke={ink}
          strokeWidth="5"
          strokeLinecap="round"
        />
      )}
      {mood === 'sad' && (
        <path
          d="M72 58 q6 8 0 14 q-6 -6 0 -14z"
          fill="#8fdcff"
          stroke={ink}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      )}
      {imp && mood === 'happy' && (
        <g stroke={ink} strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M27 33 l14 5" />
          <path d="M73 33 l-14 5" />
        </g>
      )}
      {imp && mood !== 'sleepy' && (
        <path
          d="M44 66 l3 6 l3 -5 z"
          fill="#fff"
          stroke={ink}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
