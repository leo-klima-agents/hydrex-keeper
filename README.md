# hydrex-keeper

A Cloud Run job that casts the weekly votes of Hydrex's "Carbon Impact" conduit and the
[hydrex-conduit](https://github.com/ldeso/hydrex-conduit) on Base, claims their rewards, and tops up their signing keys
with ETH from the treasury after each epoch flip.

The keys are HSM keys from [hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key). The Klima conduit's
transactions go through the Safe module of [hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor).
The job is in `src/`, the tokens it counts and claims are in `tokens.json`, and the scripts that set up, deploy and
check its Google Cloud project are in `sh/`, with the IAM policies they apply in `policy/`.

## How it works

The job votes and claims for two conduits on the same Voter, each with a key of its own:

|                        | Klima conduit                                  | Immutable conduit                                         |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Contract               | `KlimaVeTokenConduit`                          | `ImmutableVeTokenConduit`                                 |
| Key                    | the keeper, its Safe module's `KEEPER`         | the proposer                                              |
| Votes and claims go to | its Safe module, `KlimaVeTokenConduitExecutor` | the conduit itself                                        |
| Who can vote for it    | the keeper only                                | anyone                                                    |
| Check on chain         | none                                           | a vote must beat the vote in force by $1 on its own score |
| Pools per vote         | at most 40, for gas                            | at most 20, the conduit's limit                           |
| Claims                 | swaps rewards to kVCM, retires part, pays out  | pays out rewards as they are, minus a 1% fee              |
| ETH for its key        | from the immutable conduit's treasury          | from its treasury                                         |

Hydrex epochs flip on Thursdays at 00:00 UTC, and votes don't carry over. Cloud Scheduler starts the job on Tuesdays and
Wednesdays at 23:50 UTC.

- **Tuesday:** the job tops up both keys, then votes for each conduit a day before the flip. That vote splits the votes
  in proportion to each pool's rewards, and stays in place if anything goes wrong later.
- **Wednesday:** the job votes for each conduit again in the last two seconds before the flip, for the largest expected
  reward. `x` votes on a pool that has `V` votes from others and `usd` of rewards earn `usd × x / (V + x)`. Base makes
  five blocks a second, but the Voter takes one vote per conduit per second. So the job votes in each of the last two
  seconds, in that second's middle block, so that a vote that lands up to two blocks late still counts. Base puts a
  transaction in the block being built when it arrives, so the job reads the votes in the latest block and sends each
  vote as its block starts being built, about 0.2 s before the block's time. It only replaces a vote in force when the
  new one earns at least $1 more. After the flip, it checks that the votes landed, logs where they landed and every vote
  cast in the last 10 seconds, then claims.

Rewards are this epoch's bribes and fees in pools with a live gauge, counted only in the tokens of `tokens.json` and
priced in USD. A vote leaves out pools that would get under 0.1% of the votes, and keeps at most the conduit's number of
pools: a Base transaction can use at most 16.8M gas, and each pool adds some.

The two conduits vote independently, and a failure of one doesn't stop the other. A conduit without voting power this
epoch gets no vote, and the job logs a warning. A failed run exits non-zero, which emails `ALERT_EMAIL`, and Cloud Run
retries it up to three times. A retry only does what is still due. It doesn't vote again for a conduit whose day-before
vote is already on chain.

### The immutable conduit's score

Anyone can propose a vote to the immutable conduit, but it only accepts one that beats the vote in force by $1 on its
own score. That score counts WETH, cbBTC, USDC and EURC at Chainlink prices, plus some trading fees. The job picks votes
at its own prices, then checks the conduit's score before sending, aiming for $1.10. If its best vote falls short, it
sends the best vote that clears the bar, as long as that still earns at least $1 more than the vote in force.

That check is the one thing that orders the two conduits' votes. In the last blocks, both votes come from the same read
of the votes. The immutable conduit's vote is decided against the votes in force, since it must clear the check
whichever lands first, and it is also checked after the Klima conduit's vote. The Klima conduit's vote counts the
immutable conduit's. On Tuesday, the immutable conduit votes after the Klima conduit's vote is in, for the same reason.
Voting for both costs each conduit about 1–2% of its rewards, as any well-run conduit voting for the same pools would.

### Claims

After each flip, the job claims for the veNFTs that were delegated to each conduit when the ended epoch began and that
allow the conduit to claim for them.

- **Klima conduit:** each `claimSwapAndDistribute` collects one veNFT's rewards, swaps them to kVCM through KyberSwap
  with up to 5% slippage, retires about a third of the kVCM as carbon credits, and sends the rest to the owner. The
  Klima Foundation's veNFTs are skipped for now (`excludedOwners` in `TRAITS`, `src/chain.ts`).
- **Immutable conduit:** each `claim` sends one veNFT's rewards to the owner as they are, minus a 1% fee to its
  treasury.

A claim only takes rewards in the tokens of `tokens.json`, from pools the conduit voted for in the last 12 epochs. It is
only sent if it collects at least $5 and its gas costs at most 5% of that. Claims run one at a time per conduit, largest
first, within the hour after the flip. A conduit's claims stop when a claim would leave its key with less than 0.001
ETH, which is kept for votes, or when a transaction the run sent from that key may still land.

### Top-ups

The Tuesday run first tops up both keys to 0.003 ETH each. The money comes from the immutable conduit's treasury, a Safe
whose Allowance Module (version 1.0.0) lets the proposer draw a weekly amount of USDC (`FUNDER` in `src/topup.ts`).

The proposer sends every top-up transaction. It draws the USDC both keys need, swaps it to ETH through whichever pays
more of Uniswap v3's 0.05% pool or Aero's Slipstream pools with tick spacings 100 and 50, and sends the keeper its
share. The swap is quoted before anything is drawn and again just before it is sent. It isn't made if it would pay more
than 2% under the job's prices. When the allowance or the treasury can't cover both keys, they end up even. Amounts
under 1 USDC or 0.0001 ETH wait for a later week.

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
- **Klima conduit:**
  - **`KLIMA_MODULE`:** [`0x750973E0CB728C3112561Bc8E9b235afA9B17E81`][module], `KlimaVeTokenConduitExecutor`, which
    names the conduit and its keeper.
  - **Keeper:** [`0x625CF6663d9D090535FBd57680bFFE6fA0262434`][keeper], the Cloud KMS HSM key `hydrex-keeper-v1`,
    version 1 (`KLIMA_KMS_KEY_VERSION`).
- **Immutable conduit:**
  - **`IMMUTABLE_CONDUIT`:** [`0x692c323B425A9DfeebE302F56168a7798D93EAC5`][immutable], `ImmutableVeTokenConduit`.
  - **`IMMUTABLE_PROPOSER`:** [`0x52c139f60452B93e1211F116BD43B28d7AfC2bCa`][proposer], the Cloud KMS HSM key
    `hydrex-proposer-v1`, version 1 (`IMMUTABLE_KMS_KEY_VERSION`).
  - **Treasury:** [`0x450c72de8c0079B49AcedF294a13011bd09D125B`][treasury], a 2-of-3 Safe. Its Allowance Module,
    [`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`][allowance], lets the proposer draw 10 USDC a week, reset on Mondays
    at 00:00 UTC.
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

1. **Configure.** Copy `config.env.example` to `config.env` and fill in `KEEPER_PROJECT`, `KLIMA_KMS_KEY_VERSION`,
   `IMMUTABLE_KMS_KEY_VERSION` and `ALERT_EMAIL`.
2. **Create the resources.** `sh/setup.sh` enables the APIs, and creates the service accounts, the secrets and the
   alerts. It prints the job's service account.
3. **Grant the keys.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`. Its
   `sh/check.sh` confirms that the service account can sign with both keys.
4. **Add the secrets.** `sh/setup.sh` prints the command for each: your Base RPC URLs, separated by commas, and an
   Alchemy API key. Public RPCs are tried after yours.
5. **Fund the keys.** Send ETH on Base to the keeper and the proposer. 0.01 ETH lasts each of them a few months, and the
   proposer needs some ETH before it can pay for its first top-up.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build, and deploys the job and its schedule. Run it again
   after any change to `src/` or `tokens.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs the Tuesday run right away: it simulates the top-up and signs the vote
   with KMS, but sends nothing. `sh/run.sh --dry-run --claim` does the same for the claims. Without `--dry-run`, both
   are refused while a scheduled run could be sending, and `--claim` also when one could start within the hour. The logs
   are in Cloud Run.

For top-ups, the treasury's owners must enable the Allowance Module, add the proposer as a delegate with a weekly USDC
allowance, and keep some USDC in the Safe.

## Checks

`sh/check.sh` compares the live project with `config.env` and `policy/` without changing anything. It also fails if the
keeper or the proposer holds less than 0.002 ETH.

The `check` workflow runs it every Friday and on demand. It signs in through Workload Identity Federation as the service
account named by the `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` repository variables. It takes its config from
`config.env.example`, with the repository variables named there in place of its values. Set at least `KEEPER_PROJECT`,
`KLIMA_KMS_KEY_VERSION`, `IMMUTABLE_KMS_KEY_VERSION` and `ALERT_EMAIL`, which have no value there. A missing one fails
the run with "… is not set in ./repository-variables.env".

Two things are outside the scripts. Enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project,
because `check.sh` only detects keys. And change `tokens.json` through a pull request, then redeploy.

## Failure modes

- **RPCs:** a read that fails or takes more than 250 ms is also sent to the next URL. Transactions go to every URL.
- **Prices:** a price is the median of the sources' quotes, or the lower of two. A token without a price counts as zero.
  If every source fails, the job reuses the last prices it fetched for the same tokens.
- **Balances:** a key that can't pay for a vote, a claim or a top-up logs `fund the Klima conduit's keeper` or
  `fund the immutable conduit's proposer`. A vote before the last blocks needs twice its maximum cost, and a claim needs
  its cost plus 0.001 ETH.
- **Claims:** claims that fail or don't finish within the hour fail the run. The next week's claims, or
  `sh/run.sh --claim`, take what is left.
- **Top-ups:** a top-up that fails, for example on `fund the immutable conduit's proposer` or on a swap quoted more than
  2% under the prices, fails the run after the vote, and the retry tops up again. A treasury with too little USDC, or an
  allowance that is used up or missing, only logs a warning, unless a key ends with less than 0.002 ETH: then the run
  fails with the error `sh/check.sh` gives, such as `keeper 0x… holds 0.0015 ETH; fund it`.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job doesn't vote, and the claims wait for the minter
  until an hour after the flip.
- **Voting power:** a conduit without voting power this epoch gets no vote, and the job logs a warning. The other still
  votes.
- **Immutable conduit:** while Base's sequencer is down, and for an hour after, it refuses votes.
- **Cloud Scheduler:** a failed start is retried three times within five minutes and sends an alert. A paused or deleted
  schedule does neither, but `check.sh` reports it.

## Development

You need Node 26 LTS. Run `npm ci`, then `npm run typecheck`, `npm test` and `npm run format` before committing.

`npm run dry-run` runs the Tuesday run against Base without KMS, and sends nothing. `npm run dry-run-claim` does the
same for the claims. Both need `KLIMA_MODULE`, `IMMUTABLE_CONDUIT` and `IMMUTABLE_PROPOSER`, as in `config.env.example`,
and `BASE_RPC_URLS`.

`test/sh/golden.sh` runs the scripts against a fake `gcloud` and `curl` and compares their calls and output with
`test/sh/golden/`. Pass `--update` to rewrite them. CI also runs `shellcheck` and `reuse lint`, and builds the image.

## Limitations

- The expected reward assumes the other votes stay where they are. The last-block vote misses votes that land in the
  last second or so.
- A claim takes everything the chosen pools owe a veNFT, including what it earned before delegating to the conduit.
  Rewards that never add up to $5 are never claimed.
- Swaps lose more as they grow, about 4.5% for $1,000 of USDC. Each swap also raises kVCM's price for the next claims,
  so the smallest claims, which go last, get slightly less kVCM.
- Anyone can vote for the immutable conduit, and the Voter takes one of its votes per second. Someone who votes for it
  early in every second near the flip can keep the job's vote out, though each of their votes must beat the last by $1.
  The job doesn't bid against them yet.

## License

MIT, REUSE compliant.
