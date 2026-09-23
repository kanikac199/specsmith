# specsmith eval report

- Run: `20260616T113717Z`
- Started: 2026-06-16T11:37:17.425Z
- Provider: `claude-code:claude-haiku-4-5`
- Max repair iterations: 3
- Specs: 6

## Results

| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iter0 -> Final | Iters | Tokens (in/out) | Time |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: |
| petstore | hard | 19 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 61.6k/25.6k | 2m 17s |
| petstore-expanded | easy | 4 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 54.8k/15.2k | 1m 35s |
| uspto | medium | 3 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 54.4k/17.7k | 2m 6s |
| taskhub | easy | 7 | ✅ | 100% | 86% | 86% | 100% | 86% -> 86% | 2 | 86.9k/25.2k | 2m 33s |
| ledgerly | medium | 12 | ✅ | 100% | 75% | 75% | 100% | 75% -> 75% | 2 | 92.1k/33.3k | 3m 14s |
| polyform | hard | 14 | ✅ | 100% | 86% | 86% | 100% | 86% -> 86% | 2 | 103.4k/38.2k | 4m 3s |

## Aggregates

- Specs compiled: 6/6
- Mean operation coverage: 100% (compiled specs: 100%)
- Mean request success rate: 91% (compiled specs: 91%)
- Mean response validation rate: 91% (compiled specs: 91%)
- Mean type fidelity: 100% (across 6 measured specs)
- Total tokens: 453,189 in / 155,226 out
- Total wall time: 15m 47s

## Per-spec details

### taskhub (easy)

- Iteration 0 (initial): compile ✅; requests OK 86%, responses OK 86%
- Iteration 1 (runtime-repair): compile ✅; requests OK 86%, responses OK 86%

### ledgerly (medium)

- Iteration 0 (initial): compile ✅; requests OK 75%, responses OK 75%
- Iteration 1 (runtime-repair): compile ✅; requests OK 75%, responses OK 75%

### polyform (hard)

- Iteration 0 (initial): compile ✅; requests OK 86%, responses OK 86%
- Iteration 1 (runtime-repair): compile ✅; requests OK 86%, responses OK 86%
