import type { HealthItem, SttRow, UsageRow } from './adminDashboard.js';

// Stub: Task 7 replaces this with the real probes.
export async function collectHealth(_args: { usage: UsageRow[]; stt: SttRow[]; now: Date }): Promise<HealthItem[]> {
  return [];
}
