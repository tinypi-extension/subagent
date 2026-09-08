---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool (single mode, one step at a time) to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation
3. Finally, use the "worker" agent to apply the feedback from the review

Run the steps in order; include the previous step's output in the next call's task text.
