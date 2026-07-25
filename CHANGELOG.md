## [0.3.1](https://github.com/pmatos/pewpew/compare/v0.3.0...v0.3.1) (2026-07-25)


### Bug Fixes

* **sessions:** reject mixed-tool duplicates on a remote worktree ([7ee686f](https://github.com/pmatos/pewpew/commit/7ee686f8d4830d076d24edcaed38f426065f81f5)), closes [#223](https://github.com/pmatos/pewpew/issues/223)

# [0.3.0](https://github.com/pmatos/pewpew/compare/v0.2.2...v0.3.0) (2026-07-23)


### Bug Fixes

* add aria-label to the repository picker select ([e3741c4](https://github.com/pmatos/pewpew/commit/e3741c4b155cf909211f0e2891c6c08042724b5a))
* bump mutationCount on no-op reduceAnimations broadcasts ([#185](https://github.com/pmatos/pewpew/issues/185)) ([6d5a609](https://github.com/pmatos/pewpew/commit/6d5a609030cf9d59a885464e1dae13a3348187a0))
* drop duplicate PR-helper imports in session-manager ([b7559f8](https://github.com/pmatos/pewpew/commit/b7559f8018cfef02b2aa12c8f3ad0106bb7ab0f8))
* format .releaserc.json with prettier ([4d20c19](https://github.com/pmatos/pewpew/commit/4d20c199d2304810fc6fb61702df69dd509f2559))
* freeze idle animations to stop high GPU/power draw ([#185](https://github.com/pmatos/pewpew/issues/185)) ([545dd45](https://github.com/pmatos/pewpew/commit/545dd456f009613a514b7c4288cd9aac01740bc1))
* group status bar toggles at the right edge ([79b5134](https://github.com/pmatos/pewpew/commit/79b5134cf26c52fe32855ed47a4b793a9a8094af))
* **main:** recover from renderer crashes instead of spamming disposed-frame errors ([a8dc8f8](https://github.com/pmatos/pewpew/commit/a8dc8f860c7bbac2ec4d0116cb45527243436d70))
* preserve terminal status across the remote reattach await ([d478ff7](https://github.com/pmatos/pewpew/commit/d478ff7ea4bcef3bb9e1d05965fc50d4a12aab22)), closes [#202](https://github.com/pmatos/pewpew/issues/202)
* regenerate lockfile with npm 12 to preserve libc metadata ([917a3a9](https://github.com/pmatos/pewpew/commit/917a3a9c86113a150787dea22ee0f1bac8739501))
* repair ESLint under TypeScript 7 via side-by-side TS6 install ([516e26e](https://github.com/pmatos/pewpew/commit/516e26e201ad4ba5ccde9d86cab88aeb44b1703c)), closes [#192](https://github.com/pmatos/pewpew/issues/192) [#198](https://github.com/pmatos/pewpew/issues/198)
* revert accidental prettier 3.8.3 reformatting ([2f11490](https://github.com/pmatos/pewpew/commit/2f11490975f861615ac1b41daebbeb745aafd638))
* satisfy prettier and eslint for commitlint.config.cjs ([dd1eb10](https://github.com/pmatos/pewpew/commit/dd1eb105f187d9fd77cbcadfcdd92cdb3f135ed2))
* **sessions:** batch probe must not clobber a Keep landing mid-probe ([bbd21e6](https://github.com/pmatos/pewpew/commit/bbd21e6b41bee8f8aa93816c1415dcfcbff6d2ef))
* **sessions:** batch prober skips terminal sessions (preserve Keep across restart) ([bf2b6f1](https://github.com/pmatos/pewpew/commit/bf2b6f1c82ce286f3fdac4e693e2dfdd72d15c61))
* **sessions:** don't auto-reconnect normally-ended remote sessions ([cffe335](https://github.com/pmatos/pewpew/commit/cffe335ab38c794d5656eb060811c21065665981))
* **sessions:** don't clobber a Keep made during an in-flight reconnect probe ([e17a8ae](https://github.com/pmatos/pewpew/commit/e17a8ae8eaf0b0af2e922144dc526b215c45fab9))
* **sessions:** don't re-prompt cleanup for an already-decided session ([ec1587b](https://github.com/pmatos/pewpew/commit/ec1587b2a3b0249cff2adfc7acee696a80fd92c3))
* **sessions:** fall back to a toast if the cleanup dialog fails ([6c943c6](https://github.com/pmatos/pewpew/commit/6c943c6d6fa66e8b4b44690de07f37e2f7abd336))
* **sessions:** guard reconnect entry point against terminal sessions ([5376e01](https://github.com/pmatos/pewpew/commit/5376e013501e308e15147a44de6283767197de38))
* **sessions:** normalize connectionState when keeping a completed remote session ([0ea2aa2](https://github.com/pmatos/pewpew/commit/0ea2aa202ae46789ee9dd4d0423bff2ae86d3f9f))
* **sessions:** preserve reconnect re-arm across in-flight attempts ([c5a96d0](https://github.com/pmatos/pewpew/commit/c5a96d0d30249ef5c869c0ee98d0fa18cbcd2990))
* **sessions:** prompt worktree cleanup when a remote session ends ([622b07a](https://github.com/pmatos/pewpew/commit/622b07a86dfa8ca4f9bc761398bf2c74a45a7972))
* **sessions:** report Delete failures accurately, refresh guard comments ([c25d29b](https://github.com/pmatos/pewpew/commit/c25d29b7fe0dd95a756612bb63c5c03f22a3500f))
* **sessions:** restore finished remote sessions as live, not pending ([7f22868](https://github.com/pmatos/pewpew/commit/7f228685281912f58593f55c272c93ad6aa2c0a6))
* surface the real git error when an upstream PR fetch fails ([51376a3](https://github.com/pmatos/pewpew/commit/51376a3f5936e481630d3176ad8a196b43da2f19))


### Features

* choose PR/issue repo (fork upstream) in session dialogs ([3d961ac](https://github.com/pmatos/pewpew/commit/3d961ac8bc099a18a1edb82484af4b59ab673555))
* **sessions:** auto-reconnect dropped remote sessions ([f140f68](https://github.com/pmatos/pewpew/commit/f140f68ace224abf29d6a42b08ca0d8915ebc486))
