import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "枢纽 · 企业智能工作台",
  description: "把人员、项目、审批与知识串成可行动的企业智能脉络。",
  manifest: "/manifest.webmanifest",
  applicationName: "枢纽办公",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "枢纽办公" },
  icons: { icon: "/icons/nexus-192.svg", apple: "/icons/nexus-192.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
