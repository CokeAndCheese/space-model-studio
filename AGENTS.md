# Space Model Studio guardrails

- `*.sapmodel.json` is the editable source; GLB is an export artifact.
- The project Domain Model is the only source of truth. Three.js objects are projections.
- One semantic entity with one SID exports to exactly one mesh node.
- Confirmed human metadata always wins over imported, inferred, or default metadata.
- Metadata contract is `3.3-semantic`. WALL and SPACE do not require direction;
  direction remains required for directional opening/vertical-transport entities.
- One semantic entity/SID still exports to one mesh node, but multiple glTF nodes
  may share the same reusable `meshes[]` definition.
- `V0.4 GLB metadata import` is managed inside this workspace; keep its standalone port-8002 boundary and avoid coupling its inference logic into the Studio Domain Model.
- Never modify Space AI Platform or `src/ssp` from this project.
- Never overwrite imported originals. Use originals, workspaces, and outputs separately.
- A release export is successful only after the emitted GLB is parsed and validated again.

## Git and Pull Request Workflow

### Worktree and branch

- The user manually creates each worktree and its independent branch.
- Codex must use the current worktree and branch.
- Codex must not create, switch, remove, or clean up worktrees unless explicitly requested.
- New features should use a `feature/*` branch.
- Bug fixes should use a `fix/*` branch.
- Documentation-only changes should use a `docs/*` branch.
- Before making changes, Codex must inspect the current repository, current branch, `git status`, and worktree state.
- If the current branch is `main`, Codex must stop and ask the user to open the task in an independent worktree and branch.
- Never develop, commit, or push directly on `main`.
- Preserve unrelated user changes.
- Never discard, overwrite, stage, or commit unrelated user changes.

### Development and local validation

- Codex implements the requested change in the current worktree.
- Codex must run the relevant validation after development.
- A complete validation pass includes:

  - `npm run typecheck`
  - `npm test`
  - `npm run build`

- Run `npm run verify:release` when changes affect release exports or release artifacts.
- Codex must report validation failures truthfully.
- Codex must fix task-related validation failures before presenting the feature for acceptance.
- After validation, Codex must wait for the user to test and accept the feature locally.
- If the user is not satisfied, Codex must continue modifying and testing in the same worktree and branch.

### Upload authorization

- The explicit instruction `可以上传` authorizes Codex to:

  1. Inspect `git status` and the complete staged and unstaged diff.
  2. Confirm that only task-related changes are included.
  3. Commit the task-related changes.
  4. Push the current feature, fix, or documentation branch.
  5. Create or update the Pull Request.

- `可以上传` does not authorize merging into `main`.
- Without explicit upload authorization, Codex must not commit, push, or create a Pull Request.
- Before committing, Codex must inspect the proposed file list and complete diff.
- Never commit secrets, credentials, `.env` files, temporary files, unrelated changes, or unintended generated artifacts.
- Use a descriptive Conventional Commit message such as:

  - `feat: ...`
  - `fix: ...`
  - `refactor: ...`
  - `test: ...`
  - `docs: ...`

- Push only the current task branch.
- Never force-push or rewrite shared history.

### Pull Request

- Create the Pull Request from the current task branch into `main`.
- The Pull Request must include:

  - A summary of the changes.
  - Validation commands and results.
  - User acceptance steps.
  - Known risks or limitations.

- If a Pull Request already exists for the branch, update the existing Pull Request instead of creating a replacement.
- If the user is not satisfied, continue modifying the same branch and update the same Pull Request.
- Keep the Pull Request open until the user explicitly decides whether it may enter `main`.

### Pre-merge integration validation

- Before requesting merge authorization, Codex must fetch the latest `origin/main` and determine whether the current task branch contains it.
- If `origin/main` has advanced, merge `origin/main` into the current task branch. Do not rebase or force-push.
- Resolve any merge conflict only when it is safely within the current task scope; otherwise stop and ask the user for direction.
- After integrating the latest `origin/main`, run the complete validation pass and any task-specific validation again.
- Push the integration commit and resulting task branch only under the existing upload authorization. Update the existing Pull Request.
- Codex must then wait for the user to test and accept the integrated result in the local task worktree.
- Before the user decides, Codex must provide a merge-readiness report covering the Pull Request target, latest `origin/main` integration, validation and CI results, conflicts, unrelated changes, known risks, and whether Codex recommends merging.
- If the task branch or `origin/main` changes after this validation or after user acceptance, the merge-readiness result is stale. Repeat integration validation and obtain fresh user acceptance before merging.

### Merge authorization

- The explicit instruction `允许合并进 main` authorizes Codex to merge the current Pull Request revision.
- Local acceptance, `可以上传`, successful tests, silence, or general approval do not authorize merging.
- Before merging, Codex must confirm:

  - The Pull Request targets `main`.
  - The current task branch contains the latest `origin/main`.
  - Required local tests and GitHub checks pass.
  - No unresolved conflicts exist.
  - The user tested and accepted the integrated result.
  - The user approved the current Pull Request revision.

- If the Pull Request or `origin/main` changes after the user's approval, Codex must not merge and must request merge authorization again after repeating the required validation.
- Merge the Pull Request on GitHub first.
- Do not merge the task branch into local `main` first and then push it.
- GitHub `main` is the authoritative formal version.
- Local `main` is a synchronized working copy.

### Post-merge validation and cleanup

- After the Pull Request is merged on GitHub, update local `main` with:

  `git pull --ff-only origin main`

- Run the complete validation pass on the updated local `main`.
- Treat post-merge validation as verification, not as permission to modify `main` directly.
- If post-merge validation fails, do not repair, commit, or push directly to `main`.
- Use a GitHub revert for a severe regression, or create a new `fix/*` branch and Pull Request.
- Clean up the remote branch, local branch, and worktree only after validation succeeds and the user explicitly authorizes cleanup.
