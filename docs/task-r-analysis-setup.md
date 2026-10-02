# Task Configuration - R Analysis setup guide

This is the setup a researcher (or whoever runs the Admin Dashboard's API server locally) does
**once** to enable the Google Forms task type's opt-in "R analysis" step. Without this, the rest
of Task Configuration (Task Type picker, PR Review, file uploads, Google Forms link) works fine -
only the R analysis section needs Docker.

## Prerequisite: Docker Desktop

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) if it isn't already,
and make sure it's **running** (its whale icon shows in the system tray, not just installed) -
`docker` commands fail immediately otherwise. Confirm it's working:

```
docker version
```

If that prints both a Client and a Server section, Docker is ready. If `docker` isn't recognized
as a command at all, Docker Desktop's install may not have added itself to your terminal's PATH -
restart the terminal (or your machine) after installing, or open a fresh terminal window.

## Build the R runner image (once, and again after any Dockerfile change)

From the `admin-dashboard-andrejkatin` repo root:

```
docker build -t task-r-runner docker/r-runner
```

This takes a few minutes the first time (downloading the base R image + installing packages);
subsequent builds are fast thanks to Docker's layer cache, unless you changed the package list.

Verify it worked:

```
docker run --rm task-r-runner Rscript -e 'library(ggplot2); library(psych); cat("OK\n")'
```

Should print `OK`. If this fails, re-check the `docker build` output for errors before continuing
- the app's "Run analysis" button will fail every run until this works.

## What's actually available to a script

- **R packages**: base R + `ggplot2`, `dplyr`, `tidyr`, `readr`, `psych`, `jsonlite` (see
  `docker/r-runner/Dockerfile`'s `install2.r` line for the exact list). **No internet access at
  run time** - a script cannot `install.packages(...)` mid-run, so anything not on this list
  simply isn't available. Need another package? Add it to the Dockerfile and rebuild the image
  (see above) - this is a deliberate security boundary (the script is researcher-uploaded,
  effectively untrusted input reaching this server), not a temporary limitation to work around.
- **Input data**: every file the researcher uploaded under "Rezultati ankete"/"Survey results"
  on the Task Configuration page is available under `/data/<original filename>` inside the
  container, read-only.
- **Output convention**: the script should write any plots as PNG files into `/output/` (e.g.
  `/output/histogram.png`) and a plain-text results summary to `/output/results.txt`. Anything
  else written to `/output/` is ignored by the app (PNGs and `results.txt` are the only two
  things it reads back).
- **Resource limits**: 512MB memory, 1 CPU, and a 120-second wall-clock timeout - a run that
  exceeds either is killed and marked `TIMEOUT`/fails. This is generous for descriptive
  statistics on typical survey-sized data; a script that needs more is probably not a fit for
  this sandbox.

## Example script

A minimal script matching the convention above, for testing the whole pipeline end to end:

```r
data <- read.csv("/data/results.csv")

png("/output/summary_plot.png", width = 800, height = 600)
hist(data[[1]], main = "Distribution", xlab = names(data)[1])
dev.off()

sink("/output/results.txt")
cat("Descriptive statistics\n")
cat("=======================\n")
print(summary(data))
sink()
```

## Troubleshooting

- **"Run analysis" always fails immediately**: confirm `docker version` and the verification
  command above both work from the same machine/user account the Admin Dashboard's API server
  (`npm run serve:api`) runs under - a difference here (e.g. running the server as a different
  Windows user, or inside a restricted shell that can't see Docker) is the most common cause.
- **A script that needs network access** (e.g. downloading a package or a dataset) will never
  work here - `--network none` is intentional. Bake anything it needs into the Docker image
  instead, or pre-fetch the data and upload it as a regular task file.
- **Nothing shows up under "Rezultati"** after a `SUCCESS` run: the script didn't write to
  `/output/*.png` or `/output/results.txt` - check the script against the convention above.
