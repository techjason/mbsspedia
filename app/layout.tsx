import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { baseOptions } from "@/lib/layout.shared";
import { SearchWarmup } from "@/components/layout/search-warmup";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MBBSPedia",
  description: "MBBSPedia",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { nav, ...base } = baseOptions();

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased flex flex-col min-h-screen`}
      >
        <RootProvider
          search={{
            options: {
              api: "/api/search",
              delayMs: 180,
            },
          }}
        >
          <SearchWarmup />
          <DocsLayout
            {...base}
            nav={{ ...nav, mode: "top" }}
            tree={source.getPageTree()}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
