# Plan: the Carbon Impact dApp

A static page where a veHYDX holder joins or leaves Hydrex's Klima "Carbon Impact" conduit, chooses where payouts go,
and sees what the conduit does. It is served from IPFS through an ENS name on eth.limo. This plan is for the agent that
builds it. The facts below were checked on Base on 2026-10-15; check them again before relying on them.

## Why it exists

- Hydrex's app no longer offers the conduit. On hydrex.fi/accounts, the automation picker shows only "No Automation",
  and an account already in a conduit sees "Automations ended. Please switch to No Automation." with a "Switch now"
  button that leaves it.
- On chain, the conduit is still open: the VotingEscrow keeps its approval config active, and it holds 897,042 votes.
- This page is therefore the only interface for joining. It must be simple enough for a Hydrex user and small enough to
  audit.

## Scope

**In:**

- Read-only view: what the conduit does, its live numbers, this week's vote.
- Wallet view: the user's accounts, their status, and joining, leaving and setting the payout address.
- A read-only view of any address, for Safe signers and for research.
- An export of the same calls as a Safe Transaction Builder batch.

**Out of v1:** claiming, swapping and voting (the keeper's job), locking HYDX (link to Hydrex), per-account payout
history (see [Decisions](#decisions-to-ask-the-user)), and anything that needs a server.

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
[hydrexfi/hydrex-periphery](https://github.com/hydrexfi/hydrex-periphery). The conduit was deployed at block 43,846,350
(2026-03-25).

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
- **Events:** `ConduitApprovalExecuted` on the VotingEscrow; `ClaimSwapAndDistributeCompleted` (owner indexed),
  `CarbonRetired` and `PayoutRecipientUpdated` on the conduit.

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

### Timing

- Epochs flip on Thursday at 00:00 UTC. The keeper counts the conduit's votes as of the epoch start, so an account that
  joins counts from the next flip. Hydrex's app shows "Current payout" and "Next payout" for this reason.
- Claim-redirect approval takes effect at once. Verify, from the contracts, which epochs' rewards the conduit may then
  claim for a newly joined account, and say so on the page.
- `hydrex-keeper` votes but does not claim yet. Find out who calls `claimSwapAndDistribute` and how often, and promise
  nothing about payouts until the user confirms.

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

### Limits of public RPCs

- **Reads:** fine through Multicall3.
- **Logs:** `mainnet.base.org` allows 200 blocks per `eth_getLogs` and rate-limits; `base.drpc.org` 10,000 on its free
  plan; `1rpc.io/base` 50; `base-rpc.publicnode.com` only recent blocks.
- **Consequence:** the conduit's 8.8M blocks of history cannot come from public RPCs in a browser. History needs an
  indexer, which is a decision for the user.

## Principles

Copy hydrex-keeper's way of working:

- **Small surface.** Runtime dependencies are `viem` and `mipd`, pinned to exact versions, plus any wallet SDK the user
  approves. No UI framework, CSS framework, analytics, trackers, external fonts, CDNs or remote images. At run time the
  page talks only to the listed RPCs and the user's wallet.
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

## Stack

- **Language:** TypeScript checked by `tsc`, bundled for the browser by `esbuild` (one pinned binary, deterministic
  output). No Vite.
- **Chain:** `viem` with `createClient` and actions imported from `viem/actions`, so only what is used ships. Base comes
  from `viem/chains`.
- **Wallets:** `mipd` for EIP-6963 discovery, with viem's `custom` transport over the chosen provider. Remember the last
  wallet's `rdns` in `localStorage`, and reconnect silently with `eth_accounts`. React to `accountsChanged`,
  `chainChanged` and `disconnect`.
- **Reads:** before a wallet connects, viem's `fallback` over the public RPCs; afterwards, the wallet's provider first
  and the public RPCs after it.
- **Rendering:** one `render(state)` that rebuilds the page from state with a small `h(tag, props, ...children)` helper.
  Text goes in through `textContent` only, never `innerHTML`, because token symbols and names come from the chain.
- **Styling:** one CSS file with custom properties, light and dark through `prefers-color-scheme`, the system font stack
  (or one self-hosted OFL font if the brand needs it), and inline SVG icons.
- **Routing:** none. `#0x…` opens the read-only view of an address. The hash never reaches the gateway.
- **Budget:** the measured baseline for this flow is 66 KB of gzipped JS. CI fails above 90 KB of gzipped JS or 10 KB of
  gzipped CSS, not counting a wallet SDK the user approves.

## Repository

A new repository next to hydrex-keeper (ask the user for its name, for example `hydrex-conduit-app`):

```
index.html        CSP meta tag, root element, one script and one stylesheet
src/
  abi.ts          parseAbi fragments for the calls above
  chain.ts        addresses, clients, RPC list, startup checks
  read.ts         accounts, conduit, epoch and vote reads, each batched through Multicall3
  status.ts       an account's status from its reads (pure)
  write.ts        join, leave and payout calls; batching; simulation
  wallet.ts       discovery, connect, reconnect, wallet events
  safe.ts         Transaction Builder JSON (pure)
  format.ts       numbers, dates, addresses (pure)
  view.ts         render and h()
  main.ts         state and wiring
style.css
conduits.json     names of Hydrex's conduits by address, reviewed by pull request like tokens.json
scripts/          build.ts, budget.ts, members.ts
test/             unit tests for pure modules; e2e/ for fork tests
docs/research.md  research findings, in words
```

## The page

### What it shows

1. **Top:** one sentence on what Carbon Impact does. Then live numbers: tonnes retired, the share of kVCM retired, the
   payout tokens, the conduit's votes, and the time to the next flip in local time and UTC.
2. **This week's vote:** the pools, by token symbols, with their shares, and when the keeper last voted.
3. **Your accounts:** one row per account, showing its type in Hydrex's words, its voting power, when its lock ends, and
   a status:
   - In Carbon Impact.
   - Joined, counts from Thursday \<date\>.
   - In another automation, named from `conduits.json`, or "delegated to 0x…".
   - Not automated.
   - Lock ended, with no power and a link to extend it on Hydrex.
4. **Payout address:** the effective recipient for the owner, and a field to change it.
5. **What joining allows,** in plain words, from live values:
   - The conduit can claim this account's rewards, swap them through the routers Hydrex approved, retire this share of
     the kVCM as carbon credits in this name, and send the rest to the payout address.
   - Klima's keeper chooses the votes each week.
   - Hydrex can change these settings.
   - Leaving is one transaction, at any time.
   - Link each contract to Basescan and each repository to GitHub.
6. **Footer:** the version, commit and CID; how to check them; links to the repositories.

### States to design

No wallet, several wallets, wrong network, no accounts (link to Hydrex), every account status above, a pending
transaction, success, rejection, a revert (in plain words), an unreachable RPC, a failed startup check, and a read-only
address.

### Writes

- **Join selected:** for each selected account in another automation, first a leave of that conduit, then a join.
- **Batching:** if `wallet_getCapabilities` reports atomic batching on Base, send everything as one `sendCalls` with one
  confirmation. Otherwise send one transaction after another, with progress, in the safe order.
- **Simulate first:** run every call with `eth_call` from the owner before asking the wallet. Show the revert reason in
  plain words, and send nothing that fails.
- **Safe owners:** in the read-only view, export the same calls as a Transaction Builder JSON file to import in
  Safe{Wallet}. Check the format against Safe's documentation, and have the user test one import.
- **After sending:** wait for the receipt, then re-read and re-render. Never trust an optimistic state.

### Safety checks at startup

Before allowing a write, confirm all of these:

- The chain ID is 8453.
- The conduit's `veToken` and `voter` match the constants.
- `getConduitApprovalConfig(conduit)` returns `[3, 5]` and active.
- The conduit's code hash matches the one pinned in `chain.ts`.

If any check fails, disable writes and say why.

### Content Security Policy

`index.html` carries a CSP meta tag:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src <the RPC origins>; base-uri 'none'; form-action 'none'
```

A meta tag cannot set `frame-ancestors`, so say so in the README. Share links to eth.limo and to subdomain gateways
only: path gateways put every site on one origin.

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
   - Study how others present delegating or automating a vote-escrow position. Candidates are Aerodrome's Relays,
     Velodrome, Convex, Beefy and Hydrex's own conduit cards.
   - Study how good wallets and dApps preview a transaction. Rabby, Coinbase Wallet and Safe{Wallet} are good
     references.
   - Keep the patterns that remove steps or doubt: one main action, what happens next, when it takes effect, and how to
     undo it.
4. **Brand.**
   - Ask the user for Klima Protocol's brand assets and guidelines, and study klimaprotocol.com.
   - The page should feel familiar to a Hydrex user and still be clearly Klima's. Do not imitate Hydrex's branding.
   - Propose two visual directions as static HTML mock-ups with fixture data, with screenshots at 390 and 1440 px. Let
     the user choose before wiring anything.
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
  reads, the next-flip date, the safe order of calls, the Safe JSON, and formatting.
- **Fork:**
  - Run `anvil --fork-url <Base RPC>` at a pinned block, and drive Chromium with Playwright, using the preinstalled
    browser.
  - An init script injects an EIP-6963 test wallet that forwards to anvil and impersonates real owners: a member, a
    non-member, an owner in another conduit, an owner of an expired lock, and the large Safe (read-only view and
    export).
  - Assert the on-chain results with `getLockDelegatee` and `getClaimRedirectApproved`.
  - Take screenshots at 390 and 1440 px, light and dark.
- **CI:** Prettier, `tsc`, unit tests, REUSE, the build, the size budget, a second clean build compared byte for byte
  with the first, and the fork tests when a `BASE_RPC_URL` secret is set.

## Build, CID and release

- **Build:** `npm run build` runs `scripts/build.ts`. It calls the esbuild API with minification, ES2022, relative paths
  and `legalComments: "linked"`, and copies `index.html` and `style.css` into `dist/`. The output has no timestamps and
  no absolute paths.
- **CID:**
  - `npm run cid` runs a pinned Kubo release, downloaded and checked by SHA-256 rather than taken from npm:
    `ipfs add --only-hash --cid-version=1 --raw-leaves -r dist`.
  - Release builds also export a CAR file and upload that, so every pinning service ends up with the same CID.
- **Release:**
  1. A tag builds the site, prints the CID in the release notes, and uploads the CAR to at least two pinning services,
     using CI secrets.
  2. The ENS name's owner, a Safe if possible, sets the contenthash to `ipfs://<CID>`.
  3. The README explains how anyone can rebuild a tag and compare the CID with the contenthash.

## Milestones

Ask the user at the end of each milestone before going on.

1. **Research and decisions:** the findings, the personas, two visual directions, and answers to the questions below.
2. **Skeleton:**
   - **Set-up:** the repository, CI, REUSE, Prettier, tsconfig, the build, the budget and the CID.
   - **README:** in hydrex-keeper's sections: what it does, what it can and cannot do, deployment, development, failure
     modes, limitations, licence.
3. **Read-only page:** live conduit numbers, this week's vote, and the read-only address view, all from public RPCs.
4. **Wallet:** discovery, connect, account statuses, join, leave and payout, with simulation, batching and the startup
   checks. Then the fork tests.
5. **Safe:** the Transaction Builder export, tested by the user.
6. **Polish:** all states, copy, accessibility, the cold-read loop, mobile, and the in-wallet browsers.
7. **Release:** the first CID, pinning, the contenthash, and the verification steps written down.

## Decisions to ask the user

1. **Names:** the repository's name and owner, and the ENS name the page will live at.
2. **Wallets:**
   - **Smart wallets:** support Coinbase Smart Wallet / Base Account on desktop with `@base-org/account`? It has two of
     the 14 owners. Measure its size and dependencies first. The alternative is in-app browsers only.
   - **WalletConnect:** add it? It needs a Reown project ID and a heavier dependency.
   - **Safe:** a Safe App mode on top of the Transaction Builder export?
3. **History:** none in v1, or one of these sources:
   - Blockscout's API, if it works from a browser.
   - Etherscan's API, with a key that ships publicly.
   - Hydrex's undocumented API.
   - An indexer of Klima's own.
4. **Promises:** what the page may say about claims and payouts, since the keeper does not claim yet. Whether to mention
   Hydrex's "Automations ended" banner, and in what words. Whether Hydrex has been told about the page.
5. **Brand:** assets, colours, fonts and tone, and whether token logos from hydrex-lists may be used. That repository
   has no licence file.

## Done when

- A Hydrex user with a browser-extension wallet can join, leave and set the payout address on a phone or a desktop. A
  cold reader understands what joining changes, when it takes effect and how to undo it.
- A Safe signer can see the Safe's accounts and export a batch that imports and simulates cleanly in Safe{Wallet}.
- Two clean builds of the same commit give the same CID, and the README tells anyone how to check it against the ENS
  contenthash.
- The page makes no requests beyond the listed RPCs and the wallet, stays within budget, and passes CI.
- Every fact in this plan that the page relies on has been checked again, and `docs/research.md` records what changed.
