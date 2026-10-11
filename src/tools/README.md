# Analysis Tools

The tools in this directory provide deterministic repository analysis to the application and agents.

`impact-graph.ts` parses tracked TypeScript files and builds file-level import and re-export reachability for changed files. The application runs it before agent analysis and supplies its bounded result as evidence.

This analyzer is application-invoked; it is not currently a tool the model can choose to call. Add model-callable tools here only when their inputs, permissions, and evidence flow into the final assessment are defined.
