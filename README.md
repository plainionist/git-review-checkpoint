# Git Review Checkpoint

A small VS Code extension for reviewing changes on a flat commit timeline since the last approved checkpoint.

## How it works

- Mainline detection for initialization: `main` and `master`
- Approved marker ref: `refs/approved/<branch>`
- Pending commits: commits newer than the approved marker in the global all-branches timeline (`git log --all --date-order`)

When no approved marker exists yet, the pane shows the latest commits across all branches and lets you approve a selected commit to create the marker.

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
