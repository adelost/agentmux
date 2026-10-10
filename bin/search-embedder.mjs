#!/usr/bin/env node
// Background process behind `amux search`: keeps the embedding model and the
// semantic index loaded, answers on a per-user Unix socket, exits when idle.
// Started on demand by core/search-embedder.mjs; never needed for lexical search.

import { serveEmbedder } from "../core/search-embedder.mjs";

process.umask(0o077);
serveEmbedder().catch((error) => {
  console.error(`search-embedder: ${error.message}`);
  process.exit(1);
});
