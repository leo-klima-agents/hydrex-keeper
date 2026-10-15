# Plan: the relay dApp

A static page where holders of vote-escrowed positions on metaDEXes hand their votes and rewards to a relay, and take
them back. Hydrex calls these relays conduits; Aerodrome and Velodrome call them relays. Version 1 supports one:
Hydrex's "Carbon Impact" conduit, whose votes Klima's keeper casts. The same static build is served from GitHub Pages
(or a similar host), so that Safe{Wallet} can open it as a Safe App, and from IPFS through an ENS name on eth.limo. This
plan is for the agent that builds it. The facts below were checked on Base on 2026-10-15; check them again before
relying on them.

## Why it exists

- Hydrex's app no longer offers the conduit. On hydrex.fi/accounts, the automation picker shows only "No Automation",
  and an account already in a conduit sees "Automations ended. Please switch to No Automation." with a "Switch now"
  button that leaves it. The page never mentions this.
- On chain, the conduit is still open: the VotingEscrow keeps its approval config active, and it holds 897,042 votes.
- This page is therefore the only interface for joining it. It must be simple enough for a Hydrex user and small enough
  to audit, and other relays may be added later.

## Scope

**In:**

- Read-only view: what each relay does, its live numbers, this week's vote.
- Wallet view: the user's accounts, their status, and joining, leaving and setting the payout address.
- A read-only view of any address, for Safe signers and for research.
- Browser-extension and in-app wallets, and Coinbase Wallet with its smart wallet, through wagmi.
- Safes, with the page opened as a Safe App inside Safe{Wallet}.

**Out of v1:**

- Claiming, swapping and voting: the keeper's job.
- Locking HYDX: link to Hydrex instead.
- Payout history: not shown for now.
- Relays other than Carbon Impact.
- Anything that needs a server.

## Facts

### Contracts on Base (chain 8453)

| Name                                            | Address                                      |
| ----------------------------------------------- | -------------------------------------------- |
| VotingEscrow (veHYDX), EIP-1967 proxy           | `0x25B2ED7149fb8A05f6eF9407d9c8F878f59cd1e1` |
| Its implementation, `VotingEscrowV2Upgradeable` | `0x0FC68cE53Be957a1AA779f553AD49f6068fFf231` |
| Its approval logic, reached by `delegatecall`   | `0x4B0BC0889EB524Dbae36d409fF733851E9B4f63D` |
| `KlimaVeTokenConduit`, "Carbon Impact"          | `0xde91885cf35ac57df0c4a75c16862127dbe8317c` |
| Voter                                           | `0xc69E3eF39E3fFBcE2A1c570f8d3ADF76909ef17b` |
| kVCM                                            | `0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d` |
| AZUSD                                           | `0x3595ca37596D5895B70EFAB592ac315D5B9809B2` |
| Credit token                                    | `0x3bF21F28262eFfF8E2d30be3818e3B88539D7CCB` |
| `KlimaVeTokenConduitExecutor` (module)          | `0x750973E0CB728C3112561Bc8E9b235afA9B17E81` |

The VotingEscrow, its approval logic and the conduit are verified on Sourcify. The conduit's source is
`contracts/conduits/KlimaVeTokenConduit.sol` in
[hydrexfi/hydrex-periphery](https://github.com/hydrexfi/hydrex-periphery).

### Calls

- **Join:** `VotingEscrow.setConduitApproval(conduit, tokenId, true)`, selector `0x84dbc448`, one call per account. It
  runs the conduit's registered actions, `[3, 5]`: claim-redirect approval for that account, and delegation of its votes
  to the conduit.
- **Leave:** the same call with `false`. It clears the claim redirect and delegates the votes back to the owner.
- **Payout address:** `conduit.setMyPayoutRecipient(address)`. It is per owner, so it covers all of the owner's
  accounts, and `address(0)` resets it to the owner. Read it with `getEffectiveRecipientForOwner(owner)`. Hydrex's admin
  can override it with `adminSetPayoutRecipient`.
- **Accounts:** `balanceOf(owner)`, `tokenOfOwnerByIndex(owner, i)`, `ownerOf`, `lockDetails(id)` (amount, start, end,
  lock type: 0 timed, 1 rolling, 2 permanent), `balanceOfNFT(id)`, `getLockDelegatee(id)` and
  `getClaimRedirectApproved(id)` on the VotingEscrow.
- **Conduit:** `getConduitApprovalConfig(conduit)` on the VotingEscrow; `retireBps`, `treasuryFeeBps`,
  `totalTonnesRetired`, `totalKvcmRetired`, `distributionTokens(i)`, `retiringEntityName`, `beneficiaryString`,
  `retirementMessage`, `veToken` and `voter` on the conduit.
- **This week's vote:** `_epochTimestamp()`, `lastVoted(conduit)`, `poolVote(conduit, i)` until it reverts, and
  `votes(conduit, pool)` on the Voter; then `token0`, `token1` and `symbol` for the pool names.

Live values on 2026-10-15: `retireBps` 3333, `treasuryFeeBps` 0, distribution tokens kVCM and AZUSD,
`totalTonnesRetired` 5691402532019280852579 (check its decimals before showing it), and conduit approval actions
`[3, 5]` with `active` true. Read them live; never hard-code them in copy.

### Rules the contracts enforce

- Only the account's owner can join or leave (`Not token owner`). A Safe or smart wallet that owns the account must send
  the call itself.
- Joining fails if Hydrex deactivates the conduit's config (`Invalid conduit type`).
- Joining overwrites any other delegate and claim redirect, but not other approvals from another conduit, such as an
  ERC-721 approval. Leave the other conduit first. Leaving it afterwards would also undo Carbon Impact, because a leave
  delegates the votes back to the owner and clears the claim redirect.
- Hydrex controls the conduit's `EXECUTOR_ROLE` and admin settings: routers, distribution tokens, retirement share,
  treasury fee (at most 1%) and payout overrides.

### Timing and payouts

- Epochs flip on Thursday at 00:00 UTC. The keeper counts the conduit's votes as of the epoch start, so an account that
  joins counts from the next flip. Hydrex's app shows "Current payout" and "Next payout" for this reason.
- Claim-redirect approval takes effect at once. Verify, from the contracts, which epochs' rewards the conduit may then
  claim for a newly joined account, and say so on the page.
- `hydrex-keeper` votes every week and claims each account's rewards. Take when and how it claims from its README, and
  describe payouts only from that README and the conduit's live settings.

### Who uses it (snapshot of 2026-10-15)

Out of 123,925 veHYDX accounts, 21 delegate to the conduit, held by 14 owners:

- **Concentration:** one Safe (1.3.0) owns 5 of the accounts and 93% of the votes; with a second Safe, the two hold
  about 96.5%.
- **Wallet types:** 5 owners are plain EOAs and 5 are EOAs with EIP-7702 code. Three of those point to `0x63c0…E32B` (it
  looks like MetaMask's smart account) and two to `0x7702…176C` (it looks like Coinbase's 7702 proxy). Two owners are
  ERC-1967 minimal proxies with implementation `0x0000…534d`, which look like Coinbase Smart Wallet / Base Account.
  Identify all three implementations before relying on these guesses.
- **Accounts:** 13 rolling, 6 permanent and 2 timed. Five have zero voting power. Three owners hold several accounts, up
  to 5.

So Safes and smart wallets matter as much as browser extensions, joining several accounts at once matters, and expired
locks must be explained. Write `scripts/members.ts` to redo this snapshot. It reads `getLockDelegatee` for every account
through Multicall3 and classifies each owner by its code.

### What Hydrex's app shows

- **Stack:** a closed-source Next.js app on Vercel. Its bundles show how it works but have no licence: learn from them,
  copy nothing, code or artwork.
- **Words:** "Protocol Account" (permanent lock), "Flex Account" (rolling or timed), "Earning Power", "Automation",
  "Automate", and "Current payout" / "Next payout". The conduit card was named "Carbon Impact", with a teal "Carbon
  impact" badge: "Part of the value from this automation supports Klima Protocol's voluntary carbon offset program."
- **Its API:** `api.hydrex.fi/conduits` lists 14 conduits, including
  `{"id": "klima", "name": "Carbon Impact", "maxVotePools": 3}`, with an output split of 60% kVCM and 40% AZUSD. It
  sends `Access-Control-Allow-Origin: *` but is undocumented, so the page must not depend on it. Earning Power is about
  1.3 times voting power there; find out where that factor comes from before showing either number.

### Wallet connectors, measured

`@wagmi/connectors` 8.2.0 offers `injected` (with EIP-6963 discovery), `baseAccount`, `coinbaseWallet`, `metaMask`,
`walletConnect` and `safe`. It also has `tempoWallet`, which serves the Tempo chain rather than Base, and `mock`, which
is for tests.

Each connector loads its wallet SDK with a dynamic import, and `@wagmi/core` itself depends only on `eventemitter3`,
`mipd` and `zustand`. A test build split by esbuild, with each connector imported from its own entry point, measured
this against `injected` alone. That baseline is 69 KB gzipped on first load, and 21 installed packages for viem, wagmi
core and the connectors package:

| Connector        | Installed packages it adds | First load | Loaded when chosen |
| ---------------- | -------------------------- | ---------- | ------------------ |
| `coinbaseWallet` | 3                          | +2 KB      | 34 KB              |
| `safe`           | 4                          | +3 KB      | 177 KB             |
| `metaMask`       | 78                         | +2 KB      | 218 KB             |
| `baseAccount`    | 93                         | +146 KB    | 86 KB              |
| `walletConnect`  | 178                        | +60 KB     | 465 KB             |

With all six, the build installs 360 packages and the first load is 232 KB. `baseAccount` and `walletConnect` grow the
first load because esbuild splits by file: viem files that both the page and the SDK use move into the first load.
`baseAccount` depends on `@coinbase/cdp-sdk`. `coinbaseWallet` uses `@coinbase/wallet-sdk`, which also reaches Coinbase
Smart Wallet / Base Account through keys.coinbase.com; confirm that with a real Base Account.

Version 1 uses `injected`, `coinbaseWallet` and `safe`. That build installs 28 packages, and its first load is 73 KB;
Safe's SDK loads only when the page runs inside Safe{Wallet}. The others are left out: `metaMask` because `injected`
already finds MetaMask's extension, `baseAccount` because `coinbaseWallet` reaches the same smart wallets, and
`walletConnect` for its weight.

### Safe{Wallet}, eth.limo and GitHub Pages

- **How Safe Apps load:** Safe{Wallet} fetches the app's `manifest.json` with a plain GET, then shows the app in an
  iframe.
- **What eth.limo sends:** `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` on every
  response. Its `Access-Control-Allow-Origin: *` would let Safe read the manifest, but the browser refuses to show the
  page in Safe's frame.
- **Tested on 2026-10-15 in Chromium:** Safe{Wallet}, opened for the large Safe with CoW Swap's eth.limo page as a
  custom app, logged
  `Refused to frame 'https://cowswap.eth.limo/' because an ancestor violates the following Content Security Policy directive: "frame-ancestors 'self'"`.
  Safe's own Transaction Builder loaded in the same set-up.
- **Other gateways:** 4everland and inbrowser.link send the same `X-Frame-Options`. The ipfs.io / dweb.link gateway now
  answers with a notice that it is switching to a service-worker gateway only.
- **GitHub Pages:** sends `Access-Control-Allow-Origin: *` and no framing headers. In the same test, a live GitHub Pages
  site (`pages-themes.github.io/minimal`) loaded inside Safe{Wallet}'s frame. pages.github.com did not, apparently
  because of that page's own scripts, so test this page in Safe{Wallet} early.
- **So:** the page runs as a Safe App from GitHub Pages or a similar host, and from eth.limo only as a normal page.
- **Clickjacking:** eth.limo's headers stop other sites from framing the page; GitHub Pages lets any site frame it. See
  [Content Security Policy](#content-security-policy).

## Principles

Copy hydrex-keeper's way of working:

- **Small surface.**
  - **Runtime packages:** `viem`, `@wagmi/core`, `@wagmi/connectors`, `@coinbase/wallet-sdk`,
    `@safe-global/safe-apps-sdk` and `@safe-global/safe-apps-provider`, each pinned to an exact version. No UI
    framework, CSS framework, analytics, trackers, external fonts, CDNs or remote images.
  - **Loading:** Coinbase's SDK loads only when someone picks Coinbase Wallet, and Safe's only inside Safe{Wallet}, so a
    bad SDK release reaches only its own users.
  - **Network:** at run time the page talks only to the listed RPCs, the user's wallet, and the services that wallet's
    SDK needs.
- **Reproducible.** The same commit gives the same `dist/` and the same CID on any machine. CI proves it.
- **Plain code.** Small functions, no classes, strict TypeScript (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), and `.ts` imports that Node runs directly.
- **Comments.** None where the code says it. A one-line doc comment on an export only when its name does not say what it
  returns. A short "why" comment for a constraint the code cannot show, such as "A leave also undoes the delegation, so
  leave the other conduit first."
- **Plain words.** Short sentences in the README, the page and the commit messages. Name things the way users do.
- **Checked like the keeper.**
  - **Tooling:** Prettier with `printWidth: 120` and `proseWrap: "always"`, `tsc`, and `node --test`.
  - **Licensing:** REUSE (MIT, same annotations as hydrex-keeper).
  - **CI and updates:** GitHub Actions pinned by commit SHA with the version in a comment,
    `permissions: contents: read`, and Dependabot weekly for Actions and npm.
- **Install without scripts.** Use `npm ci --ignore-scripts` everywhere, and commit `package-lock.json`.
- **Review every dependency change.** A pull request that changes the lockfile shows the dependency tree and chunk sizes
  before and after, and a human reads the diff of any wallet SDK that changed.

## Stack

- **Language:** TypeScript checked by `tsc`, bundled for the browser by `esbuild` (one pinned binary, deterministic
  output) with `format: "esm"` and `splitting: true`, so the Coinbase and Safe SDKs become their own chunks. No Vite.
- **Wallets:** `@wagmi/core`.
  - **Connectors:** `createConfig` with `injected`, `coinbaseWallet` and `safe`. The `safe` connector works only inside
    Safe{Wallet}'s frame; connect it automatically there.
  - **Discovery and reconnect:** EIP-6963 discovery stays on (`multiInjectedProviderDiscovery`). wagmi's storage in
    `localStorage` and `reconnect` restore the last wallet.
  - **Telemetry:** turn off every SDK's analytics or telemetry option, and let the CSP block what remains unless the
    wallet breaks without it.
  - **No TanStack Query:** don't install `@tanstack/query-core`; wagmi's plain actions are enough.
- **Chain:** chains and transports come from the relay registry. Each chain gets viem's `fallback` over its public RPCs.
  Use wagmi's actions: `readContracts`, `simulateContract`, `writeContract`, `getCapabilities`, `sendCalls`,
  `waitForCallsStatus`, `waitForTransactionReceipt` and `switchChain`.
- **Rendering:** one `render(state)` that rebuilds the page from state with a small `h(tag, props, ...children)` helper.
  Text goes in through `textContent` only, never `innerHTML`, because token symbols and names come from the chain.
- **Styling:** one CSS file with custom properties, light and dark through `prefers-color-scheme`, the system font
  stack, and inline SVG icons.
- **Routing:** none. `#0x…` opens the read-only view of an address. The hash never reaches the gateway.
- **Budget:**
  - **Limits:** CI fails if the first load passes 90 KB gzipped (73 KB measured), or the CSS 10 KB. It prints every
    chunk's size.
  - **Imports:** import `injected` from `@wagmi/core`, and `coinbaseWallet` and `safe` from their own entry points, such
    as `@wagmi/connectors/safe`. Never import the `@wagmi/connectors` barrel: it puts every SDK in the build, whether
    used or not.
  - **Duplicates:** dedupe shared packages; today `ox` ships in more than one version.

## Built for more relays

Other metaDEX relays and conduits may come later. Make room for them without building them:

- **Registry:** `relays.json` lists the supported relays. Each entry has its chain, protocol, kind, name, contract
  addresses and pinned code hashes. Version 1 has one entry. Like `tokens.json` in hydrex-keeper, it changes only by
  pull request.
- **Kinds:** everything kind-specific lives in one file per kind. Version 1 has `hydrex-conduit` only: reads, status,
  calls and startup checks. Adding a relay of a known kind is a registry entry; adding a kind is a new file.
- **Shared code:** the account list, statuses, call ordering, batching, simulation and rendering work from what a kind
  returns, and never call a Hydrex contract directly.
- **Read the others first:** before designing the shared types and screens, read how Aerodrome's and Velodrome's relays
  work. As far as we know they use managed veNFTs, through `Voter.depositManaged` and `withdrawManaged`, with their own
  timing rules. Don't bake in Hydrex's model, such as a claim redirect, a per-owner payout address or one relay per
  account. Build nothing for them yet.
- **Words:** on screen, use each protocol's own words: "conduit" or "automation" on Hydrex, "relay" on Aerodrome. In the
  code and the README, "relay" is the generic word.

## Repository

A new repository next to hydrex-keeper. The working name is `metadex-relays`, generic on purpose; confirm it with the
user.

```
index.html             CSP meta tag, root element, one script and one stylesheet
manifest.json          Safe App manifest: name, description, icon
icon.svg               the icon it points to
src/
  abi.ts               parseAbi fragments
  config.ts            wagmi config: chains, transports, connectors
  relays.ts            loads relays.json; startup checks
  kinds/
    hydrex-conduit.ts  reads, status, calls and checks for Hydrex conduits
  status.ts            shared account statuses (pure)
  write.ts             call ordering, batching, simulation
  format.ts            numbers, dates, addresses (pure)
  view.ts              render and h()
  main.ts              state and wiring
style.css
relays.json            supported relays, reviewed by pull request
hydrex-conduits.json   names of Hydrex's other conduits by address, for labels
scripts/               build.ts, budget.ts, members.ts
test/                  unit tests for pure modules; e2e/ for fork tests
docs/research.md       research findings, in words
```

## The page

### What it shows

The page lists relays. Version 1 lists one, Carbon Impact; design for several anyway.

1. **Top:** the product's name and one sentence on what a relay does.
2. **Relay card:** for each relay:
   - **What it does:** one sentence.
   - **Live numbers:** tonnes retired, the share of kVCM retired, the payout tokens, the relay's votes, and the time to
     the next flip in local time and UTC.
   - **This week's vote:** the pools, by token symbols, with their shares, and when the keeper last voted.
3. **Your accounts:** one row per account, showing its protocol, its type in that protocol's words, its voting power,
   when its lock ends, and a status:
   - In Carbon Impact.
   - Joined, counts from Thursday \<date\>.
   - In another automation, named from `hydrex-conduits.json`, or "delegated to 0x…".
   - Not automated.
   - Lock ended, with no power and a link to extend it on Hydrex.
4. **Payout address:** the effective recipient for the owner, and a field to change it.
5. **What joining allows,** in plain words, from live values:
   - The conduit can claim this account's rewards, swap them through the routers Hydrex approved, retire this share of
     the kVCM as carbon credits in this name, and send the rest to the payout address.
   - Klima's keeper chooses the votes and claims the rewards. Say when, from hydrex-keeper's README.
   - Hydrex can change these settings.
   - Leaving is one transaction, at any time.
   - Link each contract to Basescan and each repository to GitHub.
6. **Footer:** the version, commit and CID; how to check them; links to the repositories.

The page never mentions that Hydrex's automations ended, and shows no payout history.

### States to design

- **Wallet:** none, several, Coinbase's SDK failing to load, the wrong network, and the page opened inside Safe{Wallet}.
- **Accounts:** none (link to Hydrex), and every account status above.
- **Transactions:** pending, success, rejected, and reverted (in plain words).
- **Problems:** an unreachable RPC, and a failed startup check.
- **Viewing:** a read-only address.

### Writes

- **Join selected:** for each selected account in another automation, first a leave of that conduit, then a join.
- **Batching:** if `getCapabilities` reports atomic batching on the relay's chain, send everything as one `sendCalls`
  with one confirmation. Otherwise send one transaction after another, with progress, in the safe order.
- **Simulate first:** simulate every call from the owner before asking the wallet. Show the revert reason in plain
  words, and send nothing that fails.
- **Safe:** inside Safe{Wallet}, the `safe` connector proposes the calls. If Safe reports atomic `sendCalls` support,
  they go as one Safe transaction; otherwise as one Safe transaction each, in the safe order. Safe returns a Safe
  transaction hash, not a transaction hash: show the proposal as waiting for the other signers, and re-read once it
  executes.
- **After sending:** wait for the receipt or the calls status, then re-read and re-render. Never trust an optimistic
  state.

### Safety checks at startup

Before allowing a write to a relay, confirm all of these:

- The chain ID matches the registry.
- The conduit's `veToken` and `voter` match the registry.
- `getConduitApprovalConfig(conduit)` returns `[3, 5]` and active.
- The conduit's code hash matches the registry.

If any check fails, disable writes to that relay and say why.

### Content Security Policy

`index.html` carries a CSP meta tag:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src <RPC origins> <wallet SDK origins>; frame-src <wallet SDK origins>; base-uri 'none'; form-action 'none'
```

- **Wallet origins:** take each SDK's origins from its documentation, then confirm them in the browser. Every wallet
  must work, and the console must show no CSP violation the wallet needs. List each origin and its reason in the README.
- **Framing:** a meta tag cannot set `frame-ancestors`.
  - **eth.limo:** sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so no other site can frame the page
    there.
  - **Safe App host:** must let app.safe.global frame the page, and nothing else. Prefer a host that can send
    `Content-Security-Policy: frame-ancestors 'self' https://app.safe.global` from a headers file, such as Cloudflare
    Pages or Netlify. GitHub Pages sends no such header, so any site could frame the page there.
  - **Check in the page:** when framed, render only if `location.ancestorOrigins` (or `document.referrer` where that is
    missing) shows `https://app.safe.global`, and otherwise say why the page is blank. This backs up the header; it does
    not replace it.
- **Safe App manifest:** `manifest.json` sits at the site's root and is served with `Access-Control-Allow-Origin: *`,
  because Safe{Wallet} fetches it from its own origin. GitHub Pages does this already.
- **Links:** share links to eth.limo, to the Safe App host and to subdomain gateways only, because path gateways put
  every site on one origin.

## Research

Start with research, keep it going through the build, and record the findings in `docs/research.md` in words. Keep
screenshots of other sites out of the repository.

1. **Users.**
   - Run `scripts/members.ts`, and extend it to a Hydrex-wide sample of account owners. For both groups, record wallet
     types, accounts per owner, lock types and power.
   - Read Hydrex's docs (docs.hydrex.fi), its forum (governance.hydrex.fi) and its public channels, to learn the words
     users use and what worries them.
   - Write two or three short personas from this. One should be the Safe signer who holds most of the votes.
2. **Hydrex's app.**
   - Open hydrex.fi in Playwright's Chromium at 390, 768 and 1440 px wide, in light and dark.
   - To see the signed-in views without a key, add an init script that announces an EIP-6963 provider. It answers
     `eth_accounts` and `eth_chainId` with a public member's address and rejects every signing method. Never use a real
     key or seed phrase.
   - Note the vocabulary, layout, colors, type, spacing, components and empty states, and what is confusing.
3. **Comparable interfaces.**
   - Study how others present delegating or automating a vote-escrow position: Aerodrome's and Velodrome's relays,
     Convex, Beefy, and Hydrex's own conduit cards. The relay pages also show what a second kind of relay will need.
   - Study how good wallets and dApps preview a transaction, and how they offer many wallets in one picker. Rabby,
     Coinbase Wallet and Safe{Wallet} are good references.
   - Keep the patterns that remove steps or doubt: one main action, what happens next, when it takes effect, and how to
     undo it.
4. **Visual identity.**
   - **Klima:** no brand assets for now: no logos, colours, fonts or imagery. Name Klima in plain text only where a fact
     needs it, such as who runs the keeper.
   - **Others:** don't imitate Hydrex, Aerodrome or any other protocol's branding, and use no protocol or token logos.
     Text symbols are enough.
   - **Identity:** an original, neutral one that fits the generic name: a calm palette with one accent colour, the
     system font stack, generous spacing, and accessible contrast in light and dark.
   - **Choosing:** propose two directions as static HTML mock-ups with fixture data, with screenshots at 390 and 1440
     px. Let the user choose before wiring anything.
5. **Testing the design.**
   - **Cold read:** give a fresh subagent with no context only the screenshots, and ask what the page does, what joining
     changes, when it takes effect, and how to leave. Fix every wrong answer, then repeat.
   - **Hallway test:** write a five-minute script the user can run with three to five Hydrex users.
   - **Heuristics:** check the page against Nielsen's ten heuristics.
6. **Accessibility and mobile.**
   - **Standard:** WCAG 2.2 AA: contrast, visible focus, full keyboard use, labelled controls, `prefers-reduced-motion`.
   - **Mobile:** design for 390 px first, since many Base users open dApps inside a wallet app. Test the in-app browsers
     of MetaMask, Coinbase Wallet / Base App and Rabby when the user can.

## Testing

- **Unit:** `node --test` on the pure modules: call encoding against viem's `encodeFunctionData`, account status from
  reads, the next-flip date, the safe order of calls, the registry, and formatting.
- **Fork:**
  - Run `anvil --fork-url <Base RPC>` at a pinned block, and drive Chromium with Playwright, using the preinstalled
    browser.
  - An init script injects an EIP-6963 test wallet that forwards to anvil and impersonates real owners: a member, a
    non-member, an owner in another conduit, an owner of an expired lock, and the large Safe.
  - Assert the on-chain results with `getLockDelegatee` and `getClaimRedirectApproved`.
  - Take screenshots at 390 and 1440 px, light and dark.
- **Coinbase:** a smoke test checks that Coinbase's SDK chunk loads under the CSP and opens its popup, without signing
  anything.
- **Safe App:** serve a build over HTTPS, from a preview deployment or a local server. In Playwright, open Safe{Wallet}
  read-only for the large Safe with that URL as a custom app. Check that the page loads in the frame, connects through
  `safe` and shows the Safe's accounts. Nothing is signed.
- **Real wallets:** a written checklist the user runs before each release, with a small account:
  - Browser extensions: MetaMask, Rabby and Coinbase Wallet.
  - In-app browsers on a phone: MetaMask, Coinbase Wallet / Base App and Rabby.
  - Coinbase's smart wallet (Base Account), through the Coinbase Wallet button.
  - A Safe, inside Safe{Wallet}: propose, sign and execute a join and a leave.
- **CI:** Prettier, `tsc`, unit tests, REUSE, the build, the size budget, a second clean build compared byte for byte
  with the first, and the fork tests when a `BASE_RPC_URL` secret is set.

## Build, CID and release

- **Build:** `npm run build` runs `scripts/build.ts`. It calls the esbuild API with minification, splitting, ES2022,
  relative paths and `legalComments: "linked"`, and copies `index.html`, `manifest.json`, `icon.svg` and `style.css`
  into `dist/`. Chunk names come from content hashes. The output has no timestamps and no absolute paths.
- **CID:**
  - `npm run cid` runs a pinned Kubo release, downloaded and checked by SHA-256 rather than taken from npm:
    `ipfs add --only-hash --cid-version=1 --raw-leaves -r dist`.
  - Release builds also export a CAR file and upload that, so every pinning service ends up with the same CID.
- **Release:**
  1. A tag builds the site, prints the CID in the release notes, and uploads the CAR to at least two pinning services,
     using CI secrets.
  2. The same tag deploys the same `dist/` to the Safe App host with pinned Actions. CI then fetches every served file
     and compares it with the build.
  3. The ENS name's owner, a Safe if possible, sets the contenthash to `ipfs://<CID>`.
  4. The README explains how anyone can rebuild a tag and compare it with the CID behind the ENS name and with the files
     on the Safe App host.

## Milestones

Ask the user at the end of each milestone before going on.

1. **Research:** the findings, the personas, a note on Aerodrome's and Velodrome's relays, and two visual directions.
2. **Skeleton:**
   - **Set-up:** the repository, CI, REUSE, Prettier, tsconfig, the build with splitting, the budget and the CID.
   - **README:** in hydrex-keeper's sections: what it does, what it can and cannot do, deployment, development, failure
     modes, limitations, licence.
3. **Read-only page:** the registry, live relay numbers, this week's vote, and the read-only address view, all from
   public RPCs.
4. **Wallets:** `injected` and `coinbaseWallet`, account statuses, join, leave and payout, with simulation, batching and
   the startup checks. Then the fork and Coinbase tests.
5. **Safe:** the Safe App manifest, the `safe` connector, the framing check and a first deployment to the Safe App host,
   tested in Playwright and then by the user with a real Safe.
6. **Polish:** all states, copy, accessibility, the cold-read loop, mobile, and the in-wallet browsers.
7. **Release:** the first CID, pinning, the contenthash, the Safe App host, and the verification steps written down.

## Still to ask the user

1. **Names:** the repository's final name and owner (working name `metadex-relays`), the product's name on the page, and
   the ENS name, kept generic too.
2. **Safe App host:** GitHub Pages, or a host that can send `frame-ancestors`, such as Cloudflare Pages or Netlify; the
   account that owns it; and whether it gets its own domain.
3. **Copy:** the user signs off the wording about votes, claims and payouts once hydrex-keeper's README describes
   claiming.

## Done when

- **Wallets:** a Hydrex user with a browser-extension or in-app wallet, or Coinbase's smart wallet, can join, leave and
  set the payout address, on a phone or a desktop.
- **Understood:** a cold reader understands what joining changes, when it takes effect and how to undo it.
- **Safe:** a Safe signer can open the page as a Safe App in Safe{Wallet}, from the Safe App host, and propose calls
  that simulate cleanly.
- **Reproducible:** two clean builds of the same commit give the same CID, and the README tells anyone how to check it
  against the ENS contenthash and the files on the Safe App host.
- **Network and CI:** the page makes no requests beyond the listed RPCs, the wallet and the origins in the README. It
  stays within budget and passes CI.
- **Rechecked:** every fact in this plan that the page relies on has been checked again, and `docs/research.md` records
  what changed.
