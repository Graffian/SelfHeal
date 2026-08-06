import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SelfHeal — Self-Correcting API Agent",
  description:
    "Paste an OpenAPI spec URL and a plain-English goal. SelfHeal plans the request with an LLM, executes it for real, and self-corrects up to 3 times when it fails.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body className="bg-term-bg font-mono text-term-text antialiased">{children}</body>
    </html>
  );
}
