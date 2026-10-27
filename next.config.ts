import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // Keep the team's checked-in instructions intact when starting the dev server.
  agentRules: false,
  // The floating dev indicator overlaps the mobile Chat tab.
  devIndicators: false,
  turbopack: {
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
};
export default nextConfig;
