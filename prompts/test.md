---
description: Scout gathers context, planner creates implementation plan (no implementation)
---

Use the subagent tool single parameter to execute this workflow in order:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step 

Execute this as a sequence of single. Do NOT implement - just return the plan.