# Captain IoT gateway

Bridges the Captain API and scooter IoT modules.

**Status: skeleton only.** This process starts, validates its configuration,
and serves a health endpoint. It contains **no device protocol, no packet
formats, and no device commands**.

- The real adapter (`SupplierTcpAdapter`) will be written only from the
  supplier's protocol documentation (decision D-IOT). Nothing may be guessed.
- A simulated adapter arrives in Phase 6 and is always labelled
  `simulated`. Production refuses `DEVICE_ADAPTER=simulated`.
- Commands that could lock wheels or cut propulsion must never be sent to a
  moving scooter (architecture §9).
