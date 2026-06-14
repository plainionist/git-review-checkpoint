# Git Review Checkpoint

A small VS Code extension for reviewing changes on the mainline branch since the last approved checkpoint.

## How it works

- Supported branches: `main` and `master`
- Approved marker ref: `refs/approved/<branch>`
- Pending commits: everything after the approved marker on the detected mainline branch

When no approved marker exists yet, the pane shows the latest commits on the detected branch and lets you approve a selected commit to create the marker.

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
