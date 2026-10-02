# R runner image

The sandboxed environment a researcher's uploaded `.R` script actually executes inside (Task
Configuration Phase 3, Google Forms task type's opt-in "R analysis" step). Full setup walkthrough
lives in [`docs/task-r-analysis-setup.md`](../../docs/task-r-analysis-setup.md) - this file is
just the quick reference.

## Build

From the `admin-dashboard-andrejkatin` repo root:

```
docker build -t task-r-runner docker/r-runner
```

The image tag `task-r-runner` is hardcoded in `server/analysis/runner.mjs` - don't rename it
without updating that constant too.

## Rebuild after changing the Dockerfile (e.g. adding a package)

Same command as above - `docker build` reuses cached layers, so adding one package to the
`install2.r` list is usually a fast rebuild, not a full reinstall.

```
docker build -t task-r-runner docker/r-runner
```

## Why no network access at run time

`server/analysis/runner.mjs` always runs the image with `--network none`. This means a script
can **never** `install.packages(...)` or reach the internet mid-run - every package it needs must
already be in this image. This is a deliberate security boundary (the script is researcher-
uploaded, effectively untrusted input), not an oversight. If a script needs a package that isn't
installed, add it to the Dockerfile's `install2.r` list and rebuild.

## Verifying the image works

```
docker run --rm task-r-runner Rscript -e 'library(ggplot2); library(psych); cat("OK\n")'
```

Should print `OK` with no errors. If it fails, the image didn't build correctly or a package
failed to install - check the `docker build` output for errors.
