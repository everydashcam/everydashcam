# Contributing to everydashcam

Thanks for helping make everydashcam better. You do not need to write code to
make a useful contribution:

- **Found a bug or have an idea?** Open a GitHub issue and tell me what you
  expected to happen.
- **Want to add a camera?** Start at
  [everydashcam.app/add-my-camera](https://everydashcam.app/add-my-camera) or open a
  camera-support issue. Reliable support needs a real recording from the
  camera.
- **Spotted an awkward translation?** Open an issue with the current wording
  and the replacement you suggest.
- **Found a security problem?** Please report it privately as described in
  [SECURITY.md](SECURITY.md).

## Development

Use the Node.js version in `.nvmrc`, then install the dependencies and start the
development server:

```sh
npm ci
npm run dev
```

A fresh clone runs without accounts, API keys or local configuration.

## Pull requests

Small, focused fixes are welcome as direct pull requests. Before starting a
larger feature, refactor or new dependency, open an issue so we can agree on
the direction first. This avoids asking you to rework a contribution that does
not fit the project's architecture.

Before opening a pull request:

- Run `npm run typecheck` and `npm run check:ci`.
- Add tests for behavior changes.
- Put UI text through i18n rather than adding literals to the code. English and
  Russian ship together; keep the other locale dictionaries in sync, using the
  existing `// TODO i18n:` convention when a community translation is not yet
  available.

Review is handled by one maintainer and may take a little time.

### Adding a recording format

A format can only be validated against a real recording. A description of the
format is useful context, but it cannot replace the sample itself. The narrow
exception for verified open-source implementations is documented in
[docs/gps-format-coverage.md](docs/gps-format-coverage.md).

The usual path is:

1. Open a camera-support issue and share a sample privately or publicly. Review
   can begin once the sample is available.
2. Include the extractor, tests and anonymized fixtures in the pull request.
   Coordinates are rounded to whole degrees and real footage is replaced.
   Follow the committed `scripts/anonymize-*.mjs` examples, or say in the pull
   request if you need help preparing the fixtures.
