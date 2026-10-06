# hydrex-keeper

A Cloud Run job that casts the weekly Hydrex vote of the Klima "Carbon Impact" conduit on Base. It signs with the Cloud
KMS key of [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and calls `vote` on the Safe module of
[hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), which forwards it to Hydrex's Voter.

- `src/`: the job, with `viem` as its only dependency. `select.ts` is the strategy, `kms.ts` signs, and `vote.ts` is the
  only place a transaction is built and sent.
- `pools.json`: the pools it may vote for, by address. Every pool pairing two of ETH or WETH, cbBTC, SOL, USDC, USDT,
  USD₮0, EURC, BNKR, VVV, HYDX, kVCM and the ST0x tokenized stocks and ETFs (`wt…`), and every single-asset vault
  holding one of them.
- `sh/` and `policy/`: the scripts that create the Google Cloud resources and check them for drift, and the IAM policies
  they write in full.

## How it votes

Cloud Scheduler starts the job on Tuesday 23:50 and Wednesday 23:40 UTC. Each execution runs the passes due in the next
hour: 24 hours before the Thursday 00:00 UTC epoch flip, as a fallback. The execution started within the hour before the
flip then votes in the last two blocks before it.

A pass reads this epoch's bribes and fees for each pool, prices them in USD, and splits the conduit's votes to maximise
the expected reward: `x` votes on a pool with `V` votes from others and `usd` of rewards should earn
`usd × x / (V + x)`. To save gas, pools that would get less than 0.1% of the votes are left out: each pool voted for
adds two bribe deposits to the transaction, and a share that small earns almost nothing. Votes do not carry over, so the
first pass of an epoch votes; later passes vote again only if that pays at least 1% more. A vote's max fee is twice the
base fee plus the tip; if either of the last two blocks was at least 90% full, the tip rises to the 99th percentile of
their tips, up to 0.1 gwei.

The last pass votes as late as possible, to see as many of the other votes as it can. It starts a minute before the
flip: it prices the rewards, then polls the block being built, which Base builds in sub-blocks about every 200 ms. The
polls tell it when blocks are sealed and when their last sub-block starts, wherever that falls within the second and
however far apart blocks are. Two blocks before its first vote, it starts reading the block being built every 100 ms,
with the votes others sent so far, and keeps a vote signed for the latest read. It sends that vote in each of the last
two blocks before the flip, 200 ms before the block's last sub-block starts: about 0.8 s before the block's timestamp.
The deadlines come from the block timing alone: if reads or polls hang or fail, the vote sent is the latest that was
ready, from an earlier read or from the minute before.

A failing pass is tried up to three times while there is time. If it still fails, the execution exits non-zero, an email
alert fires, and Cloud Run restarts it up to three times. A restart runs a pass missed within the past hour, and does
nothing within the hour after the flip. Nothing is sent after the flip; voting then reverts anyway. After the flip, the
last pass reads where its votes landed, and fails if one reverted before the flip, if it had nothing to send, or if the
Voter shows no vote of the conduit this epoch.

Every log line is JSON: each pass logs each pool's rewards and votes, the decision, and the recorded vote. The last pass
also logs the block timing it learned and what it sends in each block.

## Trust

- The job only calls `vote`, with pools from `pools.json`. KMS signs; the key never leaves the HSM. The job's service
  account has no role in its own project beyond reading its secrets.
- The key can do more than the job does: as the module's `KEEPER`, it can vote for any pool and call
  `claimSwapAndDistribute` with any swap calldata for the conduit's approved routers. Anyone who can run code as the
  job's service account, such as an owner of the keeper project, has that power.
- The module, the conduit and the Voter check the rest: the caller, gauge liveness, voting power, epoch timing.

## Setup

Needs `gcloud`, `jq` and `curl`, and Node 26 for development. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the
keeper project; `sh/check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`. Every
script is safe to re-run.

1. **Configure.** Run `cp config.env.example config.env`, then fill in `KEEPER_PROJECT` (a project for this job only),
   `KMS_KEY_VERSION` (`version` in the key repo's `record/keeper.json`) and `ALERT_EMAIL`. The defaults match the
   deployed module and the sibling repos. Each `VOTE_OFFSETS` entry must fall within the hour after a `SCHEDULES` entry
   and at least 2 minutes before the flip, and one `SCHEDULES` entry must start between 2 and 60 minutes before the
   flip; the scripts check all three.
2. **Create the resources.** `sh/setup.sh` enables the APIs, and creates the job's service account (the only one allowed
   to sign), the scheduler's (which may only start the job), the secrets, and email alerts on a failed execution and on
   a failed start. It prints the job's service account.
3. **Grant the key.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`.
4. **Add the secrets.** Add the RPC URL with
   `printf '%s' 'https://…' | gcloud secrets versions add base-rpc-url --project=KEEPER_PROJECT --data-file=-`, then an
   Alchemy API key to `alchemy-api-key` the same way, and a CoinGecko Demo API key if `COINGECKO_SECRET` is set. Several
   RPC URLs can be given, separated by commas. Public nodes, which rate-limit, are tried after them.
5. **Fund the keeper.** Send ETH on Base to `KEEPER`, `0x625CF6663d9D090535FBd57680bFFE6fA0262434`. A vote costs a few
   cents, so 0.005 ETH pays for about 300. The job refuses to vote with less than twice the cost of a vote.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build, deploys the job, lets only the scheduler's account
   start it, and creates one scheduler job per `SCHEDULES` entry, deleting stale ones. Re-run it after any change to
   `src/` or `pools.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs one pass and signs with KMS, but sends nothing. `sh/run.sh --now` votes.
   Read the logs in Cloud Run.
8. **Check for drift.** `sh/check.sh` compares the project with `config.env` and `policy/`, read-only: service accounts,
   keys, environment, secrets, IAM, schedules and alerts. It also fails if the keeper holds less than 0.0005 ETH.

The `check` workflow runs `sh/check.sh` every Friday and on demand. It uses a read-only service account in the keeper
project, reached by Workload Identity Federation from this repository through the `WIF_PROVIDER` and
`CI_SERVICE_ACCOUNT` repository variables, and builds `config.env` from the repository variables named in
`config.env.example`.

Outside the scripts:

- Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project; `check.sh` only detects keys.
- Change `pools.json` by pull request, then redeploy.

## Failure modes

- **Base RPC:** a call that fails, or gets no answer within 250 ms, also goes to the next URL, and the first answer
  wins. If all fail, the pass fails. The vote is sent to every URL. In the last pass, a poll that hangs is dropped after
  500 ms, and up to three reads run at once, so that one that hangs does not hold up the next.
- **Prices:** DefiLlama, Alchemy, and CoinGecko if set, three attempts each. A price is the median of three quotes, the
  lower of two, or the only one. If every source fails, the last prices are reused. The pass fails if there are none, or
  if no token has a price. Unpriced tokens count as zero.
- **Cloud KMS:** the pass fails. A signature that does not recover to `KEEPER` is never sent.
- **Cloud Scheduler:** a failed start is retried three times within five minutes, and emails an alert. A paused or
  deleted schedule does neither; `check.sh` reports it.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job refuses to vote.

## Development

Run `npm ci`, `npm run typecheck` and `npm test`, and `npm run format` before committing.
`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URLS=… npm run dry-run` runs one pass against Base without
KMS and sends nothing; `ALCHEMY_API_KEY` and `COINGECKO_API_KEY` add their price sources. `test/sh/golden.sh` runs the
scripts under `dash` (or `$TEST_SH`) against a fake `gcloud` and `curl`, and compares the calls and output with
`test/sh/golden/`; `--update` rewrites them.

CI runs these checks, Prettier, `shellcheck` and `reuse lint`, and builds the image on every push. Dependabot updates
the pinned Actions, npm packages and base images.

## Limitations

- The expected reward assumes the other voters stay put. The last pass sees the votes sent until about 2 s before the
  flip, but not those sent later.
- Claiming and swapping rewards are not implemented.

## License

MIT, REUSE compliant.
