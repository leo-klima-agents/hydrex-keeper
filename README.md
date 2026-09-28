# hydrex-keeper

A Cloud Run job that casts the weekly Hydrex vote of the Klima "Carbon Impact" conduit on Base. It signs with the Cloud
KMS key of [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and calls `vote` on the Safe module of
[hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), which forwards it to Hydrex's Voter.

- `src/`: the job, with `viem` as its only dependency. `select.ts` is the strategy, `kms.ts` signs, and `vote.ts` is the
  only place a transaction is built and sent.
- `pools.json`: the pools it may vote for, by address. Every pool pairing two of cbBTC, WETH, SOL, USDC, USD₮0, EURC,
  BNKR, VVV and the ST0x tokenized stocks and ETFs (`wt…`), plus HYDX/USDC.
- `sh/` and `policy/`: the scripts that create the Google Cloud resources and check them for drift, and the IAM policies
  they write in full.

## How it votes

Cloud Scheduler starts the job on Tuesday 23:50 and Wednesday 23:40 UTC. Each execution runs the passes due in the next
hour: 24 hours before the Thursday 00:00 UTC epoch flip, then 600, 200, 70, 25, 10 and 5 seconds before it.

A pass reads this epoch's bribes and fees for each pool, prices them in USD with DefiLlama, and splits the conduit's
votes to maximise the expected reward: `x` votes on a pool with `V` votes from others and `usd` of rewards should earn
`usd × x / (V + x)`. To save gas, pools that would get less than 0.1% of the votes are left out: each pool voted for
adds two bribe deposits to the transaction, and a share that small earns almost nothing. Votes do not carry over, so the
first pass of an epoch votes; later passes vote again only if that pays at least 1% more. A pass takes under a second,
and Base blocks are two seconds apart, so the last pass leaves a block of margin.

A failing pass is tried up to three times while there is time. If it still fails, the execution exits non-zero, an email
alert fires, and Cloud Run restarts it up to three times. A restart runs a pass missed within the past hour, and does
nothing within the hour after the flip. Nothing is sent after the flip; voting then reverts anyway.

Every log line is JSON: each pass logs each pool's rewards and votes, the decision, and the recorded vote.

## Trust

- The job only calls `vote`, with pools from `pools.json`. KMS signs; the key never leaves the HSM. The job's service
  account has no role in its own project beyond reading the RPC secret.
- The key can do more than the job does: as the module's `KEEPER`, it can vote for any pool and call
  `claimSwapAndDistribute` with any swap calldata for the conduit's approved routers. Anyone who can run code as the
  job's service account, such as an owner of the keeper project, has that power.
- The module, the conduit and the Voter check the rest: the caller, gauge liveness, voting power, epoch timing.

## Setup

Needs `gcloud` and `jq`, and Node 26.10.0 for development. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the
keeper project; `sh/check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`. Every
script is safe to re-run.

1. **Configure.** Run `cp config.env.example config.env`, then fill in `KEEPER_PROJECT` (a project for this job only),
   `KMS_KEY_VERSION` (`version` in the key repo's `record/keeper.json`) and `ALERT_EMAIL`. The defaults match the
   deployed module and the sibling repos. Each `VOTE_OFFSETS` entry must fall within the hour after a `SCHEDULES` entry,
   and the scripts check it.
2. **Create the resources.** `sh/setup.sh` enables the APIs, and creates the job's service account (the only one allowed
   to sign), the scheduler's (which may only start the job), the RPC secret and the failure alert. It prints the job's
   service account.
3. **Grant the key.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`.
4. **Add the RPC URL.** Run
   `printf '%s' 'https://…' | gcloud secrets versions add base-rpc-url --project=KEEPER_PROJECT --data-file=-`. Several
   URLs can be given, separated by commas; `https://mainnet.base.org` is always tried last. It rate-limits the job, so
   add a second paid URL to survive an outage of the first.
5. **Fund the keeper.** Send ETH on Base to `KEEPER`, `0x625CF6663d9D090535FBd57680bFFE6fA0262434`. A vote costs a
   fraction of a cent, so 0.005 ETH lasts years. The job refuses to vote with less than twice the cost of a vote.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build, deploys the job, lets only the scheduler's account
   start it, and creates one scheduler job per `SCHEDULES` entry, deleting stale ones. Re-run it after any change to
   `src/` or `pools.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs one pass and signs with KMS, but sends nothing. `sh/run.sh --now` votes.
   Read the logs in Cloud Run.
8. **Check for drift.** `sh/check.sh` compares the project with `config.env` and `policy/`, read-only: service accounts,
   keys, environment, secret, IAM, schedules and alert.

CI runs `sh/check.sh` every Friday and on demand. It uses a read-only service account in the keeper project, reached by
Workload Identity Federation from this repository through the `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` repository
variables, and builds `config.env` from the repository variables named in `config.env.example`.

Outside the scripts:

- Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project; `check.sh` only detects keys.
- The alert fires on failed executions, not on missing ones. To notice a missed schedule, also alert when
  `run.googleapis.com/job/completed_execution_count` is absent for eight days.
- Keep the keeper funded; the dry run logs the cost of a vote.
- Change `pools.json` by pull request, then redeploy.

## Failure modes

- **Base RPC:** each URL is tried in turn, for 3 seconds (the first) or 5 (the others). If all fail, the pass fails.
- **DefiLlama:** three attempts, then the last prices are reused. The pass fails if there are none, or if no token has a
  price. Unpriced tokens count as zero.
- **Cloud KMS:** the pass fails. A signature that does not recover to `KEEPER` is never sent.
- **Cloud Scheduler:** no pass that day, and no alert.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job refuses to vote.

## Development

Run `npm ci`, `npm run typecheck` and `npm test`, and `npm run format` before committing.
`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URLS=… npm run dry-run` runs one pass against Base without
KMS and sends nothing. `test/sh/run.sh` runs the scripts under `dash` (or `$TEST_SH`) against a fake `gcloud` and
compares the calls and output with `test/sh/golden/`; `--update` rewrites them.

CI runs these checks, Prettier, `shellcheck` and `reuse lint`, and builds the image on every push. Dependabot updates
the pinned Actions, npm packages and base images.

## Limitations

- The expected reward assumes the other voters stay put; the late passes correct for them moving.
- Prices come from a single source.
- Claiming and swapping rewards are not implemented.

## License

MIT, REUSE compliant.
