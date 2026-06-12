import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

function getLucideChunkName(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, "/");
  const iconMatch = normalizedId.match(/\/lucide\/dist\/esm\/icons\/([a-z0-9-]+)\.js$/);

  if (iconMatch) {
    const firstChar = iconMatch[1]?.[0] ?? "misc";

    if (firstChar <= "d") return "lucide-icons-a-d";
    if (firstChar <= "h") return "lucide-icons-e-h";
    if (firstChar <= "l") return "lucide-icons-i-l";
    if (firstChar <= "p") return "lucide-icons-m-p";
    if (firstChar <= "t") return "lucide-icons-q-t";
    return "lucide-icons-u-z";
  }

  if (normalizedId.includes("/lucide/")) {
    return "lucide-core";
  }

  return undefined;
}

function getVendorChunkName(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, "/");

  if (!normalizedId.includes("node_modules")) return undefined;

  const lucideChunkName = getLucideChunkName(normalizedId);
  if (lucideChunkName) return lucideChunkName;

  if (normalizedId.includes("@goblin-systems/goblin-design-system")) {
    return "design-system";
  }

  if (normalizedId.includes("@tauri-apps")) {
    return "tauri";
  }

  return "vendor";
}

export default defineConfig(async () => ({
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1422 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
      output: {
        manualChunks(id) {
          return getVendorChunkName(id);
        },
      },
    },
  },
}));
