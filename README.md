<!--
SPDX-FileCopyrightText: 2026 Léo de Souza
SPDX-License-Identifier: MIT
-->

# hydrex-keeper

The Hydrex keeper is a Cloud Run job that casts one on-chain vote a week on Base for the Klima "Carbon Impact"
conduit. It signs with the HSM key defined by [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and
calls `vote` on [hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), the Safe module that
accepts that key and forwards to Hydrex's Voter. This repo holds the job (`src/`), the whitelist of pools it may vote
for (`pools.json`), and the scripts that create its Google Cloud project resources and check them for drift (`sh/`).

Cloud Scheduler starts the job twice a week: Tuesday 23:50 UTC and Wednesday 23:40 UTC. Each execution runs the
passes due within the following hour: one 24 hours before the Thursday 00:00 UTC flip, then a geometric series at
600, 200, 70, 25, 10 and 5 seconds before it. A pass reads this epoch's bribes and fees for every whitelisted pool,
prices them, and votes for the pool that would pay the conduit the most. Votes do not carry over between epochs, so
the first pass always votes; later passes only send a transaction if the best pool changed. Claiming and swapping
rewards is not implemented yet.

## What it can and cannot do

- **Can:** call `vote` on the module with pools from `pools.json`, at the times in `VOTE_OFFSETS`. That is the entire
  effect of a compromised keeper: a suboptimal vote within the whitelist. The module, the conduit and the Voter enforce
  everything else (single caller, gauge liveness, voting power, epoch timing).
- **Cannot:** claim, swap, move funds, call any other contract, or read the private key. It asks Cloud KMS to sign
  one hash per vote; the key never leaves the HSM. The job's service account has no role in its own project beyond
  reading the RPC URL, and nothing in the project can impersonate it.

## Prerequisites

`gcloud`, `jq`. Node 24 for development. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the keeper project;
`sh/check.sh` needs `roles/viewer` plus `roles/iam.securityReviewer` and `roles/secretmanager.viewer`.

## 1. Configure

```sh
cp config.env.example config.env
```

Fill in `KEEPER_PROJECT` (a project that holds nothing else), `KMS_KEY_VERSION` (`version` from the key repo's
`record/keeper.json`) and `ALERT_EMAIL`. The defaults for the rest match the deployed module and the sibling repos.
Every script checks that each `VOTE_OFFSETS` entry falls strictly within the hour after some `SCHEDULES` entry (which
must be of the form `M H * * D`), since an execution only runs the passes due within that hour.

## 2. Create the project resources

```sh
sh/setup.sh
```

Enables the APIs, creates the two service accounts (`hydrex-keeper` runs the job and is the only principal allowed to
sign; `hydrex-keeper-scheduler` may only start the job), creates the RPC secret with the keeper as its only reader, and
creates the email channel and the alert that fires when an execution fails. Safe to re-run. It prints the keeper's
service account email for the next step.

## 3. Grant the keeper

In hydrex-keeper-key, set `KEEPER_SA` to that email and run `sh/grant.sh`. That is the one cross-project binding.

## 4. Add the RPC URL

```sh
printf '%s' 'https://…' | gcloud secrets versions add base-rpc-url --project=KEEPER_PROJECT --data-file=-
```

Several URLs separated by commas are tried in order; the public `https://mainnet.base.org` is always the last resort.
The public node throttles the job's bursts of calls for tens of seconds at a time, so a second paid provider in the
secret is what makes the final passes robust to a primary outage.

## 5. Fund the keeper

Send ETH on Base to `KEEPER` (`0x625CF6663d9D090535FBd57680bFFE6fA0262434`, from the key repo's record). A vote costs
a few thousandths of a cent; 0.005 ETH lasts years. The job refuses to vote with less than twice the estimated cost,
L1 data fee included.

## 6. Deploy

```sh
sh/deploy.sh
```

Builds the image from this checkout with Cloud Build (`Dockerfile`: distroless Node 24, no shell, non-root, both
images pinned by digest), deploys the job with the RPC secret and the config as environment, sets the job's IAM so
only the scheduler account can start it, and creates or updates one Cloud Scheduler job per entry of `SCHEDULES`
(`hydrex-keeper-1`, `hydrex-keeper-2`), deleting any `hydrex-keeper*` scheduler job no longer listed. Safe to re-run;
re-run it after any change to `src/` or `pools.json`.

## 7. First vote, watched

```sh
sh/run.sh --dry-run --now   # reads, prices, selects, simulates, signs with KMS; sends nothing
sh/run.sh --now             # votes now, unless this epoch already has a vote for the best pool
```

Read the execution's logs in Cloud Run. The dry run proves the whole path including that the KMS key recovers to
`KEEPER`. During the real vote, watch `Voter.poolVote(CONDUIT, 0)` and `Voter.votes(CONDUIT, pool)`; the job checks
both after the receipt and logs them. Without `--now` the job runs the passes due within the next hour, if any.

## 8. Check for drift

```sh
sh/check.sh
```

Read-only. Fails if the job's service account, environment, secret reference, timeout, retries or IAM differ from
`config.env` and `policy/`; if a schedule, its target, its service account or its state differ, or a stale scheduler
job remains; if the secret has no
enabled version or extra readers; if the keeper's service account has a user-managed key, any IAM binding on itself
(impersonation) or any project-level role; or if the alert is missing, disabled, or not pointed at `ALERT_EMAIL`.

CI runs it every Friday after the vote, and on demand from the Actions tab, exactly like the key repo: a viewer-only
service account in the keeper project (`roles/viewer`, `roles/iam.securityReviewer`, `roles/secretmanager.viewer`),
a Workload Identity Federation pool and GitHub OIDC provider restricted to this repository, and repository variables
`KEEPER_PROJECT`, `REGION`, `JOB`, `KEEPER_SA_NAME`, `SCHEDULER_SA_NAME`, `KMS_KEY_VERSION`, `MODULE`, `VOTE_OFFSETS`,
`SCHEDULES`, `RPC_SECRET`, `ALERT_EMAIL`, `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT`. All public material.

## How it votes

Everything on-chain is derived from `MODULE`: its `CONDUIT` and `KEEPER`, the conduit's `voter` and `veToken`.

For each pool in `pools.json` the job reads the gauge (a pool without one is skipped), whether it is alive, its votes
this epoch, and this epoch's `rewardsPerEpoch` of every token in its external bribe (bribes) and internal bribe
(trading fees) contracts, then prices the tokens in USD. Bribes notified during an epoch are keyed to that epoch on
Hydrex's `BribeV2`, which is what the job reads. With `v` the conduit's voting power at epoch start and `V` the pool's votes from others,
voting everything for one pool is expected to pay `usd × v / (V + v)`. The pool with the largest value wins; ties keep
whitelist order; if nothing pays, the current vote is kept. `src/select.ts` is this function and nothing else, so a
different strategy (water-filling across several pools) replaces one file.

Re-voting is safe: Hydrex's `VOTE_DELAY` is zero and `vote` resets before recasting, so each pass just recomputes.
The Voter keeps last epoch's `poolVote` and `votes` until that reset, so the job treats them as absent unless
`lastVoted` falls in the current epoch.
Voting at or after the flip reverts (`EpochFlipInProgress`, `EpochStale`), so a late pass fails instead of voting
into the wrong epoch. A pass that is already overdue when its turn comes (an earlier pass waited on a slow receipt)
is skipped; the receipt wait itself is bounded by the next pass, and a vote whose receipt has not arrived by then is
left for the next pass to observe on the Voter. Each pass retries up to three times while there is time before the
next one. A pass that fails for good makes the job exit non-zero, which fires the alert; Cloud Run restarts a crashed
job up to three times, and the restart recomputes the remaining passes from the clock: a pass missed within the past
hour runs right away, a restart within an hour after the flip exits cleanly. A vote is sent with the account's
confirmed nonce; if the previous vote is still pending under that nonce and this process sent it, the new one pays a
quarter more and replaces it, and if it came from an earlier process the new one queues behind it. Nothing is
broadcast once the pass's deadline has passed. After a send, the retry loop re-sends only when the receipt shows an
earlier vote won the nonce; a vote that was mined but reverted or recorded differently, or whose outcome could not be
read, is left to the next pass. A Voter whose epoch lags the calendar by more than an hour (minter not
updated) fails the execution at startup and at every pass. "Already voted" means the Voter holds the desired pools
with the weights it would derive, so a strategy that splits weights is compared correctly too.

The offsets (`VOTE_OFFSETS`) shrink geometrically towards the flip so that most of the information arrives late and
few transactions are sent: a vote only goes out when the winner changes. To keep the last passes short, an execution
reads gauges, bribe contracts and reward tokens once (re-reading them if a bribe contract gains a token), reuses
prices younger than thirty minutes (keeps serving them if DefiLlama fails or fewer than twenty seconds remain, and
never retries past the pass deadline), and then needs two round trips for the epoch state and one for the pools
before signing; a pass measures under a second, and Base blocks are two seconds apart, so the last offset of five
seconds leaves the transaction a block of margin. The primary RPC gets three seconds per call before the public
fallback is tried; the public node throttles bursts of calls, so its retries back off by seconds. After a vote the Voter is read at
the receipt's block, so a lagging fallback node cannot report it missing.

## External dependencies and failure modes

| Dependency | Used for | On failure |
|---|---|---|
| Base RPC (`BASE_RPC_URL`, one or more URLs, then `https://mainnet.base.org`) | All reads, simulation, sending | Each URL gets three seconds per call before the next; the public node throttles bursts for tens of seconds, so it only reliably covers the day-before pass. If all fail the pass fails and is retried |
| [DefiLlama](https://defillama.com/docs/api) `coins.llama.fi`, no key | USD prices of reward tokens | Three attempts within the pass deadline, then prices from the last half hour are reused, else the pass fails. A token it does not price counts as zero and is logged; if no token at all can be priced the pass fails. A wrong price can only move the vote within the whitelist. A second price source may be added later for redundancy |
| Cloud KMS `asymmetricSign` via the service account's metadata token | The one signature per vote | Pass fails. A signature that does not recover to `KEEPER` is rejected before sending |
| Cloud Scheduler | Starting the two executions | No pass that day; the alert covers failed executions, not absent ones (see below) |
| ETH balance of `KEEPER` on Base | Gas | Job refuses to vote below twice the estimated cost and says so |
| Hydrex's minter | Epoch timestamp | If `_epochTimestamp()` lags the calendar epoch, the job refuses to vote |

## Outside the scripts

1. Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project. `check.sh` only detects a key.
2. The alert covers failed executions. Add one for absent executions (`run.googleapis.com/job/completed_execution_count`
   absent for eight days) if a missed schedule must be noticed.
3. Keep the keeper's ETH balance topped up; the dry run reports the cost of a vote.
4. `pools.json` is the policy. Change it by pull request and redeploy.

## Development

`npm ci`, then `npm run typecheck` and `npm test` (unit tests: selection, DER and low-s handling with a throwaway key
and a stubbed KMS, price parsing and caching, reward mapping against a fake client, pass scheduling). `MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81
BASE_RPC_URL=… npm run dry-run` runs a full pass against Base without a metadata server: it stops after simulating
and estimating, logging what it would have signed.

`test/sh/run.sh` runs every script under `dash` against a fake `gcloud` and diffs the calls and output against
`test/sh/golden/`; `--update` regenerates after an intended change. CI runs `shellcheck -s sh`, `sh -n`, `reuse lint`,
the Node checks, the golden tests and a Docker build on every push. CI reads, never writes: the scheduled `check`
job is the only one with GCP access, through a viewer-only service account. Actions are pinned by commit and updated
by Dependabot, as are npm packages and base images.

## Reviewing

- `src/` is the whole runtime; `viem` is its only dependency. `src/kms.ts` is the signing path; `src/vote.ts` the only
  place a transaction is built and sent; `src/select.ts` the strategy.
- `sh/` and `policy/` are the whole cloud surface. Each IAM policy is written in full from its template.
- Logs are JSON lines; every pass logs each candidate's rewards, votes and USD value, the decision, and the recorded
  vote after a transaction.

## Known limitations

- One pool, all voting power. Water-filling across the whitelist is the planned next strategy.
- No claiming or swapping of rewards yet.
- Prices come from one source and are trusted for ranking only.
- The last pass is five seconds before the flip. Pre-signing one transaction per candidate and broadcasting the
  chosen one after a final read would allow a later one.

## License

MIT, REUSE compliant.
