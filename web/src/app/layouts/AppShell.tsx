import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { TickerTape } from '@/components/layout/TickerTape'
import { BottomNav } from '@/components/layout/BottomNav'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { WsProvider } from '@/app/providers/WsProvider'
import { useHotkey } from '@/lib/hooks/useHotkey'

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  useHotkey('mod+k', () => setPaletteOpen((o) => !o))

  return (
    <WsProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to main content
      </a>
      <div className="flex min-h-dvh bg-background text-foreground">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onOpenPalette={() => setPaletteOpen(true)} />
          <TickerTape />
          <main id="main-content" className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8" tabIndex={-1}>
            <Outlet />
          </main>
          <BottomNav />
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </WsProvider>
  )
}
