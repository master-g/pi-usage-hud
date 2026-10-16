# @master-g/pi-usage-hud

A small [pi](https://pi.dev) extension that keeps the subscription usage of the **current model's provider** pinned in the HUD, so you always know how much of your plan is left before the next request.

## Supported providers

| Provider | What is shown | Auth source |
| --- | --- | --- |
| `codex` | ChatGPT plan main rate limit (model-specific entries like Codex Spark are intentionally ignored) | pi's `openai-codex` OAuth login |
| `kimi` | Kimi Code subscription rolling windows | API key from `~/.pi/agent/auth.json` |
| `zhipu` | Zhipu (GLM) quota | API key from `~/.pi/agent/auth.json` |

Other providers show nothing — the HUD stays out of the way.

## Install

```bash
pi install npm:@master-g/pi-usage-hud
```

Then restart pi. The HUD line appears once a supported provider is active.

## Behavior

- One snapshot file per provider at `~/.pi/agent/<provider>-quota.json`, shared across all pi sessions so the API is never hammered.
- A cooldown window skips the network call when the last successful fetch is fresh enough.
- On fetch errors the last-good usage is preserved — the HUD never blanks out.
- Snapshots are provider-namespaced, so switching providers and back keeps each one's data.

## Adding a provider

Each provider is a module exporting a `ProviderAdapter` (see `provider.ts`):

1. Add `xxx.ts` exporting a `ProviderAdapter`.
2. Register it in the `PROVIDERS` array in `index.ts`.

## Development

```bash
bun install        # or npm install
bun test           # self-contained assert-based tests
bun run typecheck  # tsc --noEmit
```

The extension is plain TypeScript loaded by pi's jiti runtime — no build step, the published package ships sources.

## License

[MIT](LICENSE)
