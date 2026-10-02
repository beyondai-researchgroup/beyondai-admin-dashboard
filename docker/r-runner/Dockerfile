# Task Configuration Phase 3 — the sandboxed R execution image. A researcher's uploaded .R
# script runs inside a container built from this image, with --network none at run time (see
# server/analysis/runner.mjs), so every package a script might need MUST be baked in here at
# build time — there is no way to install a package mid-run. See ../README.md for the build
# command and the process for adding a package later.
#
# rocker/r-ver pins an exact R version (reproducible builds) and ships littler's install2.r
# helper for fast, parallel package installs from CRAN.
FROM rocker/r-ver:4.4.1

# Base packages every descriptive-statistics / plotting script is likely to need. psych is
# included deliberately — this whole platform already deals in psychometric survey data
# (REI-40, Big Five), so it's a natural fit for "descriptive statistics on survey results."
# Add a package here (and only here) if a script needs one that isn't listed — then rebuild the
# image, see ../README.md.
RUN install2.r --error --skipinstalled \
    ggplot2 \
    dplyr \
    tidyr \
    readr \
    psych \
    jsonlite

# Runs as a fixed non-root uid/gid — the runner spawns `docker run --user 1000:1000 ...`, and
# the mounted /data (read-only) and /output (read-write) directories need to already be usable
# by that uid. /data and /script.R are bind-mounted read-only by the runner; /output is
# bind-mounted read-write for the script's plots/results.txt.
RUN groupadd -g 1000 rrunner && useradd -u 1000 -g 1000 -m rrunner \
    && mkdir -p /data /output \
    && chown -R rrunner:rrunner /data /output

USER rrunner
WORKDIR /

# No ENTRYPOINT/CMD — the runner always invokes this image as
# `docker run ... task-r-runner Rscript /script.R`, so the command is supplied at run time.
