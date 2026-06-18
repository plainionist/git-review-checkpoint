# Git Review Checkpoint

A small VS Code extension for reviewing changes on a flat mainline-visible commit timeline since the last approved checkpoint.

## How it works

- Mainline detection: `main` and `master`
- Approved marker ref: `refs/approved/<branch>`
- Pending commits: commits newer than the approved marker in the date-ordered timeline reachable from the detected mainline branch (`git log --date-order <mainline>`)

When no approved marker exists yet, the pane shows the latest commits reachable from the detected mainline branch and lets you approve a selected commit to create the marker.

## UI

- **Review Checkpoint** activity bar view with commit history
- Webview-based review diff with:
  - `inline`
  - `side-by-side`
  - `side-by-side (full)`

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the extension development host.
