# hydrex-keeper

The Cloud Run job that casts the weekly Hydrex vote of the Klima "Carbon Impact" conduit on Base, and claims the rewards
of the conduit's delegators after each epoch flip. It signs with the HSM-held key of
[hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and calls `vote` and `claimSwapAndDistribute` on the
Safe module of [hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), which forwards them to the
conduit. This repository holds the job in `src/`, whose only dependency is `viem`, the tokens whose rewards it counts
and claims in `tokens.json`, and the scripts in `sh/` that create, deploy and check its Google Cloud project, with the
IAM policies they write in `policy/`.

## How it votes

Hydrex epochs flip on Thursday at 00:00 UTC, and votes do not carry over. Cloud Scheduler starts the job at 23:50 UTC on
Tuesday and on Wednesday.

- **A day before the flip**, it votes in proportion to each pool's rewards. This vote is always cast, as a fallback.
- **In the last two blocks before the flip**, it votes for the largest expected reward: `x` votes on a pool with `V`
  votes from others and `usd` of rewards earn `usd × x / (V + x)`. It reads the block being built, with the votes others
  sent so far, and sends each vote about 0.8 s before its block's timestamp; if reads or signing fail, it sends the
  latest vote it has ready. It replaces the vote in force only if that pays at least $1 more.

Rewards are this epoch's bribes and fees in every pool with a live gauge, counted only in the tokens of `tokens.json`
and priced in USD. A vote leaves out pools that would get less than 0.1% of the votes, and all but the 40 largest: each
pool adds gas, and a Base transaction may use at most 16.8M. When blocks are nearly full, the tip rises, up to 0.1 gwei.

A failed execution exits non-zero, which emails `ALERT_EMAIL`, and Cloud Run retries it up to three times; a retry does
what is still due. After the flip, the last pass checks where its votes landed and that the Voter shows a vote of the
conduit this epoch, then claims.

## How it claims

After each flip, the job claims the rewards of the veNFTs delegated to the conduit. Each `claimSwapAndDistribute` claims
for one veNFT: the conduit collects its bribes and fees, swaps them to kVCM, uses about a third of the kVCM to retire
carbon credits, and sends the rest to the veNFT's owner.

- **Whose:** the veNFTs delegated to the conduit at the start of the epoch that just ended, except those that have not
  allowed the conduit to claim for them and, for now, the Klima Foundation's (`EXCLUDED_OWNERS` in `src/claim.ts`).
- **What:** rewards in the tokens of `tokens.json`, from the pools the conduit voted for in the last 12 epochs.
- **Minimum:** a claim is sent only if it collects at least $5 and its gas costs at most 5% of that. Smaller rewards
  wait for a later week.
- **Swaps:** through KyberSwap, with up to 5% slippage. The job checks each swap before using it, and claims less of a
  token when its swap would lose too much.

Claims go one at a time, the largest first, in the hour after the flip. They stop if a claim would leave the keeper with
less than 0.001 ETH, which is kept for the votes, or if another transaction of the keeper, such as a vote, is pending.

## What it can and cannot do

- **It votes and claims.** `src/vote.ts` and `src/claim.ts` build every transaction the job sends: the module's `vote`,
  for pools with a live gauge that pay rewards in the tokens of `tokens.json`, and its `claimSwapAndDistribute`, for
  veNFTs delegated to the conduit, with KyberSwap calldata the job decodes and checks.
- **The key never leaves the HSM.** Cloud KMS signs, and a signature that does not recover to `KEEPER` is never sent.
  The job's service account is the key's only signer; it has no keys, and no role in its own project beyond reading its
  secrets.
- **The key can do more than the job does.** As the module's `KEEPER`, it can vote for any pool and call
  `claimSwapAndDistribute` with any swap calldata the conduit's routers accept. Anyone who can run code as the job's
  service account, such as an owner of the keeper project, can do the same.
- **The rest is checked on chain.** The module checks the caller; the conduit and the Voter check gauges, voting power
  and the epoch. For a claim, the conduit also checks that the veNFT lets it claim, and that each swap goes through a
  router it approves and buys a token it pays out.

## Deployment

- **Network:** Base.
- **`MODULE`:** [`0x750973E0CB728C3112561Bc8E9b235afA9B17E81`][module], `KlimaVeTokenConduitExecutor`.
- **`KEEPER`:** [`0x625CF6663d9D090535FBd57680bFFE6fA0262434`][keeper], the Cloud KMS HSM key `hydrex-keeper-v1`,
  version 1.

[module]: https://basescan.org/address/0x750973E0CB728C3112561Bc8E9b235afA9B17E81
[keeper]: https://basescan.org/address/0x625CF6663d9D090535FBd57680bFFE6fA0262434

## Setup

Needs `gcloud`, `jq` and `curl`. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the keeper project, and
`sh/check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`. Every script is safe
to re-run.

1. **Configure.** `cp config.env.example config.env`, then fill in `KEEPER_PROJECT` (a project for the job only),
   `KMS_KEY_VERSION` (`version` in hydrex-keeper-key's `record/keeper.json`) and `ALERT_EMAIL`. `config.env` holds
   public material only; the secrets live in Secret Manager.
2. **Create the resources.** `sh/setup.sh` enables the APIs and creates the job's and the scheduler's service accounts,
   the secrets, and email alerts on a failed execution or start. It prints the job's service account.
3. **Grant the key.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`.
4. **Add the secrets.** `sh/setup.sh` prints the command that adds each: Base RPC URLs, separated by commas, and an
   Alchemy API key. Public RPCs are tried after yours.
5. **Fund the keeper.** Send ETH on Base to `KEEPER`. A vote costs about 0.00005 ETH and a claim up to 0.0001 ETH, and
   claims always leave 0.001 ETH for the votes. 0.01 ETH lasts about three months.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build and deploys the job and its schedule. Run it again after
   any change to `src/` or `tokens.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs the vote of a day before the flip at once and signs it with KMS, but
   sends nothing; `sh/run.sh --now` sends it. `sh/run.sh --dry-run --claim` does the same for the claims. Without
   `--dry-run`, `--claim` is refused while the schedule may be voting or claiming. The logs are in Cloud Run, one JSON
   object per line.

## Checks

`sh/check.sh` compares the live project with `config.env` and `policy/`, read-only: the job, its schedule, the secrets,
the service accounts, IAM and the alerts. It also fails if the keeper holds less than 0.002 ETH, to warn before the
claims stop at 0.001 ETH.

The `check` workflow runs it every Friday, after the vote, and on demand. It signs in through Workload Identity
Federation as a service account with the roles above, named by the `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` repository
variables, and builds `config.env` from the repository variables named in `config.env.example`: set at least
`KEEPER_PROJECT`, `KMS_KEY_VERSION` and `ALERT_EMAIL`.

Outside the scripts: enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project, since `check.sh` only
detects keys, and change `tokens.json` by pull request, then redeploy.

## Failure modes

- **Base RPC:** a read that fails, or gets no answer within 250 ms, also goes to the next URL. A vote or a claim goes to
  every URL; in the last blocks, a vote that no URL accepts fails the execution, unless the vote it replaces landed
  first. The claims' reads are much heavier, so each goes to one URL at a time, which has 30 s to answer.
- **Prices:** DefiLlama and Alchemy, and CoinGecko if `COINGECKO_SECRET` is set; a price is the median of their quotes,
  or the lower of two. A token without a price counts as zero, and the vote fails if no token has one.
- **Keeper balance:** a vote needs twice its maximum cost in the keeper, so that it leaves enough to vote in the last
  blocks; a vote in the last blocks needs it once; a claim needs it plus 0.001 ETH. Short of that, the job refuses to
  vote or claim and logs `fund the keeper`.
- **Claims:** a claim that fails, or claims still left when the hour ends, fail the execution; the retry or the next
  week's claims take what is left. The claims stop if the keeper cannot pay, if another of its transactions is pending,
  or if a claim's outcome is unknown. A token KyberSwap cannot swap is left out, and a wrong answer from KyberSwap fails
  the execution.
- **Cloud Scheduler:** a failed start is retried three times within five minutes, and emails an alert. A paused or
  deleted schedule does neither; `check.sh` reports it.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job refuses to vote, and claims wait for the minter
  until an hour after the flip.

## Development

Needs Node 26. Run `npm ci`, then `npm run typecheck`, `npm test` and `npm run format` before committing.
`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URLS=… npm run dry-run` runs the vote of a day before the
flip against Base without KMS, and sends nothing; `npm run dry-run-claim` does the same with the claims.
`test/sh/golden.sh` runs the scripts under `dash` (or `$TEST_SH`) against a fake `gcloud` and `curl` and compares the
calls and output with `test/sh/golden/`; `--update` rewrites them. CI runs the type check, the tests, Prettier, the
golden tests, `shellcheck` and `reuse lint`, and builds the image. Dependabot updates the pinned Actions, npm packages
and base images.

## Limitations

- The expected reward assumes the others' votes stay put. The last pass misses votes sent in the last 2 s or so, and
  rewards paid in the last minute, which is rare.
- Claims only take rewards in the tokens of `tokens.json`, from the pools the conduit voted for; the owner can claim the
  rest. But a claim takes everything those pools owe the veNFT, including what it earned before it delegated to the
  conduit, which is then swapped and partly retired like the rest.
- Rewards that never add up to $5 are never claimed. Swaps lose more as they grow: about 4.5% for $1,000 of USDC. Each
  swap also raises kVCM's price for the claims after it, so the veNFTs with the least to claim, which are claimed last,
  get slightly less kVCM.

## License

MIT, REUSE compliant.
