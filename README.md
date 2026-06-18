# Scribe Goblin

Local-first second brain — clipboard capture, semantic search, embeddings, and
local AI enrichment. Built with Tauri 2 (Rust) + a vanilla TypeScript/Vite
frontend.

## Prerequisites

- **[Bun](https://bun.sh)** — package manager / script runner (this is a member
  of the `goblin-systems` Bun workspace).
- **Rust** (stable, MSVC toolchain on Windows) — https://rustup.rs
- **Tauri 2 system dependencies** — see https://tauri.app/start/prerequisites/
  (on Windows: Microsoft Visual Studio C++ Build Tools + WebView2).

Install JS dependencies:

```bash
bun install
```

## Running & building

| Command | What it does |
| --- | --- |
| `bun run tauri:dev` | Run the app in dev mode (default engine, CPU). |
| `bun run tauri:build` | Build the NSIS installer (default engine, CPU). |
| `bun test` | Run the frontend test suite (vitest). |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust tests. |

The default build is **CPU-only** and uses the **mistral.rs** (candle) engine for
local LLM work. It needs no extra SDKs.

## GPU acceleration (llama.cpp)

llama.cpp is an **optional, opt-in** second inference engine that adds GPU
acceleration for the local LLM (used by AI enrichment tags/summaries and search
autocomplete). It is selected at runtime in **Settings → Inference** once built
in. GPU backends are chosen at **compile time** via cargo features:

| Feature / script | GPU support | Notes |
| --- | --- | --- |
| `llamacpp-vulkan` | **AMD + NVIDIA + Intel** | Cross-vendor; the path for AMD on Windows. |
| `llamacpp-cuda` | NVIDIA only | Needs the CUDA Toolkit at build time. |
| `llamacpp-rocm` | AMD (Linux) | ROCm/HIP; not viable on Windows — use Vulkan. |
| `llamacpp` | none (CPU) | llama.cpp as an alternate CPU engine. |

Dev/build scripts: `bun run tauri:dev:vulkan`, `tauri:build:vulkan` (and the
`:cuda` / `:rocm` variants).

### Build dependencies for the Vulkan (recommended GPU) build

llama.cpp is compiled from source via CMake, so the GPU build needs:

1. **Vulkan SDK** — https://vulkan.lunarg.com/sdk/home#windows
   The installer sets the `VULKAN_SDK` environment variable. Open a **fresh
   terminal** afterwards so it is picked up.
2. **Ninja** (one-time):
   ```bash
   winget install Ninja-build.Ninja      # or: choco install ninja
   ```
   On Windows the build **must** use the Ninja CMake generator — the default
   Visual Studio/MSBuild generator fails building llama.cpp's `vulkan-shaders-gen`
   helper (`cannot find the batch label specified - VCEnd`). This repo already
   forces Ninja via `src-tauri/.cargo/config.toml` (`CMAKE_GENERATOR = "Ninja"`),
   so you only need Ninja on `PATH`.
3. A C/C++ toolchain (the MSVC Build Tools you already need for Tauri). A
   dedicated VS developer prompt is **not** required — the build locates `cl.exe`
   automatically.

Then:

```bash
bun run tauri:dev:vulkan      # dev
bun run tauri:build:vulkan    # installer
```

If you see `Vulkan SDK ... NotPresent`, the shell didn't inherit `VULKAN_SDK` —
reopen the terminal.

> **AMD users:** use the **Vulkan** build. ROCm/HIP on Windows is not supported
> by this toolchain.

### CUDA (NVIDIA) build

Install the [CUDA Toolkit](https://developer.nvidia.com/cuda-downloads) + Ninja,
then `bun run tauri:dev:cuda` / `tauri:build:cuda`.

## Releases / CI

`.github/workflows/release.yml` builds two Windows installers on tag pushes
(`v*`) or manual dispatch:

- **standard** — CPU / mistral.rs (the default download).
- **llamacpp-vulkan** — GPU build; the one AMD/NVIDIA/Intel GPU users should
  download.

## Local AI models

Models are downloaded from Hugging Face into the app data folder via
**Settings → Local AI Models** (not committed to the repo). Both engines load
GGUF models; mistral.rs additionally supports safetensors directories. llama.cpp
requires GGUF.
