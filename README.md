# lokal (lkl.berlin) and Circles: what the app actually does

An analysis of **lokal**, the Kreuzberg neighbourhood-rewards app built by Paul Boes, and how it uses the
[Circles](https://aboutcircles.com) protocol on Gnosis Chain. The app's source code is not public. The
findings below come from decompiling the two shipped clients and checking the result against the chain.

Snapshot date: **7 October 2026** (Gnosis Chain block 48,636,816).

## Short answers

| Question | Answer |
|---|---|
| **Kreuzer vs CRC** | Kreuzer *are* Circles v2 CRC, 1 Kreuzer = 1 CRC. The balance shown is the user's personal CRC plus their holdings of the Kiez group token (`KIEZ0`) plus CRC they could mint now. "1 Kreuzer an hour for two weeks, then it pauses" is Circles' standard personal issuance (1 CRC/hour, claimable for at most 2 weeks). Spending converts personal CRC into `KIEZ0` and sends that to the shop. The app never says "Circles", "CRC" or "wallet" to normal users. |
| **How lokal uses Circles** | Each user gets a Safe smart account (ERC-4337, gas paid by lokal). In one transaction it is registered as a Circles **human** through lokal's invitation bot and made a member of lokal's Circles **group**. After that the app calls the Hub directly: `personalMint`, `groupMint`, `safeTransferFrom`, and `stop`/`burn` when an account is deleted. A backend at `api.lkl.berlin` gates all of this with location/QR "proofs" and signed permits. |
| **Public groups** | There is one Circles v2 **BaseGroup per Kiez**. In production it is named "Psst", symbol `KIEZ0`, with 289 members. It is public on-chain and in the Circles indexer, and its profile says `groupType: "open"`. **Joining is not open, though**: the group only accepts members carrying a signature from lokal's backend. The app has no group UI at all. |
| **Trust between users** | **There is none.** Neither client ever calls `trust()`. On-chain, no member trusts another member (0 of 289). Every trust edge pointing at a member comes from lokal or Circles infrastructure: the group, its mint handler, the group mint router, the invitation module, and lokal's invite bots. Location proofs replace the web of trust as the anti-Sybil check. Transfers avoid trust altogether by using direct ERC-1155 transfers. |
| **CRC to/from self-custody** | **Not from the app.** CRC only leave an account as redemptions to a shop's till (an address the backend supplies), or in the Android app as "Send Kreuzer" to another lokal account looked up by **email**. There is no address field, no withdraw, no key export and no cash-out, and deleting an account **burns** the CRC. Inbound, there is no receive feature. A direct on-chain transfer of `KIEZ0` to a user's Safe would show up as Kreuzer. Normal Circles sends (trust-path transfers from Metri or Gnosis App) cannot reach lokal users, because they trust nobody but themselves. The Safes are owned only by keys on the user's side, so leaving with the CRC is technically possible, but only outside the app. |

## How the source was obtained

1. **Looking for a public repo: none exists.** Paul Boes is a co-author of the Circles whitepaper. His
   commits to [`aboutcircles/whitepaper-public`](https://github.com/aboutcircles/whitepaper-public) carry
   `pboes@users.noreply.github.com`, so his GitHub handle is [`pboes`](https://github.com/pboes). His 41
   public repositories include Circles mini-apps (`kudos_transactions`, `metri-inviter-team`,
   `daily-chess-puzzle`, …) but nothing for lokal, and he shows no public organisation memberships.
   GitHub repository searches for `lkl.berlin`, and searches of the `aboutcircles` org for "kiez" and
   "lokal", return nothing. Likely repo names under `pboes` and other plausible owners also don't resolve
   (`git ls-remote`).
2. **Web client.** [`app.lkl.berlin`](https://app.lkl.berlin) is a Next.js build without source maps. The
   webpack runtime lists 161 lazily loaded chunks. All of lokal's own code sits in one 343 KB chunk
   (`3339.*.js`, about 21,000 lines once pretty-printed) and the UI strings in another (`7406-*.js`).
   Module and log names (`[kiez:wallet]`, `[kiez:backup]`, …) survive minification.
3. **Android client.** `com.app.lkl.berlin` **1.0.5 (versionCode 34)**, the version the Play Store lists
   as updated 5 Oct 2026, downloaded as an XAPK from the APKCombo mirror. It is an Expo/React Native app
   (Expo slug `lkl-gnosis`, OTA updates via `u.expo.dev`) whose JavaScript ships as Hermes bytecode v98.
   [`hermes-dec`](https://github.com/P1sec/hermes-dec) decompiles it, keeping the original function names
   (`sendKreuzer`, `closeAccount`, `toTill`, …).
4. **On-chain verification.** Every contract address hard-coded in the clients was checked against
   Gnosis Chain and the Circles RPC/indexer (`rpc.aboutcircles.com`). Unverified contracts were identified
   by matching their function selectors and comparing them with the published source in
   [`aboutcircles/circles-contracts-v2`](https://github.com/aboutcircles/circles-contracts-v2) and
   [`aboutcircles/circles-invitation-at-scale`](https://github.com/aboutcircles/circles-invitation-at-scale).
   Raw numbers: [`evidence/onchain-snapshot.json`](evidence/onchain-snapshot.json).

This repository is public, so the decompiled code itself is **not committed**. It is lokal's proprietary
code, and it embeds their client-side API keys. The scripts in [`scripts/`](scripts) regenerate it in a
few minutes (see [Reproduce](#reproduce)). This report only quotes short excerpts.

## The pieces

| Role | Address | Notes |
|---|---|---|
| Circles v2 Hub | `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8` | ERC-1155 for all CRC |
| Kiez group "Psst" / `KIEZ0` | `0x75b812a7bFb0a3580b32CaF2A2C201D6e0FaC5b3` | BaseGroup, created 2026-07-22, 289 members |
| `KIEZ0` ERC-20 (demurraged wrapper) | `0xD433FDB8861E86a827C25740B07452EcDca30A67` | counted in the balance |
| Group service (membership gate) | `0x488CBD83f514aa1605e59d4e51bd36427a25E69B` | `addMember(user, deadline, sig)` only |
| lokal auto-invite bot | `0x5633eE2D9F5DB44C1658F71543CfF22BCD8f971A` | signed `invite(...)` only; `quota()` reads 1,901 |
| Legacy auto-invite bot | `0x20ec0a8a5e2209097df0a30f47106cdf3a2443a6` | unsigned `invite(address)`; `quota()` reads 0 |
| Circles InvitationModule | `0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5` | enabled on every user Safe |
| Circles InvitationFarm | `0xd28b7C4f148B1F1E190840A1f7A796C5525D8902` | pays the 96 CRC invitation fee |
| lokal operator Safe | `0x3E4fD8C6971B0b2B578c1ddA8EaeB378fBdf727c` | owns the group and the bot, collects group fees |
| lokal permit signer (EOA) | `0x627a6f3d6a627e20469058E5E4387544544E9387` | signs invite and membership permits (1 h TTL) |
| Demo/test group "LocalTestGroup" | `0xd17f726251890c603BEbA290789Ad31237C57ce2` | used on `demo.app.lkl.berlin` and preview builds |

Off-chain the clients talk to `api.lkl.berlin` (lokal's closed-source backend), Privy (email login and an
embedded wallet), Pimlico (ERC-4337 bundler and paymaster, so lokal pays the gas), and the public
Gnosis/Circles RPCs.

## 1. Kreuzer and CRC

**Kreuzer are CRC, with no exchange rate.** The web client calculates the displayed balance like this
(module `39123`, comments added):

```js
let [r, a, o, s] = await Promise.all([
  hub.balanceOf(i, BigInt(i)),        // personal CRC (ERC-1155 id = own address)
  hub.balanceOf(i, BigInt(t.group)),  // KIEZ0 group CRC (id = group address)
  erc20.balanceOf(i),                 // KIEZ0 demurraged ERC-20 wrapper
  hub.calculateIssuance(i),           // CRC that could be minted right now
]);
h = Number(r + a + o) / 1e18;         // "balance"
p = Number(c) / 1e18;                 // "pending" (unminted issuance)
// total shown = h + p, then ticks up by 1/3600 per second between refreshes
```

The amount that can actually be spent at redemption (module `98654`, `ev`) is the same sum, minus a 1/50,000
safety margin on each holding and 10⁻⁶ CRC of dust. Offer prices (`murmelnCost`, a leftover of an earlier
name, "Murmeln") are whole CRC: `BigInt(e.murmelnCost) * units * 10n ** 18n`.

**How you "collect" Kreuzer is how Circles issues CRC.** The FAQ in the Android app reads: *"Show you are in
the area and you collect 1 Kreuzer an hour for two weeks. Then it pauses until you show it again."* That is
Circles v2 personal issuance: 1 CRC per hour, claimable for at most `MAX_CLAIM_DURATION = 2 weeks`
(`Circles.sol`). The client marks minting as "paused" once `endPeriod - startPeriod >= 1209600` seconds.
After a presence proof it sends `personalMint()`, which restarts the window. The location rule is
enforced **by the app and backend only**. On-chain, issuance accrues from the moment of registration and
whoever holds an owner key can mint at any time.

**Other Circles effects that show up but aren't explained to users:**
- **Welcome bonus.** Registering through an invitation gives the newcomer Circles' 48 CRC welcome bonus
  (`WELCOME_BONUS = 48 * EXA`). 185 of the 289 member Safes hold between 47 and 48 personal CRC, which is
  that bonus after demurrage.
- **Demurrage.** All CRC, Kreuzer included, lose about 7% a year. Neither FAQ mentions it.

**Spending turns personal CRC into the group token.** At a till, the client batches `personalMint` (if
anything can be minted), then `groupMint(group, [self], [x])` (personal CRC becomes `KIEZ0` 1:1, held as
collateral by the group treasury), then `unwrap` of the ERC-20 if still short, then
`Hub.safeTransferFrom(self → till, KIEZ0, amount, annotation)`. The annotation is
`0x0100020020 ‖ keccak256("kiez-offer:<offerId>")`. So **shops receive `KIEZ0`, never anyone's personal
CRC**. In total 6,177 `KIEZ0` exist, and 6,043 of them sit in the 15 shop tills ([table below](#shop-tills)).

**The vocabulary hides Circles.** The user-facing strings (both languages, both clients) never mention
Circles, CRC, blockchain or wallets. FAQ: *"A local reward currency for Kreuzberg… They can only be spent
here… a bit like a tiny basic income."* The only "CRC" label is on the merchant till page ("received at
your till: … CRC").

## 2. How lokal interacts with the Circles protocol

**Account.** A Safe v1.4.1 with threshold 1, driven through ERC-4337 (EntryPoint 0.7, Safe4337Module
`0x75cf…c226`) and sponsored by lokal through Pimlico.
- **Web:** the owner key is generated in the browser and stored **as a raw private key in `localStorage`**
  (`kiez_owner_pk`). Backing up with an email adds a Privy embedded wallet as a second owner
  (`addOwnerWithThreshold(recoveryOwner, 1)`).
- **Android:** the Privy email wallet is the first owner ("account already deployed with its email
  owner"). A device key (`generatePrivateKey`, saved with expo-secure-store as `kiez.ownerPk`) is added
  later (`adoptDeviceOwner`).

On-chain, all 289 member Safes have threshold 1, plain-EOA owners, and exactly two modules (Safe4337Module
and the Circles InvitationModule). lokal's operator is never an owner.

**Sign-up (one sponsored UserOperation).** Once the backend has accepted a proof of presence (`POST
/proofs` with method `location`, `qr` or `poster`), it issues a permit (`POST /permits/membership`) and the
client sends:

```text
autoInviteBot.invite(safe, deadline, sig)        // registers the Safe as a Circles human (see below)
groupService.addMember(safe, deadline, sig)      // the Kiez group now trusts the Safe = membership
safe.addOwnerWithThreshold(recoveryOwner, 1)     // email/Privy recovery owner
```

The bot draws an invite from the Circles **InvitationFarm**. The farm's proxy inviter sends 96 CRC to the
**InvitationModule**, which uses its module rights on the new Safe to call `Hub.registerHuman(...)` on the
user's behalf. That is why every one of the 289 members was registered by a different "inviter" address.

**After sign-up the client calls the Hub directly:**

| User action | Calls |
|---|---|
| Collect | `personalMint()` after a presence proof |
| Redeem a deal | `[groupService.addMember]` → `personalMint` → `groupMint` → `[ERC20.unwrap]` → `safeTransferFrom` to the till. Android splits this into one leg per payee when the shop has a staff split. |
| Send Kreuzer *(Android only)* | `POST /me/send/recipient {email}` → address, then the same top-up steps → `safeTransferFrom(self → recipient, KIEZ0, amount)` |
| Delete account | `personalMint` → `stop()` (ends issuance forever) → convert personal CRC to `KIEZ0` → **`burn`** all personal and `KIEZ0` CRC → `removeOwner` for every owner → `swapOwner(…, 0x…dEaD)`. 7 Safes on-chain are already in this bricked state. |

Reads go through `Hub.isHuman/balanceOf/calculateIssuance/isTrusted`. The web client also reads profiles
from `circles_getProfileByAddress`. It writes a Circles profile (`NameRegistry.updateMetadataDigest`) only
from a lazily loaded `labelAccountAsTest` helper, which names tester accounts
`"LOKAL TEST ACCOUNT (alpha) - not a real neighbour"`.

**The backend** (`api.lkl.berlin`, not public) handles login (sign-in challenge plus Privy token), proofs,
permits, offers, the redemption log, push notifications, till splits (`/shops/:id/split`, `/me/shares`)
and the email-to-address lookup used for sends.

## 3. Groups

- **One group per Kiez.** The backend serves a list of *Kieze*, each with its own `economy`
  (`group`, `erc20`, `groupService`, `autoInviteBot`). Today there is only `kreuzberg` (Reichenberger
  Kiez). The FAQ says expansion would come *"probably with separate points per area"*.
- **The production group is public.** "Psst" (`KIEZ0`) is a standard Circles v2 BaseGroup: registered on
  the Hub, indexed, and visible to any Circles app. Its profile says `groupType: "open"` with
  `minRepScore: 0, membershipFee: 0`.
- **Membership is closed.** The group's `service` contract only has the signed
  `addMember(address,uint256,bytes)` (selector `0xb1e69ded`). The plain `addMember(address)` is not in its
  bytecode. Permits come from lokal's signer EOA and expire after 1 hour. As a result the group trusts only
  lokal users, and only lokal users' personal CRC can be minted into `KIEZ0`. The group is owned by lokal's
  operator Safe, which also receives group fees.
- **No group features in the app.** Users cannot see, create or join groups, and the word "group" never
  appears in the UI. Members are anonymous on Circles: 286 of 289 have no profile name, and the other 3 are
  labelled test accounts.

## 4. Trust

- **No user-to-user trust exists.** Neither client's own code ever sends `trust(...)`; it only reads
  `isTrusted`. On-chain, 288 of 289 members trust only themselves (Circles' automatic self-trust). The
  one exception trusts a single address that is not a member. **Member → member trust edges: 0.**
- **Incoming trust is all infrastructure:**

  | Truster | Members trusted | Why |
  |---|---|---|
  | Kiez group | 289 | this *is* membership |
  | Group mint handler `0x3c32…534d` | 289 | BaseGroup machinery |
  | BaseGroupMintRouter `0xdc28…802f` | 289 | Circles-wide routing helper for base groups |
  | InvitationModule (org) | 289 | trusts everyone it registers |
  | Legacy auto-invite bot | 182 | permanent trust left by the invitation flow |
  | Current auto-invite bot | 107 | same |

  Only the group's own treasury trusts the group back.
- **What replaces trust.** Circles normally uses the trust graph to stop fake accounts and to route
  payments. lokal replaces the first job with backend-checked presence proofs (geofence, shop QR codes,
  posters), plus email and IP rate-limit codes such as `mailbox_spent` and `ip_spent`. It avoids the second
  job entirely: redemptions and sends are direct ERC-1155 `safeTransferFrom` calls, which in Circles v2
  check only owner/approval, not trust (`ERC1155.sol`):

  ```solidity
  function safeTransferFrom(address _from, address _to, uint256 _id, uint256 _value, bytes memory _data) public {
      address sender = _msgSender();
      if (_from != sender && !isApprovedForAll(_from, sender)) revert ERC1155MissingApprovalForAll(sender, _from);
      _safeTransferFrom(_from, _to, _id, _value, _data);
  }
  ```

  The only trust check on the spending path is in `groupMint`, and there it is the **group** that must
  trust the user.

## 5. Transfers to and from self-custodial accounts

**Out of a user's account, through the app: no.**
- The **web** client only moves CRC in redemptions, to the `shop.orgAddress` the backend returns for an
  offer.
- The **Android** client adds "Send Kreuzer". The recipient field is *"To (email)"*: the backend resolves
  the email to a lokal account (`sendErrNoAccount: "No account uses that email."`), and the client sends
  `KIEZ0` to whatever address comes back.
- Neither client has an address field, a withdraw, a key or seed export (Privy's `exportWallet` is never
  called), or a cash-out. Account deletion burns the balance instead of paying it out: *"Your Kreuzer are
  gone"*.

**Into a user's account: no app feature, partly possible on-chain.**
- There is no receive screen or deposit QR. The Android settings page does show and copy the account
  address, but labelled *"for when you write to us"*.
- A direct `Hub.safeTransferFrom` of `KIEZ0`, or a transfer of the `KIEZ0` ERC-20, to a lokal Safe goes
  through, and the app **counts it as Kreuzer**. Only lokal members can mint `KIEZ0`, though, so in
  practice it comes from other lokal accounts or the tills.
- Any other CRC (someone's personal CRC, other groups' tokens) can also be sent directly, but the app
  neither shows nor spends it.
- **Standard Circles sends don't arrive.** Metri and Gnosis App send through trust paths
  (`operateFlowMatrix`), and Circles v2 only allows a path to end at a receiver who trusts the token being
  delivered (`isPermittedFlow`). Lokal users trust only themselves, so they can only receive their own
  personal CRC that way.

**Is the user's account self-custodial?** On-chain, yes: the only owners are keys on the user's side
(browser key, device key, Privy email wallet), threshold 1. The two modules can't move funds: the
InvitationModule only acts on Hub callbacks, to register an unregistered invitee or to set trust *from
inviter* Safes. So someone could, for example, take the browser key out of `localStorage` and use the Safe
from any Safe tool. The app doesn't support or mention any of this, and the Android FAQ presents the
account as *"You create it with your email only, no password and no name"*.

### Shop tills

Shop tills are plain EOAs: no contract code, not Circles avatars. They start out **custodial**. The
merchant page says *"Your shop's takings are held for you at the moment. Signing in below makes them yours:
after that, only you can move them, and nobody at lokal can."* Taking over a till links it to the
merchant's Privy wallet. For a staff split, the backend holds the payee list (*"To change it, tell
lokal"*). The customer's Android client then pays each payee directly as separate legs of the redemption
transaction, and staff see it as *"Your share of a till payment"*.

| Shop | Till | `KIEZ0` held |
|---|---|---:|
| Gästeblock | `0x4e7f83911a9e1B1568EA1518F9b2200927dDDe12` | 1195.00 |
| Darfur | `0x4C6685202EFDD13C59fDeB88D0Bd2DAbD5827dC9` | 836.80 |
| Bagel Bro | `0xf49E64a99C74cC45E21990c34480FE272648bdE9` | 794.49 |
| Dirty Dumplings | `0x01B9876bA30BfB53882E1CA86C8B9B6965d62d06` | 558.56 |
| Villa Di Wow | `0xf024E2bAfcd33B1AA09698E34469Ee5003eF9512` | 518.56 |
| Full Node | `0x65Bcf5D95B421b7541471D4e5f565C2542eF07c1` | 502.56 |
| Pizza Back Kiez | `0x2977052E8BCf3c2797CD191ac79DA11f70Ca0630` | 318.50 |
| Café Fleurs | `0xeFD6406538b01dF95D4279A5271AF6c8DFa32686` | 287.66 |
| Café Filou | `0x869C748586eFc236A8bE86D162167b105cc7e9c0` | 208.22 |
| Smooches Sandwiches | `0x5Eb55c58f1b1708Bd1aCD85c36D4e434aC12ABd4` | 199.37 |
| YiLa Nudel | `0x2A5B07Df2A63193C0d7E7BdC1c1353A836dcA7eA` | 198.65 |
| Filmkunstbar Fitzcarraldo | `0xd06Dc92f099ECAc2A5FAF27666f433E3A4059f46` | 159.94 |
| Barkin Kitchen | `0x49a0d31ba28631AeaA52aCA1E03F5aF172Bc0e44` | 129.13 |
| Adore | `0x553b06464fC6B2B4594f50356F4458E6F8B730bB` | 95.86 |
| Matreshka | `0x05A30c4cDE21D6A23CE7114Fb07EdcAf112EF90f` | 39.79 |

## Caveats

- These are snapshots: the web build served on 7 Oct 2026 and Android 1.0.5 (34). The Android app takes
  Expo OTA updates, so its JavaScript can change without a store release. The iOS build was not examined.
- The backend is closed. Anything said about it (permits, the email lookup, till custody, splits) comes
  from what the clients send and receive, and from the merchant-facing text.
- Hermes decompilation is lower fidelity than the web build. Every Android-only claim (`sendKreuzer`, the
  email recipient, the device key store) rests on surviving function names, string literals and the call
  arguments shown above, and agrees with the web build and the chain where they overlap.
- The Android XAPK came from a third-party mirror. Its version matches the Play Store listing, but its
  signature was not checked against Google Play.

## Reproduce

```sh
scripts/fetch-web-build.sh            # -> work/web/pretty/{3339…,7406…}.js
scripts/fetch-android-app.sh          # -> work/android/decompiled.js (needs python3; ~105 MB download)
npm install && npm run --silent onchain > evidence/onchain-snapshot.json
```

Useful anchors in the decompiled code: `[kiez:wallet]`, `[kiez:delete]`, `[kiez:backup]`,
`[kiez:restore]`, `sendKreuzer`, `toTill`, `closeAccount`, `membershipPermit`, `kiez-offer:`, and the FAQ
strings (`What are Kreuzer?`).
