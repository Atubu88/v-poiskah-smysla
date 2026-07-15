import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "В поисках смысла — интерактивный путь",
  description: "Последовательный путь размышления о счастье, человеческой нужде, Создателе, Послании, Коране и доверии Богу.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#174f3b" />
        <script src="https://telegram.org/js/telegram-web-app.js?59" defer></script>
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
