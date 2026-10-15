import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/expert-map": [
      "./.github/CODEOWNERS",
      "./CODEOWNERS",
      "./docs/CODEOWNERS",
    ],
  },
};

export default withWorkflow(nextConfig);
