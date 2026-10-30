import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#b9e8f8",
        }}
      >
        <div
          style={{
            width: 394,
            height: 394,
            borderRadius: "50%",
            border: "10px solid #fff0a8",
            background: "#d94f91",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff0a8",
            fontSize: 310,
            fontWeight: 900,
            fontFamily: "Arial",
            lineHeight: 1,
          }}
        >
          S
        </div>
      </div>
    ),
    size,
  );
}
