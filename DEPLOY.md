# GitHub Pages Deployment Instructions

These instructions are for a GitHub online agent. Goal: deploy
`long123king/TimeLens` to GitHub Pages at
**https://long123king.github.io/TimeLens/**.

The repository has just been refactored so that the live demo is the same
single-page app the user builds locally (`npm run build`), bundled with a
storyline archive that the app auto-loads on first visit to enter replay mode.
There is no longer a separate `demo/` sub-project or `MockBackend`.

---

## 1. Prerequisites

The repo state you should see after the user syncs:

- `public/storyline-1783342659893.storyline.json` exists (~25 MB, committed)
- `.github/workflows/deploy-pages.yml` exists (new; replaces the old
  `deploy-demo.yml` which is **gone**)
- `demo/`, `vite/`, `.github/workflows/deploy-demo.yml` are **deleted** from
  history in the new commit
- `index.html` no longer contains a `?demo=1` branch
- `src/main.js` calls `tryLoadBundledStoryline()` on boot

You can verify any of these with the GitHub MCP / API:

```
get_file_contents: index.html
get_file_contents: src/main.js
get_file_contents: .github/workflows/deploy-pages.yml
get_file_contents: public/storyline-1783342659893.storyline.json   # ~25 MB
list_directory: public
list_directory: .github/workflows
search_code: "/demo/src/main.js"   # should return zero matches in index.html
```

If `demo/` or `vite/` still appear in the repo, **stop and ask the user**
— the deploy workflow assumes they are gone.

---

## 2. One-time GitHub Pages configuration

In the repo settings, GitHub Pages must be set to **Source = GitHub Actions**.

```
PUT /repos/long123king/TimeLens/pages
{
  "build_type": "workflow"
}
```

(Use the REST API endpoint `POST /repos/{owner}/{repo}/pages` with
`{ "build_type": "workflow" }` if PUT is not available, or open
`https://github.com/long123king/TimeLens/settings/pages` in a browser.)

A `github-pages` environment usually exists by default; if it doesn't, create
it (no special secrets or protection rules required).

---

## 3. Trigger the deploy

The `.github/workflows/deploy-pages.yml` workflow runs on every push to `main`
whose changes touch `src/**`, `public/**`, `index.html`, `vite.config.js`,
`package.json`, `package-lock.json`, or the workflow file itself. It also
supports manual dispatch.

After the user pushes the sync commit, the workflow should start
automatically. You can also trigger it manually:

```
POST /repos/long123king/TimeLens/actions/workflows/deploy-pages.yml/dispatches
{
  "ref": "main"
}
```

---

## 4. Watch the run

Poll the workflow run until it finishes:

```
GET /repos/long123king/TimeLens/actions/runs?per_page=1
```

The deploy job will surface a `page_url` step output — that is the
public URL: `https://long123king.github.io/TimeLens/`.

### Expected outcomes

- **`build` job**: `npm ci` (or `npm install`) → `npm run build`. Vite emits
  `dist/` containing `index.html`, `assets/`, and the bundled
  `storyline-1783342659893.storyline.json`.
- **`deploy` job**: uploads `dist/` as the GitHub Pages artifact and
  publishes it. No errors.

### What to do if `npm install` warns about the storyline

The 25 MB JSON is plain text and is committed to git normally; **do not**
suggest Git LFS unless git push itself fails with a size error. LFS would
require every clone to install the LFS extension to fetch the demo data and
is not needed for this repo.

---

## 5. Smoke-test the live site

Fetch `https://long123king.github.io/TimeLens/` and confirm:

- HTTP 200 and `Content-Type: text/html`.
- `<script type="module" crossorigin src="/assets/index-*.js">` is present
  (Vite-built module).
- The asset `<script>` is reachable: `GET /TimeLens/assets/index-*.js` → 200.
- The storyline is reachable:
  `GET /TimeLens/storyline-1783342659893.storyline.json` → 200,
  `Content-Type: application/json`, body starts with `{"formatVersion":"2.0"`.

Tell the user: open `https://long123king.github.io/TimeLens/` in a browser.
The REPLAY bar should be visible at the bottom of the page, the counter should
read `1/19` (or similar), and stepping through with **Space / Shift+Space**
should advance / retreat through the recorded storyline steps.

---

## 6. Troubleshooting

### Workflow fails: "demo/dist does not exist" or "Cannot find module ..."

Old cached configuration is in play. Open `.github/workflows/deploy-pages.yml`
in the repo — the **only** workflow file under `.github/workflows/` should be
`deploy-pages.yml`. If `deploy-demo.yml` reappeared (e.g. from a different
branch), delete it on `main` and re-run.

### Build is slow / OOM

The 25 MB storyline is included in the artifact. This is expected. If the
runner runs out of memory during `npm run build` (it shouldn't — the file
isn't parsed at build time, just copied from `public/` to `dist/`), bump the
runner to a larger image or split the storyline out, but that is a code
change and requires the user, not a deployment tweak.

### Site loads but no REPLAY bar

- Open the browser console. `[main] Loaded bundled storyline: 19 steps, ...`
  should print. If `[main] Bundled storyline not present (HTTP 404)` prints,
  the file isn't being served. Check the deploy artifact contents: `GET`
  `https://long123king.github.io/TimeLens/storyline-1783342659893.storyline.json`.
- If HTTP 200 but the JSON fails to parse (e.g. truncated by a CDN), re-deploy.
- If the user is hitting the URL with `?demo=1` from an old link, note that
  the param is ignored now — just remove it.

### Old cached page

Visitors who saw the previous `demo/`-based build may have stale assets.
The new deploy replaces them, but advise a hard refresh (`Cmd+Shift+R` /
`Ctrl+Shift+R`) on first visit.

---

## 7. Rollback

If the new deploy breaks the live site, the safest rollback is to revert the
most recent commit on `main` (the one that removes `demo/` etc.) and re-run
the workflow. The previous deploy artifact will be invalidated and the old
demo URL `?demo=1` will work again.

```
POST /repos/long123king/TimeLens/git/reverts
{
  "commit_id": "<bad-commit-sha>",
  "branch": "main"
}
```

This is only a stop-gap. The intended steady state is the current refactor.

---

## Summary checklist for the agent

- [ ] Confirm `demo/`, `vite/`, `.github/workflows/deploy-demo.yml` are
      absent from the `main` branch tip.
- [ ] Confirm `public/storyline-1783342659893.storyline.json` and
      `.github/workflows/deploy-pages.yml` are present.
- [ ] Set Pages source to "GitHub Actions" if not already.
- [ ] Trigger the `Deploy Pages` workflow (push or dispatch).
- [ ] Wait for the `deploy` job to finish and report the `page_url`.
- [ ] Smoke-test the live URL: HTML loads, asset loads, storyline loads.
- [ ] Tell the user the site is live at
      `https://long123king.github.io/TimeLens/`.