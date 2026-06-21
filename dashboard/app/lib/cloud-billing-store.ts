import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

export type CloudBillingSummary = {
  amountUsd: number | null;
  currency: string;
  endDate: string | null;
  estimated: boolean;
  message: string;
  startDate: string | null;
  status: "available" | "error" | "local";
};

const costExplorer = new CostExplorerClient({ region: "us-east-1" });
const billingCacheTtlMs = 6 * 60 * 60 * 1000;
let cachedBillingSummary: {
  expiresAtMs: number;
  rangeKey: string;
  summary: CloudBillingSummary;
} | null = null;
let billingSummaryRequest: Promise<CloudBillingSummary> | null = null;

function cloudDashboardConfigured(): boolean {
  return process.env.BEAM_DASHBOARD_MODE === "cloud";
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthRange(now: Date = new Date()): { end: string; start: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return {
    end: dateOnly(end),
    start: dateOnly(start)
  };
}

export async function readCloudBillingSummary(): Promise<CloudBillingSummary> {
  if (!cloudDashboardConfigured()) {
    return {
      amountUsd: null,
      currency: "USD",
      endDate: null,
      estimated: false,
      message: "AWS billing is only available in cloud mode.",
      startDate: null,
      status: "local"
    };
  }

  const range = monthRange();
  const rangeKey = `${range.start}:${range.end}`;
  const nowMs = Date.now();
  if (
    cachedBillingSummary &&
    cachedBillingSummary.rangeKey === rangeKey &&
    cachedBillingSummary.expiresAtMs > nowMs
  ) {
    return cachedBillingSummary.summary;
  }

  if (billingSummaryRequest) {
    return billingSummaryRequest;
  }

  billingSummaryRequest = fetchCloudBillingSummary(range, rangeKey);
  try {
    return await billingSummaryRequest;
  } finally {
    billingSummaryRequest = null;
  }
}

async function fetchCloudBillingSummary(range: { end: string; start: string }, rangeKey: string): Promise<CloudBillingSummary> {
  try {
    const result = await costExplorer.send(new GetCostAndUsageCommand({
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      TimePeriod: {
        End: range.end,
        Start: range.start
      }
    }));
    const firstResult = result.ResultsByTime?.[0];
    const metric = firstResult?.Total?.UnblendedCost;
    const parsed = metric?.Amount ? Number(metric.Amount) : Number.NaN;
    const amountUsd = Number.isFinite(parsed) ? parsed : null;

    const summary: CloudBillingSummary = {
      amountUsd,
      currency: metric?.Unit ?? "USD",
      endDate: range.end,
      estimated: Boolean(firstResult?.Estimated),
      message: amountUsd === null
        ? "Cost Explorer did not return a month-to-date total."
        : "Month-to-date AWS account cost from Cost Explorer. Cached for 6 hours to avoid paid billing API churn.",
      startDate: range.start,
      status: amountUsd === null ? "error" : "available"
    };

    if (summary.status === "available") {
      cachedBillingSummary = {
        expiresAtMs: Date.now() + billingCacheTtlMs,
        rangeKey,
        summary
      };
    }

    return summary;
  } catch (error) {
    return {
      amountUsd: null,
      currency: "USD",
      endDate: range.end,
      estimated: false,
      message: error instanceof Error ? error.message : "Could not read Cost Explorer.",
      startDate: range.start,
      status: "error"
    };
  }
}
