// Public asset re-exports. Anything that wants to write a compose file or
// .env stub into a fresh SUBWAVE_HOME imports from here, not from the
// auto-generated module — keeping the indirection lets us swap embedding
// strategies later (raw imports, Bun --embed, fetched from GHCR release
// assets) without touching every caller.

export { COMPOSE_YML, COMPOSE_BYO_YML, COMPOSE_DEV_YML, COMPOSE_TTS_HEAVY_GPU_YML, ENV_EXAMPLE, CLI_VERSION } from './assets.generated.ts';
