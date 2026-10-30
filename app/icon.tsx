import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#080A12" }}>
        <svg width="512" height="512" viewBox="0 0 512 512">
          <defs>
            <linearGradient id="loop" x1="72" y1="360" x2="430" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#00DDF5" /><stop offset=".34" stopColor="#168BFF" /><stop offset=".68" stopColor="#C34BFF" /><stop offset="1" stopColor="#FF3D9A" />
            </linearGradient>
            <linearGradient id="gold" x1="190" y1="150" x2="320" y2="370" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFF27A" /><stop offset=".52" stopColor="#FFD83D" /><stop offset="1" stopColor="#FFB928" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="112" fill="#080A12" />
          <circle cx="256" cy="256" r="184" fill="none" stroke="url(#loop)" strokeWidth="27" />
          <path d="M352 83 C375 92 394 111 406 135 C386 128 367 136 356 154 C362 129 360 104 352 83Z" fill="#FF3D9A" />
          <path d="M370 153c-35-34-74-51-123-51-78 0-132 43-132 108 0 60 40 91 127 111l38 9c43 10 61 20 61 40 0 24-27 39-69 39-48 0-91-19-127-57l-54 65c42 49 106 76 180 76 91 0 151-44 151-117 0-61-38-92-129-114l-41-10c-41-10-56-20-56-39 0-20 22-33 57-33 37 0 72 13 105 40l52-67Z" transform="translate(256 256) scale(.56) translate(-256 -256)" fill="url(#gold)" stroke="#FFF3A0" strokeWidth="3.5" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    size,
  );
}
