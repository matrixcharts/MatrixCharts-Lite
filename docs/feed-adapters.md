# Candle Feed Adapters

`CandleSource` is the transport boundary. A source exposes `state`, `subscribe()`, `start()`, and `stop()`. `ChartFeedController` binds source messages to `Chart.replaceData()`, `Chart.appendBatch()`, and `Chart.updateLast()` and disposes both the subscription and source.

## WebSocket Message Format

The native `WebSocketCandleSource` sends `{"type":"subscribe"}` after connecting and accepts JSON text messages in these forms:

```json
{"type":"snapshot","sequence":100,"candles":[{"time":1735689600000,"open":100,"high":102,"low":99,"close":101}]}
```

```json
{"type":"append","sequence":101,"candles":[{"time":1735689660000,"open":101,"high":103,"low":100,"close":102}]}
```

```json
{"type":"update","sequence":102,"candle":{"time":1735689660000,"open":101,"high":104,"low":100,"close":103}}
```

```json
{"type":"heartbeat","sequence":103}
```

Sequences are non-negative safe integers and increment once per message, including heartbeats and append batches. A snapshot is authoritative and resets the sequence baseline. Duplicate/old deltas are ignored. A gap pauses deltas and sends `{"type":"resync","afterSequence":n,"reason":"..."}`; the server must respond with a fresh snapshot. The client does not synthesize missing candles. `time` is a Unix timestamp in milliseconds. Appends must be strictly later than the latest candle, and updates must target the current last candle. If chart validation rejects a delta, the controller requests a snapshot too.

The WebSocket adapter reconnects with capped exponential backoff, checks heartbeat freshness, and requests snapshots after sequence or data-order errors. A snapshot replacement preserves zoom and maps a historical viewport center to its nearest matching timestamp when that time remains in the snapshot; live-follow remains at the newest candle. The adapter does not invent OHLC values. Implementations of `CandleSource` must detach transport handlers and stop timers when `stop()` is called.
