## What & why

<!-- One paragraph: what changed and the user-visible reason. -->

## Agent changes

- [ ] Touched a system prompt
- [ ] Added or modified golden evals
- [ ] Added or modified injection cases
- [ ] Touched tool list or `agent.yaml`
- [ ] None of the above

## Quality gates

The pipeline will block merge until these pass — but flag here if you knowingly weakened a gate:

- [ ] Prompt review (Claude Opus rubric)
- [ ] Golden evals (≥ MIN_PASS_RATE, no regression)
- [ ] Prompt-injection red team (≤ MAX_BREACH_RATE)
- [ ] Cost / token budget (no regression > thresholds)
- [ ] Security: secret scan, OSV, CodeQL

## Risks / rollout

<!-- e.g. "Rolling out behind alias=staging first; promote after 24h soak." -->
