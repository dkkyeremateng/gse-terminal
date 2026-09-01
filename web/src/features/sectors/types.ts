import type { components } from '@/lib/api/types-generated'

/**
 * Public sector overview — backs the dashboard heatmap tile.
 *
 * Breadth + average % only; no constituents, no per-sector mover. Pro
 * users get the full SectorRollup via the gated detail endpoint.
 */
export interface SectorOverview {
  sector: string
  avgPctChange: number
  advanceCount: number
  declineCount: number
  neutralCount: number
}

export type SectorRollup = components['schemas']['SectorRollup']
export type SectorMover = components['schemas']['SectorMover']
