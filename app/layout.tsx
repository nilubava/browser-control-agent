import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Browser Agent",
  description: "Browser control agent — type a command and watch it happen",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,     // prevent double-tap zoom on mobile
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ margin: 0, fontFamily: "monospace", background: "#0a0a0a", color: "#e0e0e0",
                     WebkitTapHighlightColor: "transparent" }}>
        {children}
      </body>
    </html>
  );
}
