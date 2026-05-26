import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom"],
            "vendor-supabase": ["@supabase/supabase-js"],
            "csv-stock":    ["./src/csvStockData.js"],
            "csv-bills":    ["./src/csvBillsData.js"],
            "csv-invoices": ["./src/csvInvoicesData.js"],
            "csv-buyers":   ["./src/csvBuyersData.js"],
            "pdfjs":        ["pdfjs-dist"],
            "xlsx":         ["xlsx"],
          },
        },
      },
    },
    optimizeDeps: {
      exclude: ["pdfjs-dist"],
    },
    server: {
      proxy: {
        "/api/claude": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          rewrite: () => "/v1/messages",
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("x-api-key", env.ANTHROPIC_KEY);
              proxyReq.setHeader("anthropic-version", "2023-06-01");
            });
          },
        },
      },
    },
  };
});
