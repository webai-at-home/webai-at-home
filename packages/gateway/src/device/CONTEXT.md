# Directory Context: `/packages/gateway/src/device`

## Purpose

Holds every connected device, decides which device a stage that keeps state must run on, and tells the connections that asked what changed about the connected devices.

## Key Exports & Entry Points

- `device_registry.ts`: `DeviceRegistry`, which holds the connected devices and finds a worker for a stage.
- `worker_placement.ts`: `WorkerPlacement`, which decides which device a stage that keeps state must run on.
- `device_announcer.ts`: `DeviceAnnouncer`, which tells the connections that asked what changed about the connected devices.

## Rules

- A device leaves `DeviceRegistry` the moment its connection closes; nothing here keeps a device that is not currently connected.
- `WorkerPlacement` is consulted only for a stage that keeps state across more than one call — a sharded pipeline stage. A stateless stage goes to any device `DeviceRegistry` reports as free.
- Device and stage-offer shapes come from `@webai/protocol` and are never restated here.

## Background

- Which stages keep state, and why that changes placement, follows from the sharded pipeline stages documented in [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md).
