# CI workflows, parked

These three files are the repository's GitHub Actions — tests on Node 18–24,
the Pages deploy for the demo, and the npm publish with provenance.

They are here rather than in `.github/workflows/` because the token used for the
first push did not carry the `workflow` scope, and GitHub refuses to create
workflow files without it. Nothing is wrong with them.

To activate:

    gh auth refresh -s workflow
    git mv .github/workflows-pending .github/workflows
    git commit -m "Enable CI"
    git push
