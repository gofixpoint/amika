// Re-exports TraceRoot SDK surface for application-level initialization.
// Call `TraceRoot.initialize()` in your application entry point (before
// importing any LLM libraries) to enable tracing. When TRACEROOT_API_KEY is
// absent, all spans degrade gracefully to no-ops.
export {
  TraceRoot,
  observe,
  usingAttributes,
  updateCurrentSpan,
  updateCurrentTrace,
} from "@traceroot-ai/traceroot";
