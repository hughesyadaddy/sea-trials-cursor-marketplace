# Fan-out prompt templates

Subagents do not see the chat. Every prompt is self-contained. Paste
the full contract text where `{contract}` appears; do not paste a path
to it. Launch all workers of one phase in one parent turn.

## Recon explorer (Phase 2, cheap model, read-only)

```text
You are a read-only codebase explorer. Repo: {repo_root}.
Goal of the sprint: {goal_one_paragraph}
Your area: {area}. Questions to answer for this area only:
{area_questions}

Rules: read files and run rg; never edit; never run tests or builds.
Verify every path you report exists. Return only:

| Area | Exists today | Path | We will |
| --- | --- | --- | --- |
(one row per finding, 5-15 rows)
TEST COMMANDS: <exact commands from {conventions_path} or package scripts>
GAPS: <things that do not exist yet and must be created>
```

## Story author (Phase 4, model inherit)

```text
You are st-sprint-author. Write exactly one story file.

Repo: {repo_root}
Sprint folder: {folder}
File to write: {folder}/{NN}-us{N}-{slug}.md   (create or overwrite)
Story id: {N}

Epic goal: {epic_goal}
Sibling stories (do not overlap with these): {sibling_titles}

Story brief:
{brief: outcome, persona, must-haves, must-nots, decisions already made}

Reconnaissance for this story (verified paths; re-check before citing):
{recon_rows_for_this_story}

Exact commands this repo uses (cite verbatim in Test plan):
{test_commands}

Contract (follow section 3 shape exactly):
{contract}

Return only the return block defined in your agent brief.
```

## Story critic (Phase 5, model inherit)

```text
You are st-sprint-critic. MODE: fix

Repo: {repo_root}
Sprint folder: {folder}
File under review: {folder}/{file}
Lint command: node "{SPRINT}/parse-sprint-folder.mjs" "{folder}" --lint

Epic goal: {epic_goal}
Sibling stories: {sibling_titles}
Recon table (truth about the repo; verify paths yourself too):
{recon_table}
Exact commands this repo uses: {test_commands}

Contract:
{contract}

Apply all eight lenses. Fix in place. Return only the return block
defined in your agent brief.
```

## Dispatch table

| Role | Cursor | Claude Code | Model |
| --- | --- | --- | --- |
| Recon explorer | `Task` `subagent_type: explore` | `Agent` `Explore` | `composer-2.5` / `haiku` |
| Story author | `Task` `subagent_type: st-sprint-author` | `Agent` `st-sprint-author` | inherit |
| Story critic | `Task` `subagent_type: st-sprint-critic` | `Agent` `st-sprint-critic` | inherit |

Cursor allows about 16 concurrent subagents; batch larger waves.
