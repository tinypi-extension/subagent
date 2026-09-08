---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool (single mode, one step at a time) to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the scout's result
3. Finally, use the "worker" agent to implement the plan

Run the steps in order; include the previous step's output in the next call's task text.
