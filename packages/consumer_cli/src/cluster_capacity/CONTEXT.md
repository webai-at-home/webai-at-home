# Directory Context: `/packages/consumer_cli/src/cluster_capacity`

## Purpose

Estimates how many concurrent runs of a pipeline the connected workers can support, behind the `capacity` subcommand and behind the models `consumer_openai` offers.

## Key Exports & Entry Points

- `capacity_calculator.ts`: `CapacityCalculator`, how many concurrent runs of a pipeline the cluster can support.
- `device_availability.ts`: `DeviceAvailability`, the availability rule the gateway itself applies to a worker.
- `cluster_capacity_reader.ts`: `ClusterCapacityReader`, which takes one snapshot of the cluster and estimates capacity per task type. Exported from [`../index.ts`](../index.ts) for other packages.

## Rules

- `DeviceAvailability` restates the gateway's own placement rule from [`packages/gateway/src/device`](../../../gateway/src/device/) so the two never disagree; if that rule changes, this one changes with it.
- `capacity_calculator.ts` and `device_availability.ts` import from no other folder of this package: the formula stays a local computation over a snapshot somebody else fetched.
- `cluster_capacity_reader.ts` is the one file here that connects, and it closes its connection before it computes anything: no caller keeps a live copy of the device list.

## Background

- The capacity of every task type from one snapshot comes from [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
