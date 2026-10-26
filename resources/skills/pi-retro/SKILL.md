---
name: pi-retro
description: "Conduct a retrospective on one or more coding sessions, using Pi Desktop's cost and time digest as evidence."
disable-model-invocation: true
---

The user has asked for a **retrospective**. You suggest improvements to the coding agent's **environment** so future runs cost less and finish sooner. You only propose; nothing changes until the user picks a candidate.

Adapted from the `retro` skill in [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see LICENSE). The difference: Pi Desktop hands you measured numbers, so every candidate must point at one.

## Steps

1. Read the **digest** in the user's message. It covers either one session with its subagents (the current chat, unless it says otherwise) or every session in a date range. Its numbers are measured from the session files: model cost, wall-clock time per tool call, test runs, and **carried cost** (what later calls paid to resend a tool result or skill while it stayed in the context).

2. Read the primary sources behind the strongest signals. For the current session, that is this conversation. Otherwise read the session files the digest lists (JSONL, one entry per line; `toolCall` blocks in assistant messages, `toolResult` messages after them). Read only the parts you need: search for the command, tool, or prompt the digest names.

3. Look for candidates in these categories. Each one must cite a number or a moment from the digest or the session. Drop any candidate you cannot trace.

- **Test and build loop**: did tests or builds take a large share of the time, run many times per session, or fail repeatedly? Look for: running the whole suite where one file or one test would do, missing watch mode, slow setup in every run, flaky tests, a build run only to check types. Read the repo's own scripts (`package.json`, Makefile, CI workflow) first and propose a faster command, a narrower default, or a navigation pointer to it. _Use when_ the digest shows test or build time, reruns, or failing commands.
- **Context cost**: did a tool's results get resent for a large share of the cost? Look for whole-file reads where a range would do, broad searches, verbose command output, large skills loaded for a small task, sessions that compacted again and again. Propose narrower tool use, output trimming (for example `| tail`), splitting a skill, or a subagent for the noisy part. _Use when_ carried cost or compactions stand out.
- **Navigation**: how easy was it for the agent to find the right files? Would a **navigation pointer** from a file it already reads help? _Use when_ the session spent many read and search calls before acting.
- **Automated checks**: could a lint rule, type, test, or hook have caught a mistake the agent made? Read the repo's existing check commands first; a check that exists but is not wired up is the finding. A repo with no guardrail at all (no pre-commit hook and no CI job running lint, typecheck, and tests) is a finding too. _Use when_ the agent made a mistake a check could have caught.
- **Coding standards**: should the reviewer get a new rule? A mechanical violation (a banned API, an import shape, a file location) gets a deterministic check, not prose. Keep `CODING_STANDARDS.md` for judgement calls. _Use when_ review missed a mistake.
- **Steering files**: is `AGENTS.md` large, or full of lines that change nothing? Move steering into checks or standards and delete no-ops. _Use when_ steering files are large.
- **Subagents and models**: did subagents or an expensive model do work a cheaper setup could do, or did delegation repeat work the main agent already had? _Use when_ the digest shows a high subagent share or one model dominating cost.
- **Information access**: did the agent lack something it needed, such as dev server logs or read-only access to a service? _Use when_ the session stalled on missing information.

4. Present the candidates in order of what they would save, most first. For each one, give the evidence (the number or moment), the proposed change, and a rough saving ("about 15 minutes per feature", "about a third of this session's cost"). Keep the list short: three strong candidates beat ten weak ones.

## Reference

- The implementing agent carries the most **context pressure**: it explores, writes, and debugs. The reviewer gets a diff. So standards belong with the reviewer, and `AGENTS.md` holds little more than navigation pointers, since it loads into every session.
- A check can fail; a sentence in a steering file cannot. Prefer checks.
- A retro does not store what happened. It changes the environment so the costly pattern does not happen again. After the user applies a fix, a later retro over the same range shows whether the number moved.
