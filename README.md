# hydrex-keeper

A Cloud Run job that casts the weekly Hydrex vote of the Klima "Carbon Impact" conduit on Base, and claims the rewards
of the conduit's delegators after each epoch flip. It can also vote and claim for the immutable conduit of
[hydrex-conduit](https://github.com/ldeso/hydrex-conduit), and top up its two signing keys with ETH from that conduit's
treasury.

The keys are HSM keys from [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key). The Klima conduit's
transactions go through the Safe module of [hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor).
The job is in `src/`, the tokens it counts and claims are in `tokens.json`, and the scripts that set up, deploy and
check its Google Cloud project are in `sh/`, with the IAM policies they apply in `policy/`.

## How it works

Hydrex epochs flip on Thursdays at 00:00 UTC, and votes don't carry over. Cloud Scheduler starts the job on Tuesdays and
Wednesdays at 23:50 UTC.

- **Tuesday:** the job tops up its keys, then votes a day before the flip. That vote splits the votes in proportion to
  each pool's rewards, and stays in place if anything goes wrong later.
- **Wednesday:** the job votes again in the last two blocks before the flip, for the largest expected reward. `x` votes
  on a pool that has `V` votes from others and `usd` of rewards earn `usd × x / (V + x)`. It reads the votes in the
  block being built and sends each vote about 0.8 s before that block's timestamp. It only replaces the vote in force
  when the new one earns at least $1 more. After the flip, it checks that its votes landed, then claims.

Rewards are this epoch's bribes and fees in pools with a live gauge, counted only in the tokens of `tokens.json` and
priced in USD. A vote leaves out pools that would get under 0.1% of the votes, and keeps at most 40 pools, because each
pool adds gas and a Base transaction can use at most 16.8M.

A failed run exits non-zero, which emails `ALERT_EMAIL`, and Cloud Run retries it up to three times. A retry only does
what is still due. It doesn't vote again for a conduit whose day-before vote is already on chain.

### The immutable conduit

With `CONDUIT` set, the job also votes for the immutable conduit, at the same times and in the same way, with at most 20
pools per vote. The proposer key signs these votes and sends them straight to the conduit.

Anyone can propose a vote to this conduit, but it only accepts one that beats the vote in force by $1 on its own score.
That score counts WETH, cbBTC, USDC and EURC at Chainlink prices, plus some trading fees. The job picks votes at its own
prices, then checks the conduit's score before sending, aiming for $1.10. If its best vote falls short, it sends the
best vote that clears the bar, as long as that still earns at least $1 more than the vote in force.

The two conduits vote independently, and a failure of one doesn't stop the other. The immutable conduit's vote is
checked after the Klima conduit's vote too, so that it passes whichever lands first. Voting for both costs the Klima
conduit about 1–2% of its rewards, as any well-run conduit voting for the same pools would.

### Claims

After each flip, the job claims for the veNFTs that were delegated to the conduit when the ended epoch began and that
allow the conduit to claim for them.

- **Klima conduit:** each `claimSwapAndDistribute` collects one veNFT's rewards, swaps them to kVCM through KyberSwap
  with up to 5% slippage, retires about a third of the kVCM as carbon credits, and sends the rest to the owner. The
  Klima Foundation's veNFTs are skipped for now (`EXCLUDED_OWNERS` in `src/claim.ts`).
- **Immutable conduit:** its `claim` sends the rewards to the owner as they are, minus a 1% fee to its treasury.

A claim only takes rewards in the tokens of `tokens.json`, from pools the conduit voted for in the last 12 epochs. It is
only sent if it collects at least $5 and its gas costs at most 5% of that. Claims run one at a time per conduit, largest
first, within the hour after the flip. A conduit's claims stop when a claim would leave its key with less than 0.001
ETH, which is kept for votes, or when another transaction of that key is pending.

### Top-ups

With `CONDUIT` set, the Tuesday run first tops up the keeper and the proposer to 0.003 ETH each. The money comes from
the immutable conduit's treasury, a Safe whose Allowance Module (version 1.0.0) lets the proposer draw a weekly amount
of USDC.

The proposer sends every transaction. It draws the USDC both keys need, swaps it to ETH through whichever pays more of
Uniswap v3's 0.05% pool or Aero's Slipstream pools with tick spacings 100 and 50, and sends the keeper its share. The
swap is quoted before anything is drawn and again just before it is sent. It isn't made if it would pay more than 2%
under the job's prices. When the allowance or the treasury can't cover both keys, they end up even. Amounts under 1 USDC
or 0.0001 ETH wait for a later week.

## Security

- **The keys never leave the HSM.** Cloud KMS signs, and a signature that doesn't recover to the key's address is never
  sent. The job's service account is the only signer of both keys, and has no role in its own project beyond reading its
  secrets.
- **The keeper key can do more than the job does.** As the module's `KEEPER`, it can vote for any pool and call
  `claimSwapAndDistribute` with any swap the conduit's routers accept. Anyone who can run code as the job's service
  account, such as an owner of the keeper project, can do the same.
- **The proposer key can draw from the treasury.** Whoever can sign with it can take the weekly USDC allowance, to any
  address, but no more. Beyond that, it can only do what any account can do with the immutable conduit.
- **The rest is checked on chain.** The module checks the caller. The conduit and the Voter check gauges, voting power
  and the epoch. For a claim, the conduit also checks that the veNFT allows it, and that each swap goes through a router
  it approves and buys a token it pays out.

## Deployment

- **Network:** Base.
- **`MODULE`:** [`0x750973E0CB728C3112561Bc8E9b235afA9B17E81`][module], `KlimaVeTokenConduitExecutor`.
- **`KEEPER`:** [`0x625CF6663d9D090535FBd57680bFFE6fA0262434`][keeper], the Cloud KMS HSM key `hydrex-keeper-v1`,
  version 1.
- **`CONDUIT`:** [`0x692c323B425A9DfeebE302F56168a7798D93EAC5`][immutable], `ImmutableVeTokenConduit`, version 2.
- **`PROPOSER`:** [`0x52c139f60452B93e1211F116BD43B28d7AfC2bCa`][proposer], the Cloud KMS HSM key `hydrex-proposer-v1`,
  version 1.
- **Treasury:** [`0x450c72de8c0079B49AcedF294a13011bd09D125B`][treasury], a 2-of-3 Safe. Its Allowance Module,
  [`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`][allowance], lets `PROPOSER` draw 10 USDC a week, reset on Mondays at
  00:00 UTC.
- **Routers:** Uniswap's SwapRouter02, [`0x2626664c2603336E57B271c5C0b26F421741e481`][uniswap], and Aero's Slipstream
  SwapRouter, [`0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418`][aero].

[module]: https://basescan.org/address/0x750973E0CB728C3112561Bc8E9b235afA9B17E81
[keeper]: https://basescan.org/address/0x625CF6663d9D090535FBd57680bFFE6fA0262434
[immutable]: https://basescan.org/address/0x692c323B425A9DfeebE302F56168a7798D93EAC5
[proposer]: https://basescan.org/address/0x52c139f60452B93e1211F116BD43B28d7AfC2bCa
[treasury]: https://basescan.org/address/0x450c72de8c0079B49AcedF294a13011bd09D125B
[allowance]: https://basescan.org/address/0x691f59471Bfd2B7d639DCF74671a2d648ED1E331
[uniswap]: https://basescan.org/address/0x2626664c2603336E57B271c5C0b26F421741e481
[aero]: https://basescan.org/address/0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418

## Setup

You need `gcloud`, `jq` and `curl`. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the keeper project.
`sh/check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`. All scripts are safe
to run again.

1. **Configure.** Copy `config.env.example` to `config.env` and fill in `KEEPER_PROJECT`, `KMS_KEY_VERSION`,
   `PROPOSER_KMS_KEY_VERSION` and `ALERT_EMAIL`. To vote for the Klima conduit only, leave `CONDUIT`, `PROPOSER` and
   `PROPOSER_KMS_KEY_VERSION` empty.
2. **Create the resources.** `sh/setup.sh` enables the APIs, and creates the service accounts, the secrets and the
   alerts. It prints the job's service account.
3. **Grant the keys.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`.
4. **Add the secrets.** `sh/setup.sh` prints the command for each: your Base RPC URLs, separated by commas, and an
   Alchemy API key. Public RPCs are tried after yours.
5. **Fund the keys.** Send ETH on Base to `KEEPER` and `PROPOSER`. 0.01 ETH lasts each of them a few months, and the
   proposer needs some ETH before it can pay for its first top-up.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build, and deploys the job and its schedule. Run it again
   after any change to `src/` or `tokens.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs the Tuesday run right away: it simulates the top-up and signs the vote
   with KMS, but sends nothing. `sh/run.sh --dry-run --claim` does the same for the claims. Without `--dry-run`, both
   are refused while a scheduled run could be sending, and `--claim` also when one could start within the hour. The logs
   are in Cloud Run.

To add the immutable conduit to a deployment that only votes for the Klima conduit, set `CONDUIT`, `PROPOSER` and
`PROPOSER_KMS_KEY_VERSION` in `config.env` and in the `check` workflow's repository variables, fund `PROPOSER`, and run
`sh/deploy.sh`. hydrex-keeper-key's `sh/check.sh` confirms that the job's service account can sign with the proposer
key. For top-ups, the treasury's owners must also enable the Allowance Module, add `PROPOSER` as a delegate with a
weekly USDC allowance, and keep some USDC in the Safe.

## Checks

`sh/check.sh` compares the live project with `config.env` and `policy/` without changing anything. It also fails if the
keeper or the proposer holds less than 0.002 ETH.

The `check` workflow runs it every Friday and on demand. It signs in through Workload Identity Federation as the service
account named by the `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` repository variables, and builds `config.env` from the
repository variables named in `config.env.example`. Set at least `KEEPER_PROJECT`, `KMS_KEY_VERSION` and `ALERT_EMAIL`.

Two things are outside the scripts. Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project,
because `check.sh` only detects keys. And change `tokens.json` through a pull request, then redeploy.

## Failure modes

- **RPCs:** a read that fails or takes more than 250 ms is also sent to the next URL. Transactions go to every URL.
- **Prices:** a price is the median of the sources' quotes, or the lower of two. A token without a price counts as zero.
  If every source fails, the job reuses the last prices it fetched for the same tokens.
- **Balances:** a key that can't pay for a vote or a claim logs `fund the keeper` or `fund the proposer`. A vote before
  the last blocks needs twice its maximum cost, and a claim needs its cost plus 0.001 ETH.
- **Claims:** claims that fail or don't finish within the hour fail the run. The next week's claims, or
  `sh/run.sh --claim`, take what is left.
- **Top-ups:** a top-up that fails, for example on `fund the proposer`, on a treasury with too little USDC, or on a swap
  quoted more than 2% under the prices, fails the run after the vote, and the retry tops up again. An allowance that is
  used up or missing only logs a warning.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job doesn't vote, and the claims wait for the minter
  until an hour after the flip.
- **Klima conduit:** without voting power, it gets no vote and the run fails. The immutable conduit still votes.
- **Immutable conduit:** without voting power, it gets no vote and the job logs a warning. While Base's sequencer is
  down, and for an hour after, it refuses votes. A misconfigured or unreachable `CONDUIT` is left out and fails the run,
  and the Klima conduit votes and claims anyway.
- **Cloud Scheduler:** a failed start is retried three times within five minutes and sends an alert. A paused or deleted
  schedule does neither, but `check.sh` reports it.

## Development

You need Node 26. Run `npm ci`, then `npm run typecheck`, `npm test` and `npm run format` before committing.

`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URLS=… npm run dry-run` runs the Tuesday run against Base
without KMS, and sends nothing. `npm run dry-run-claim` does the same for the claims. Set `CONDUIT` and `PROPOSER` too
to include the immutable conduit and the top-up.

`test/sh/golden.sh` runs the scripts against a fake `gcloud` and `curl` and compares their calls and output with
`test/sh/golden/`. Pass `--update` to rewrite them. CI also runs `shellcheck` and `reuse lint`, and builds the image.

## Limitations

- The expected reward assumes the other votes stay where they are. The last-block vote misses votes sent in the last 2
  seconds or so.
- A claim takes everything the chosen pools owe a veNFT, including what it earned before delegating to the conduit.
  Rewards that never add up to $5 are never claimed.
- Swaps lose more as they grow, about 4.5% for $1,000 of USDC. Each swap also raises kVCM's price for the next claims,
  so the smallest claims, which go last, get slightly less kVCM.
- Anyone can vote for the immutable conduit, and the Voter takes one of its votes per block. Someone who votes for it in
  every block near the flip can keep the job's vote out, though each of their votes must beat the last by $1. The job
  doesn't bid against them yet.

## License

MIT, REUSE compliant.
