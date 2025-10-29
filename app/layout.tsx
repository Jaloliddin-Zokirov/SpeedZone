import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "ZSpeed — Internet Speed Test for Ping, Download, and Upload",
  description: "ZSpeed is a modern internet speed testing platform that allows users to measure real-time ping (latency), download, and upload performance with precision. Built with Next.js, ZSpeed delivers accurate, reliable, and visually engaging results. Whether you want to verify your ISP’s performance, compare network stability, or analyze data transfer speeds, ZSpeed provides a fast and intuitive way to understand your internet connection quality.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
