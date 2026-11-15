import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

function cepIifeHtmlPlugin(): Plugin {
  return {
    name: "kahamatic-cep-iife-html",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"\s*><\/script>/g, '<script defer src="$1"></script>')
        .replace(/<script\s+type="module"\s+src="([^"]+)"\s*><\/script>/g, '<script defer src="$1"></script>')
        .replace(/\s+crossorigin\b/g, "");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte(), cepIifeHtmlPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: "esbuild",
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "assets/style.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
