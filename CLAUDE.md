# CLAUDE.md

Guidance for working in this repo with Claude Code.

## What this is

specsmith generates a typed, runtime-validated TypeScript client from an
OpenAPI 3.x spec and self-corrects it against a Prism mock until it compiles and
its requests/responses conform. An eval harness scores generation across a spec
suite. Read `ARCHITECTURE.md` first — it is the authoritative module contract;
`docs/REVIEW.md` records the adversarial review and the fixed/deferred triage.

## Conventions

- **ESM**, Node ≥ 20. Every relative import ends in `.js` (e.g.
  `import { loadSpec } from "../ir/load.js"`).
- Strict TypeScript. `npx tsc --noEmit` must stay clean.
- Shared types live in `src/types.ts` — import from there, don't redefine.
- Everything around the LLM is deterministic (IR, sampling, prompts, metrics).
  Keep it that way: no `Date.now()`/random in prompt-shaping or metric paths.
- The only npm dependencies are the ones already declared; don't add more.

## Commands

```sh
npm test                 # 134 LLM-free tests (Prism runs on localhost)
npx tsc --noEmit         # strict typecheck
npx tsx src/cli.ts generate <spec> -o <dir> --provider claude-code
npx tsx src/cli.ts eval --provider claude-code --model claude-opus-4-8
```

`--provider claude-code` drives the local Claude Code CLI headlessly (no API key
needed); `--provider anthropic` uses `ANTHROPIC_API_KEY` with the Anthropic SDK.

## Where things live

- `src/ir/` — spec load + normalize to `ClientIR`
- `src/llm/` — provider abstraction (Anthropic SDK, Claude Code CLI)
- `src/agent/` — prompts + the generate/repair loop (the heart)
- `src/validate/` — tsc typecheck, Prism mock, operation exerciser, feedback
- `src/eval/` — runner, metrics, type-fidelity probe, report
- `evals/specs/` — the eval suite (manifest + 6 specs)
- `test/` — unit + LLM-free integration (scripted FakeProvider + real Prism)

## Gotchas

- Scratch dirs (`.specsmith-work/`) are resolved from the package root, not cwd,
  so `zod` resolves during typecheck. Don't reintroduce cwd-relative work dirs.
- Generated clients may import only `zod` and `./schemas.js`.
- The exercise classifier checks `err.name` (string), never `instanceof` —
  error classes don't survive bundling.
- `GenerationResult.finalCompile`/`finalExercise` describe the returned files;
  never read `iterations.at(-1)` for headline state (it may be a discarded
  attempt).
