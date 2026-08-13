# Directory Context: `/packages/consumer_cli/src/cluster_capacity`

## Purpose

Estimates how many concurrent runs of a pipeline the connected workers can support, behind the `capacity` subcommand.

## Key Exports & Entry Points

- `capacity_calculator.ts`: `CapacityCalculator`, how many concurrent runs of a pipeline the cluster can support.
- `device_availability.ts`: `DeviceAvailability`, the availability rule the gateway itself applies to a worker.

## Rules

- `DeviceAvailability` restates the gateway's own placement rule from [`packages/gateway/src/device`](../../../gateway/src/device/) so the two never disagree; if that rule changes, this one changes with it.
- This folder imports from no other folder of this package.

## Background

- Nothing here needs a longer reason than the rule itself gives.
