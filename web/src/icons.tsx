/** 押せる所と目印の小さな線のアイコン（大きな絵は GPT が描いた素材 /art/ を使う） */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', 'aria-hidden': true };

export const IconFolder = () => (
  <svg {...P}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);
export const IconPlus = () => (
  <svg {...P}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
export const IconGear = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8l1.6 2.3 2.7-.7.6 2.7 2.6 1-.9 2.6 1.6 2.3-2.3 1.6.1 2.8-2.8.3-1.3 2.5-2.5-1.2-2.5 1.2-1.3-2.5-2.8-.3.1-2.8-2.3-1.6 1.6-2.3-.9-2.6 2.6-1 .6-2.7 2.7.7z" />
  </svg>
);
export const IconDoc = () => (
  <svg {...P}>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
    <path d="M14 3v4h4M9 13h6M9 16.5h6" />
  </svg>
);
export const IconImage = () => (
  <svg {...P}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8 8" />
  </svg>
);
export const IconUpload = () => (
  <svg {...P}>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
    <path d="M14 3v4h4M12 17v-6M9.5 13.5 12 11l2.5 2.5" />
  </svg>
);
export const IconSlides = () => (
  <svg {...P}>
    <rect x="7" y="3.5" width="12" height="15" rx="1.5" />
    <path d="M5 6.5v13A1.5 1.5 0 0 0 6.5 21H16" />
    <path d="M10 8h6M10 11h6M10 14h4" />
  </svg>
);
export const IconClock = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const IconCoins = () => (
  <svg {...P}>
    <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
    <path d="M5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5M5 11.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5" />
  </svg>
);
export const IconSpark = () => (
  <svg {...P}>
    <path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6zM17.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </svg>
);
export const IconCheck = () => (
  <svg {...P} strokeWidth={2.4}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconCheckCircle = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8 12.3l2.7 2.7L16 9.6" />
  </svg>
);
export const IconAlert = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5.5M12 16.3v.2" />
  </svg>
);
export const IconBack = () => (
  <svg {...P}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);
export const IconNext = () => (
  <svg {...P}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconUndo = () => (
  <svg {...P}>
    <path d="M8 8H4V4" />
    <path d="M4.5 8A8 8 0 1 1 4 13" />
  </svg>
);
export const IconDownload = () => (
  <svg {...P}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
  </svg>
);
export const IconShield = () => (
  <svg {...P}>
    <path d="M12 3l7 3v5.5c0 4.2-3 7.7-7 9-4-1.3-7-4.8-7-9V6z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </svg>
);
export const IconNote = () => (
  <svg {...P}>
    <path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 16H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4.5 14.5z" />
    <path d="M8.5 8.5h7M8.5 11.5h4.5" />
  </svg>
);
export const IconHistory = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const IconDocCheck = () => (
  <svg {...P}>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21H12" />
    <path d="M14 3v4h4v5M9 9h4M9 12.5h6M9 16h2.5M14.5 18l2 2 3.5-4" />
  </svg>
);
