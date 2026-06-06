import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Browser Agent",
  description: "Browser control agent — type a command and watch it happen",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "monospace", background: "#0a0a0a", color: "#e0e0e0" }}>
        {children}
      </body>
    </html>
  );
}
