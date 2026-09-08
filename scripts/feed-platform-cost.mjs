#!/usr/bin/env node
// Rate-card scenario, not measured utilization or a claim of a billing cap.
const secondsPerHour = 3600;
const rates = {
  memoryGiBSecond: 0.0000025,
  cpuVCPUSecond: 0.00002,
  diskGBSecond: 0.00000007,
};
function containers(hours, utilization) {
  const provisioned = { instances: 3, memoryGiB: 3, vcpu: 0.75, diskGB: 12 };
  return {
    activeHoursPerInstance: hours,
    cpuUtilizationOfAllocation: utilization,
    ...provisioned,
    memoryUSD:
      hours * secondsPerHour * provisioned.memoryGiB * rates.memoryGiBSecond,
    cpuUSD:
      hours *
      secondsPerHour *
      provisioned.vcpu *
      utilization *
      rates.cpuVCPUSecond,
    diskUSD: hours * secondsPerHour * provisioned.diskGB * rates.diskGBSecond,
  };
}
const production = containers(730, 1),
  staging = containers(40, 1);
const containerUSD = [production, staging].reduce(
  (sum, v) => sum + v.memoryUSD + v.cpuUSD + v.diskUSD,
  0,
);
const assumedOtherServicesUSD = 10,
  assumedWorkersBaseUSD = 5;
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      status: "unmeasured planning scenario",
      rateDate: "2026-09-08",
      source: "https://developers.cloudflare.com/containers/platform/pricing/",
      rates,
      production,
      staging,
      includedAllowancesApplied: false,
      containerUSD,
      assumedOtherServicesUSD,
      assumedWorkersBaseUSD,
      forecastUSD:
        containerUSD + assumedOtherServicesUSD + assumedWorkersBaseUSD,
      approvedMaximumUSD: 100,
      planningTargetUSD: 80,
      requiredMeasurements: [
        "active hours including retries",
        "CPU utilization",
        "staging active hours",
        "D1 storage/reads/writes",
        "R2 operations/storage",
        "queue deliveries",
        "Workers/Durable Objects",
        "logs/egress",
        "embedding calls",
      ],
      caveats: [
        "USD 10 for other services is an assumption, not measured billing.",
        "Shared-account allowances are not deducted.",
        "Forty staging instance-hours per instance is a budget assumption, not a platform-enforced limit.",
        "Instance caps do not cap request/storage/AI charges.",
        "No paid subscription invoice was verified.",
      ],
    },
    null,
    2,
  ),
);
