---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool (single mode, one step at a time) to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the scout's result

Run the steps in order, passing the previous step's output into the next call's task text. Do NOT implement - just return the plan.
