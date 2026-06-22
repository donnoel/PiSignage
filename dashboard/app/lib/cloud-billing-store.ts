export type CloudBillingSummary = {
  amountUsd: number | null;
  currency: string;
  endDate: string | null;
  estimated: boolean;
  message: string;
  startDate: string | null;
  status: "available" | "error" | "local" | "manual";
};

function cloudDashboardConfigured(): boolean {
  return process.env.BEAM_DASHBOARD_MODE === "cloud";
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

  return {
    amountUsd: null,
    currency: "USD",
    endDate: null,
    estimated: false,
    message: "AWS Budgets owns cost alerts. Dashboard Cost Explorer refresh is disabled to avoid paid API polling.",
    startDate: null,
    status: "manual"
  };
}
