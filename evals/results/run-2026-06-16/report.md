# specsmith eval report

- Run: `20260616T112751Z`
- Started: 2026-06-16T11:27:51.162Z
- Provider: `claude-code:claude-opus-4-8`
- Max repair iterations: 3
- Specs: 6

## Results

| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iter0 -> Final | Iters | Tokens (in/out) | Time |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: |
| petstore | hard | 19 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 54.7k/7.7k | 1m 9s |
| petstore-expanded | easy | 4 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 47.5k/2.4k | 28.9s |
| uspto | medium | 3 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 49.0k/6.2k | 1m 11s |
| taskhub | easy | 7 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 52.6k/6.6k | 1m 13s |
| ledgerly | medium | 12 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 56.4k/10.2k | 1m 46s |
| polyform | hard | 14 | ✅ | 100% | 100% | 100% | 100% | 100% -> 100% | 1 | 69.2k/14.8k | 2m 38s |

## Aggregates

- Specs compiled: 6/6
- Mean operation coverage: 100% (compiled specs: 100%)
- Mean request success rate: 100% (compiled specs: 100%)
- Mean response validation rate: 100% (compiled specs: 100%)
- Mean type fidelity: 100% (across 6 measured specs)
- Total tokens: 329,456 in / 47,824 out
- Total wall time: 8m 26s

## Per-spec details

All specs passed at 100% — nothing to report.
