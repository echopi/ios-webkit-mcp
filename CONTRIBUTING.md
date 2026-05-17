# Contributing to ios-webkit-mcp

Thanks for your interest. This is a small open-source project maintained by a single author in personal time; PRs and issues are responded to on a best-effort basis.

## Developer Certificate of Origin (DCO)

All contributions must be made under the Apache-2.0 license and must be your own work (or work you have the right to submit under that license).

Every commit must be signed off using the `-s` / `--signoff` flag:

```bash
git commit -s -m "fix: tighten capability probe timeout"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer to the commit message, which constitutes your agreement to the [Developer Certificate of Origin v1.1](https://developercertificate.org/):

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have
>     the right to submit it under the open source license indicated in
>     the file; or
>
> (b) The contribution is based upon previous work that, to the best of
>     my knowledge, is covered under an appropriate open source license
>     and I have the right under that license to submit that work with
>     modifications, whether created in whole or in part by me, under
>     the same open source license (unless I am permitted to submit
>     under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person
>     who certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are
>     public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

PRs without a sign-off will be asked to amend before merge.

## Scope and triage

This project tracks the [`chrome-devtools/chrome-devtools-mcp`](https://github.com/chrome-devtools/chrome-devtools-mcp) tool surface on the Apple Web Inspector Protocol (WIP) side. Out-of-scope:

- Android WebView debugging — use upstream `chrome-devtools-mcp` directly.
- Desktop Safari WIP — should work but is not actively tested.
- Bug reports that are actually iOS WKWebView platform limitations already covered in [`README.md` § Known limitations](README.md#known-limitations).

For new tool requests, please reference the corresponding CDP method in the chrome-devtools-mcp upstream catalog, and confirm the WIP equivalent exists via [`npm run probe`](README.md) before filing.

## Test

```bash
npm test  # builds and runs the 41 node:test cases
```

If your change affects WIP-touching code paths (not just type/format), please add or update a unit test in `tests/`.

## License of contributions

By submitting a PR, you license your contribution under the [Apache License 2.0](LICENSE).
