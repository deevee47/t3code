# T3 Code with Hermes

This fork adds [Hermes Agent](https://hermes-agent.nousresearch.com) to T3 Code:

- **Hermes provider.** Hermes runs through `hermes acp`, like any other agent in T3: model picker
  (every model Hermes offers), approvals, stop, follow-ups, `/compact`, diffs and checkpoints.
- **Hermes workspace.** The switch in the sidebar header, or a two-finger swipe across the
  sidebar, flips between the T3 workspace (every other thread) and the Hermes workspace. The
  command palette has "Switch to Hermes workspace" too. New threads in the Hermes workspace
  start on Hermes.
- **Hermes history.** Sessions from the Hermes desktop app, CLI and cron jobs appear as
  threads you can continue. Sessions from a folder T3 knows land in that project; the rest land
  in a "Hermes" project at your home folder. Turn it off in Settings → Providers → Hermes.
- **`t3 thread`.** List, read, message, approve, stop and watch threads from a terminal, so
  Hermes can drive T3. The `t3-code` Hermes skill teaches Hermes these commands.

## Updating

```bash
t3-hermes update            # newest T3 Code release + the Hermes patch, built and installed
t3-hermes update --nightly  # follow upstream main instead
t3-hermes status
t3-hermes schedule on       # check every day at 10:00; installs when the app is closed
```

The app's own updater is turned off in this build, so it cannot replace Hermes with the official
build. If a release conflicts with the patch or fails to build, nothing is installed and the
current app keeps working. Resolve the conflict by rebasing the `hermes` branch onto the new
tag, then run `t3-hermes update` again.

The previous app is kept at `~/.t3-hermes-build/previous.app`. To go back to the official T3
Code, download it from https://t3.codes and replace the app in `/Applications`.
