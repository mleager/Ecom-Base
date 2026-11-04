# Project 1 fixture source

Version 1's [catalog](catalog.v1.json) and [public SVGs](public/fixtures/v1) are nonsecret, repository-owned demonstration data. Product keys/UUIDs are stable; setup generates account identities/passwords separately in ignored `.cache/fixtures/`.

Use the [fixture guide](../docs/frontend/FIXTURES.md) for create/check/run/remove commands, baseline scenarios, image serving, credential handling and cleanup. The Go source embeds these assets for the explicit fixture command/tests; it is not an API startup seeder or an additional service. M7's Vite public directory points only to `fixtures/public`, not this catalog or private bundles.
