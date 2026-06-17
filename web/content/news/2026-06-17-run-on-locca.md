---
title: Run your DJ and tagger on locca
date: 2026-06-17
category: Feature
author: The SUB/WAVE desk
excerpt: locca is now a first-class LLM provider. Point SUB/WAVE at a local llama.cpp server for the DJ, and a locca embedding server for the library tagger. No API keys, no cloud.
---

SUB/WAVE already ran on Ollama or any cloud model. Now it runs on locca too. locca is a small TUI around llama.cpp for local GGUF models, and SUB/WAVE treats it as a first-class provider for both the DJ and the library tagger. No hand-typed server URLs.

## What's new

Pick locca in admin and the DJ writes its links and picks its tracks on a local model. The library tagger can use it too, for the embeddings behind mood tagging.

## Run the locca servers

A chat model and an embedding model need two separate locca servers. One llama.cpp process can't do both.

Start the chat server:

```
locca serve qwen3
```

Start the embedding server (set a default embed model and `locca serve` brings it up for you):

```
locca embed nomic
```

Chat runs on port 8080, embeddings on 8090.

## Point SUB/WAVE at it

For the DJ, open admin, then Settings, then LLM provider. Choose locca, type the model id locca reports at `/v1/models`, and leave the base URL blank. It defaults to the chat server:

```
http://host.docker.internal:8080/v1
```

Hit Save LLM provider.

For the tagger, open Settings, then Library tagger, then Embedding server. Click Detect locca server to fill it in, or leave the provider following your LLM and the base URL blank. It defaults to the embedding server:

```
http://host.docker.internal:8090/v1
```

Click Test embeddings, then Start tagging.

## Why it helps

The whole station runs on your own hardware. The DJ thinks on a local model and the tagger embeds your library locally, so nothing leaves the box. Switch providers later from admin with no redeploy.
