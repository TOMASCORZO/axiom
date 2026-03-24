import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Axiom — AI-Powered Game Engine",
  description:
    "A browser-based game engine where AI builds your games. Generate assets, write logic, build scenes, and run your game from a conversation.",
  keywords: ["game engine", "AI", "game development", "browser", "2D", "3D"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-zinc-950 text-white`}>
        {children}
      </body>
    </html>
  );
}
