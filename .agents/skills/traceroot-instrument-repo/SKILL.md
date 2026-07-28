# traceroot-instrument-repo

Add TraceRoot observability to existing codebases. Tracing is **additive** — it never changes business logic.

## Key constraints

- Only append tracing code; preserve existing functionality
- Handle one language/service per session
- Avoid duplicate initialization
- Ensure graceful degradation when `TRACEROOT_API_KEY` is absent
- Never embed secrets in source files
- Flush spans only in short-lived processes (scripts, serverless)

## Workflow

1. **Verify API credentials** exist in environment or `.env` (`TRACEROOT_API_KEY`; optionally `TRACEROOT_HOST_URL` for self-hosted)
2. **Scan the codebase** — identify runtime (Python vs TypeScript/Node.js), LLM providers/frameworks, existing observability, user/session context patterns
3. **Clarify scope** if multiple services exist
4. **Install and initialize** the SDK once at the entry point, before LLM imports
5. **Add manual spans** around agents, tools, and orchestration steps
6. **Test end-to-end** — confirm traces appear in the TraceRoot UI with proper nesting, model details, no sensitive data

## Supported runtimes

**TypeScript/Node.js** — package `@traceroot-ai/traceroot`

```typescript
import 'dotenv/config';
import { TraceRoot } from '@traceroot-ai/traceroot';

TraceRoot.initialize(); // reads TRACEROOT_API_KEY automatically

// Wrap agent entry points:
const result = await observe(async () => {
  return await runAgent(query);
}, { name: 'agent-run', type: 'agent', metadata: { userId } });

// Propagate user/session context across all nested spans:
await usingAttributes({ userId: 'u-1', sessionId: 's-1' }, async () => {
  await runAgent(query);
});

// Short-lived scripts: flush before exit
await TraceRoot.flush();
```

**Python** — package `traceroot`

```python
from dotenv import load_dotenv
load_dotenv()
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI, Integration.ANTHROPIC])

@observe(name="run-agent", type="agent")
def run_agent(query: str):
    ...

with using_attributes(user_id="u-1", session_id="s-1"):
    run_agent(query)

traceroot.flush()  # scripts/serverless only
```

## Span types

| type    | use for                                  |
|---------|------------------------------------------|
| `agent` | top-level agent entry point              |
| `tool`  | tool / function the agent calls          |
| `llm`   | direct LLM call (use for custom clients) |
| `span`  | any other meaningful step                |

## Instrumentation targets

Focus on:
- Request boundaries and agent entry points
- Tool calls and external API calls with meaningful input/output

Avoid:
- Low-level utilities and tight loops
- Trivial functions (pure transforms, accessors)
- Per-item spans in large batch operations

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing in the UI | `TRACEROOT_API_KEY` not loaded | Confirm env var is set; in Python init after `load_dotenv()`, in Node import dotenv first |
| Script runs, no trace | spans not flushed before exit | Call `traceroot.flush()` / `await TraceRoot.flush()` |
| LLM calls not captured | SDK initialized after LLM client | `initialize()` must run before LLM library is imported/instantiated |
| Spans sparse (LLM only) | tools/agents not wrapped | Wrap with `@observe` / `observe()` |
| Self-hosted: nothing | wrong backend URL | Set `TRACEROOT_HOST_URL` |
