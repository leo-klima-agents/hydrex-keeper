# hydrex-keeper

A Cloud Run job that casts the Klima "Carbon Impact" conduit's weekly vote on Hydrex, on Base. It signs with the HSM
key from [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and calls `vote` on
[hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), a Safe module that accepts only that key.

- `src/`: the job. `viem` is its only dependency.
- `pools.json`: the pools it may vote for.
- `sh/`, `policy/`: the scripts that create the Google Cloud resources and check them for drift.

## What it does

Cloud Scheduler starts the job on Tuesday at 23:50 UTC and on Wednesday at 23:40 UTC. Each execution runs the passes
due in the next hour: one 24 hours before the epoch flip (Thursday 00:00 UTC), then passes 600, 200, 70, 25, 10 and 5
seconds before it.

A pass reads this epoch's bribes and fees for every pool in `pools.json`, prices them in USD, and splits the conduit's
votes to get the highest expected reward. The first pass of an epoch always votes. Later passes vote again only if the
new split pays at least 1% more.

The keeper can only call `vote` on the module, with pools from `pools.json`: if it is compromised, the worst it can do
is cast a bad vote among those pools. It cannot claim, swap, move funds or read the key: it asks Cloud KMS to sign one
hash per vote. Its service account can only read the RPC secret, and nothing can impersonate it.

## Setup

You need `gcloud` and `jq`. `setup.sh` and `deploy.sh` need `roles/owner` on the keeper project and are safe to
re-run. `check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`.

1. **Configure.** Run `cp config.env.example config.env`. Fill in `KEEPER_PROJECT` (a project that holds nothing else),
   `KMS_KEY_VERSION` (`version` in the key repo's `record/keeper.json`) and `ALERT_EMAIL`.
2. **Create the resources.** `sh/setup.sh` enables the APIs and creates the two service accounts, the RPC secret, and
   an email alert for failed executions. It prints the job's service account email.
3. **Grant the key.** In hydrex-keeper-key, set `KEEPER_SA` to that email and run `sh/grant.sh`.
4. **Add the RPC URL.**

   ```sh
   printf '%s' 'https://…' | gcloud secrets versions add base-rpc-url --project=KEEPER_PROJECT --data-file=-
   ```

   Separate several URLs with commas. They are tried in order, then the public `https://mainnet.base.org`. The public
   node throttles the job's bursts of calls, so add a second paid provider.
5. **Fund the keeper.** Send ETH on Base to `KEEPER` (`0x625CF6663d9D090535FBd57680bFFE6fA0262434`). 0.005 ETH lasts
   years. The job refuses to vote with less than twice the estimated cost.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build, deploys the job, lets only the scheduler's service
   account start it, and creates one Cloud Scheduler job per `SCHEDULES` entry. Re-run it after any change to `src/` or
   `pools.json`.
7. **Try it.**

   ```sh
   sh/run.sh --dry-run --now   # reads, prices, simulates and signs with KMS; sends nothing
   sh/run.sh --now             # votes now if that pays at least 1% more than the current vote
   ```

   Read the logs in Cloud Run. The dry run proves that the KMS key signs for `KEEPER`.
8. **Check for drift.** `sh/check.sh` is read-only. It fails if the job, the schedules, the secret, the service
   accounts or the alert differ from `config.env` and `policy/`.

Outside the scripts:

- Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project. `check.sh` only detects keys.
- The alert only covers failed executions. To notice a missed schedule, add an alert on
  `run.googleapis.com/job/completed_execution_count` being absent for eight days.
- `pools.json` is the policy: change it by pull request, then redeploy.

## CI

Every push runs shellcheck, `reuse lint`, the typecheck, the unit tests, the golden tests and a Docker build.

`check.yml` runs `sh/check.sh` every Friday and on demand. It needs a service account in the keeper project with the
roles `check.sh` needs, a Workload Identity Federation provider limited to this repository, and these repository
variables: `WIF_PROVIDER`, `CI_SERVICE_ACCOUNT`, and the `config.env` values (`KEEPER_PROJECT`, `REGION`, `JOB`,
`KEEPER_SA_NAME`, `SCHEDULER_SA_NAME`, `KMS_KEY_VERSION`, `MODULE`, `VOTE_OFFSETS`, `SCHEDULES`, `RPC_SECRET`,
`ALERT_EMAIL`). None of them are secret.

## How it votes

The job derives every address from `MODULE`: the module's `CONDUIT` and `KEEPER`, and the conduit's `voter` and
`veToken`.

- **Reward.** For each pool with a live gauge, the job reads this epoch's `rewardsPerEpoch` of every token in its
  external bribe (bribes) and internal bribe (fees) contracts. Putting `x` votes on a pool that has `V` votes from
  others is expected to pay `usd × x / (V + x)`.
- **Split.** The job maximises the total by water-filling: every funded pool ends up with the same marginal reward.
  Each pool counts as having at least 0.01% of the conduit's power from others, so an empty pool gets a small share,
  not everything. Pools that would get under 0.1% are dropped, since each costs gas. Weights are sent in basis points.
  `src/select.ts` is this strategy and nothing else.
- **Re-votes.** Hydrex's `vote` resets before recasting, so each pass starts from scratch. The Voter keeps last
  epoch's votes until that reset, so the job ignores them unless `lastVoted` is in the current epoch.
- **Timing.** A vote at or after the flip reverts, so a late pass fails instead of voting into the wrong epoch. A pass
  that is already overdue is skipped. A pass tries up to three times while there is time before the next one. A pass
  that fails for good makes the job exit non-zero, which fires the alert. Cloud Run retries a failed job up to three
  times, and a retry works out from the clock which passes remain.
- **Speed.** An execution reads gauges, bribe contracts and reward tokens once, and again only if a bribe contract
  gains a token. Each pass re-reads votes and rewards in three round trips, and refreshes prices only if at least 20
  seconds are left. A pass takes about a second and Base blocks are two seconds apart, so the last pass leaves a block
  of margin.
- **Nonces.** A vote uses the confirmed nonce. If a vote this process sent is still pending, the new one pays 25% more
  and replaces it. A pending vote from an earlier process is queued behind. Nothing is sent after the pass deadline.
- **Checks.** The job refuses to vote if the Voter's epoch lags the calendar, which means the minter was not updated.
  After a vote, it reads the Voter at the receipt's block and logs what it recorded.

## Dependencies

| Dependency | Used for | On failure |
|---|---|---|
| Base RPC | Reads, simulation, sending | The first URL gets 3 s per call, the others 5 s with retries. The public node is throttled and only covers the day-before pass reliably. |
| [DefiLlama](https://defillama.com/docs/api) prices | USD value of rewards | Three tries within the pass deadline, then the last prices, else the pass fails. Unpriced tokens count as zero and are logged. |
| Cloud KMS | One signature per vote | The pass fails. A signature that does not recover to `KEEPER` is rejected before sending. |
| Cloud Scheduler | Starting the job | No pass that day. The alert does not cover it. |
| ETH balance of `KEEPER` | Gas | The job refuses to vote and says so. |
| Hydrex's minter | Epoch start | If the epoch lags the calendar, the job refuses to vote. |

## Development

You need Node 26. Run `npm ci`, `npm run typecheck` and `npm test`.

`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URL=… npm run dry-run` runs one pass against Base without
KMS. It stops after the simulation and logs what it would sign.

`test/sh/golden.sh` runs every script in `sh/` against a fake `gcloud` and compares the calls and output with
`test/sh/golden/`. Pass `--update` after an intended change.

`src/kms.ts` signs, `src/vote.ts` is the only place that builds and sends a transaction, and `src/select.ts` is the
strategy. Each IAM policy is written in full from its template in `policy/`. Logs are JSON lines.

## Limitations

- The expected reward assumes other voters stay put; the late passes correct for them moving.
- Prices come from a single source.
- The last pass is 5 seconds before the flip. Pre-signing one transaction per candidate would allow a later one.
- Claiming, swapping and distributing rewards are not implemented yet.

## License

MIT.
