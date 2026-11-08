/**
 * Per-seller "pulse": billable spend per minute over the last hour (the sparkline column) plus lifetime calls,
 * voids and billable. Seeded from /api/metrics/timeseries and SellerDTO.stats, then moved by live voucher
 * events, including an accepted IOU that an AI review voids later (its spend comes back out of its minute).
 */
import type { SellerDTO, TimeseriesPointDTO } from "@p402/shared";
import type { SellerPulseRow, VoucherRow } from "./store";

const MINUTE = 60_000;
const PULSE_MINUTES = 60;

interface SellerPulse {
  sellerId: string;
  calls: number;
  voids: number;
  billableMicros: number;
  /** minute start (epoch ms) -> billable micros */
  buckets: Map<number, number>;
}

export class PulseModel {
  private sellers = new Map<string, SellerPulse>();

  /** Replace everything from a fresh load. */
  reset(sellers: Iterable<SellerDTO>, points: readonly TimeseriesPointDTO[]): void {
    this.sellers.clear();
    for (const seller of sellers) {
      const entry = this.entry(seller.id);
      entry.calls = seller.stats.calls;
      entry.voids = seller.stats.voids;
      entry.billableMicros = seller.stats.grossMicros;
    }
    for (const point of points) {
      const minute = Math.floor(point.t / MINUTE) * MINUTE;
      for (const [sellerId, micros] of Object.entries(point.bySeller ?? {})) {
        if (!micros) continue;
        const buckets = this.entry(sellerId).buckets;
        buckets.set(minute, (buckets.get(minute) ?? 0) + micros);
      }
    }
  }

  /** Authoritative lifetime stats from a seller.updated event. */
  setStats(seller: SellerDTO): void {
    const entry = this.entry(seller.id);
    entry.calls = seller.stats.calls;
    entry.voids = seller.stats.voids;
    entry.billableMicros = seller.stats.grossMicros;
  }

  /** Make sure a seller seen only in vouchers still gets a row. */
  ensure(sellerId: string): void {
    this.entry(sellerId);
  }

  /** Apply the change from `prev` (undefined = new IOU) to `next`. */
  apply(prev: VoucherRow | undefined, next: VoucherRow): void {
    const entry = this.entry(next.sellerId);
    const minute = Math.floor(next.createdAt / MINUTE) * MINUTE;
    const addSpend = (micros: number) => entry.buckets.set(minute, Math.max(0, (entry.buckets.get(minute) ?? 0) + micros));
    if (!prev) {
      entry.calls += 1;
      if (next.status === "voided") entry.voids += 1;
      else {
        entry.billableMicros += next.priceMicros;
        addSpend(next.priceMicros);
      }
      return;
    }
    if (prev.status === next.status) return;
    if (next.status === "voided") {
      entry.voids += 1;
      entry.billableMicros = Math.max(0, entry.billableMicros - next.priceMicros);
      addSpend(-next.priceMicros);
    } else {
      entry.voids = Math.max(0, entry.voids - 1);
      entry.billableMicros += next.priceMicros;
      addSpend(next.priceMicros);
    }
  }

  rows(now: number, nameOf: (id: string) => string): SellerPulseRow[] {
    const current = Math.floor(now / MINUTE) * MINUTE;
    const first = current - (PULSE_MINUTES - 1) * MINUTE;
    const rows: SellerPulseRow[] = [];
    for (const entry of this.sellers.values()) {
      const series: number[] = [];
      let spend = 0;
      for (const minute of [...entry.buckets.keys()]) if (minute < first - MINUTE) entry.buckets.delete(minute);
      for (let t = first; t <= current; t += MINUTE) {
        const micros = entry.buckets.get(t) ?? 0;
        spend += micros;
        series.push(micros / 1_000_000);
      }
      rows.push({
        sellerId: entry.sellerId,
        name: nameOf(entry.sellerId),
        series,
        spend60Micros: spend,
        calls: entry.calls,
        voids: entry.voids,
        billableMicros: entry.billableMicros,
      });
    }
    return rows;
  }

  private entry(sellerId: string): SellerPulse {
    let entry = this.sellers.get(sellerId);
    if (!entry) {
      entry = { sellerId, calls: 0, voids: 0, billableMicros: 0, buckets: new Map() };
      this.sellers.set(sellerId, entry);
    }
    return entry;
  }
}
