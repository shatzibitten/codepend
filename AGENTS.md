# AGENTS.md

## First-time user test

When asked to run Codepend from a repository link:

1. Follow the public user path from a clean temporary directory:

   ```sh
   npx codepend
   ```

2. Do not substitute the public package with `node bin/codepend.js` or another
   command from the local checkout unless the user explicitly asks to test the
   source code.

3. Confirm that Node.js 18 or newer is installed.

4. Report the version actually downloaded from npm:

   ```sh
   npx codepend --version
   ```

5. Verify that the generated page renders in a browser. If `file://` pages
   cannot be opened, use:

   ```sh
   npx codepend --serve
   ```

6. Keep the user's agent history local. Do not upload generated HTML, JSON,
   session data, or screenshots without explicit user approval.

7. Report these states separately:
   - version in the GitHub repository;
   - version published to npm;
   - terminal result;
   - rendered browser result.

## Development verification

Before committing a change, run:

```sh
npm run check
npm pack --dry-run
```

For a release, install the packed tarball into a clean temporary directory and
run the installed `codepend` binary. Do not treat source-only tests as proof that
the published CLI works. After publishing, verify the registry version and run
`npx codepend --version` from outside the repository with a fresh npm cache.

Do not commit, push, tag, publish, or deploy unless the user explicitly asks for
that external action.
