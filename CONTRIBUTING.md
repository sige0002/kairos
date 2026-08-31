<!-- AUTO-GENERATED from CONTRIBUTING.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Contributing to kairos

Search existing issues before proposing a change, and agree on behavior changes or large design changes first.
Normal changes target `develop`. Write code, comments, identifiers, and commit messages in English.

1. Read `AGENTS.md` and the relevant canonical document under `docs/specs/ja/`.
2. Keep the change minimal and add a test that reproduces the failure first.
3. For Python run `make test-py` and `make lint`; for the frontend run `make test-fe`.
4. For UI or behavior changes, rebuild the images and run `make test-e2e`.
5. When changing a Japanese specification, regenerate its English mirror.

A PR must state its purpose, user impact, verification commands and results, untested areas, and compatibility
notes. Never commit MCAP files, `data/`, secrets, site-specific configuration, or confidential robot names.

The public API is alpha. A compatibility-breaking change is accepted only with migration instructions and
Release notes. Vendored source must include provenance, a pinned revision, a redistribution-compatible license,
and all required notices.
