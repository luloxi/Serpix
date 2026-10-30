import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#B9E8F8" }}>
        <div style={{ width: 122, height: 122, borderRadius: "50%", background: "#D93686", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFFFFF", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 94, fontWeight: 800, lineHeight: 1, paddingBottom: 7 }}>
          S
        </div>
      </div>
    ),
    size,
  );
}
