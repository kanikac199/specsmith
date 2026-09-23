# specsmith eval report

- Run: `20260612T180019Z`
- Started: 2026-06-12T18:00:19.765Z
- Provider: `claude-code:claude-opus-4-8`
- Max repair iterations: 3
- Specs: 6

## Results

| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iter0 -> Final | Iters | Tokens (in/out) | Time |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: |
| petstore | hard | 19 | ✅ | 100% | 100% | 100% | 100% | 63% -> 100% | 2 | 322.0k/29.7k | 5m 2s |
| petstore-expanded | easy | 4 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 45.6k/2.6k | 29.2s |
| uspto | medium | 3 | ✅ | 100% | 67% | 67% | 100% | 67% -> 67% | 2 | 70.9k/8.8k | 1m 44s |
| taskhub | easy | 7 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 49.0k/4.5k | 43.0s |
| ledgerly | medium | 12 | ✅ | 100% | 100% | 100% | 100% | 0% -> 100% | 2 | 301.5k/17.0k | 4m 55s |
| polyform | hard | 14 | ✅ | 100% | 0% | 0% | 100% | 0% -> 0% | 1 | 66.3k/13.1k | 2m 7s |

## Aggregates

- Specs compiled: 6/6
- Mean operation coverage: 100% (compiled specs: 100%)
- Mean request success rate: 78% (compiled specs: 78%)
- Mean response validation rate: 78% (compiled specs: 78%)
- Mean type fidelity: 100% (across 6 measured specs)
- Total tokens: 855,414 in / 75,669 out
- Total wall time: 15m 0s

## Per-spec details

### uspto (medium)

- Iteration 0 (initial): compile ✅; requests OK 67%, responses OK 67%
- Iteration 1 (runtime-repair): compile ✅; requests OK 67%, responses OK 67%

### polyform (hard)

- Iteration 0 (initial): compile ✅; exercise not run
