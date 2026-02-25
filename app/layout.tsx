import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "katex/dist/katex.min.css";
import "./globals.css";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { baseOptions } from "@/lib/layout.shared";
import { Provider } from "@/components/provider";
import {
  AISearch,
  AISearchPanel,
  AISearchTrigger,
} from "@/components/ai-search";
import { cn } from "@/lib/cn";
import { MessageCircleIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
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
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} antialiased flex flex-col min-h-screen`}
      >
        <Provider>
          <DocsLayout
            {...base}
            nav={{ ...nav, mode: "top" }}
            tree={source.getPageTree()}
          >
            <AISearch>
              <AISearchPanel />
              <AISearchTrigger
                position="float"
                className={cn(
                  buttonVariants({
                    variant: "secondary",
                    className: "text-fd-muted-foreground rounded-2xl",
                  }),
                )}
              >
                <MessageCircleIcon className="size-4.5" />
                Ask AI
              </AISearchTrigger>
            </AISearch>

            {children}
            <Analytics />
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
