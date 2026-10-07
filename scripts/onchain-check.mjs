// Reproduces the on-chain facts quoted in README.md.
//
//   npm install
//   npm run --silent onchain > evidence/onchain-snapshot.json
//
// Behind an HTTPS proxy on Node >= 22.21, run with NODE_USE_ENV_PROXY=1.
// Read-only: it only calls the public Gnosis Chain RPC, the public Circles
// RPC/indexer, and the public (unauthenticated) GET /offers on api.lkl.berlin.

import { createPublicClient, http, parseAbi } from 'viem';
import { gnosis } from 'viem/chains';

const GNOSIS_RPC = 'https://rpc.gnosischain.com';
const CIRCLES_RPC = 'https://rpc.aboutcircles.com/';
const LOKAL_API = 'https://api.lkl.berlin';

// Addresses hard-coded in the lokal clients (web build and Android 1.0.5).
const HUB = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const ECONOMY = {
  group: '0x75b812a7bFb0a3580b32CaF2A2C201D6e0FaC5b3',
  erc20: '0xD433FDB8861E86a827C25740B07452EcDca30A67',
  groupService: '0x488CBD83f514aa1605e59d4e51bd36427a25E69B',
  autoInviteBot: '0x5633eE2D9F5DB44C1658F71543CfF22BCD8f971A',
};
const INVITATION_MODULE = '0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5';
const LEGACY_INVITE_BOT = '0x20ec0a8a5e2209097df0a30f47106cdf3a2443a6';
const SENTINEL = '0x0000000000000000000000000000000000000001';

const client = createPublicClient({ chain: gnosis, transport: http(GNOSIS_RPC) });

const hubAbi = parseAbi([
  'function balanceOf(address,uint256) view returns (uint256)',
  'function totalSupply(uint256) view returns (uint256)',
  'function isHuman(address) view returns (bool)',
  'function isOrganization(address) view returns (bool)',
]);
const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address,uint256) view returns (address[],address)',
]);
const lokalAbi = parseAbi([
  'function owner() view returns (address)',
  'function signer() view returns (address)',
  'function service() view returns (address)',
  'function group() view returns (address)',
  'function farm() view returns (address)',
  'function invitationModule() view returns (address)',
  'function quota() view returns (uint256)',
  'function INVITATION_FEE() view returns (uint256)',
  'function MAX_TTL() view returns (uint256)',
]);

async function circles(method, params) {
  const res = await fetch(CIRCLES_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function query(namespace, table, filter, limit = 1000) {
  const r = await circles('circles_query', [
    { Namespace: namespace, Table: table, Columns: [], Filter: filter, Order: [], Limit: limit },
  ]);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

const eq = (Column, Value) => ({ Type: 'FilterPredicate', FilterType: 'Equals', Column, Value });
const isIn = (Column, Value) => ({ Type: 'FilterPredicate', FilterType: 'In', Column, Value });
const lc = (a) => a.toLowerCase();
const crc = (wei) => Number(wei) / 1e18;
const read = (address, abi, functionName, args = []) =>
  client.readContract({ address, abi, functionName, args });

async function chunked(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

const G = lc(ECONOMY.group);
const BOT = lc(ECONOMY.autoInviteBot);

// 1. The group as the Circles indexer sees it.
const [group] = await query('V_CrcV2', 'Groups', [eq('group', G)]);
const [groupProfile] = await circles('circles_getProfileByAddressBatch', [[G]]);

// 2. Members = avatars the group trusts (that is what group membership is in Circles v2).
const memberRows = await query('V_CrcV2', 'TrustRelations', [eq('truster', G)], 5000);
const members = memberRows.map((r) => r.trustee);
const memberSet = new Set(members);

// 3. Whom do members trust, and who trusts them?
const outgoing = await chunked(members, 50, (m) =>
  query('V_CrcV2', 'TrustRelations', [isIn('truster', m)], 5000),
);
const outgoingNonSelf = outgoing.filter((r) => r.truster !== r.trustee);
const incoming = await chunked(members, 50, (m) =>
  query('V_CrcV2', 'TrustRelations', [isIn('trustee', m)], 5000),
);
const incomingByTruster = {};
for (const r of incoming) {
  if (r.truster === r.trustee) continue;
  incomingByTruster[r.truster] = (incomingByTruster[r.truster] ?? 0) + 1;
}
const trustingTheGroup = await query('V_CrcV2', 'TrustRelations', [eq('trustee', G)]);

// 4. How members were registered (RegisterHuman.inviter).
const registrations = await chunked(members, 50, (m) =>
  query('CrcV2', 'RegisterHuman', [isIn('avatar', m)], 5000),
);
const distinctInviters = new Set(registrations.map((r) => r.inviter));

// 5. Profiles: are members publicly named?
const profiles = await circles('circles_getProfileByAddressBatch', [members]);
const named = profiles.filter((p) => p?.name).map((p) => p.name);

// 6. Owners and modules of every member Safe.
const safes = [];
for (const m of members) {
  try {
    const [owners, threshold, [modules]] = await Promise.all([
      read(m, safeAbi, 'getOwners'),
      read(m, safeAbi, 'getThreshold'),
      read(m, safeAbi, 'getModulesPaginated', [SENTINEL, 10n]),
    ]);
    safes.push({ safe: m, owners, threshold: Number(threshold), modules });
  } catch {
    safes.push({ safe: m, error: 'not a Safe' });
  }
}
const ownerCodeless = [];
for (const s of safes.slice(0, 25)) {
  for (const o of s.owners ?? []) ownerCodeless.push(!(await client.getCode({ address: o })));
}
const moduleSets = {};
for (const s of safes) {
  const k = (s.modules ?? []).map(lc).sort().join(',');
  moduleSets[k] = (moduleSets[k] ?? 0) + 1;
}

// 7. Lokal's contracts.
const bot = {
  address: ECONOMY.autoInviteBot,
  owner: await read(ECONOMY.autoInviteBot, lokalAbi, 'owner'),
  permitSigner: await read(ECONOMY.autoInviteBot, lokalAbi, 'signer'),
  farm: await read(ECONOMY.autoInviteBot, lokalAbi, 'farm'),
  invitationModule: await read(ECONOMY.autoInviteBot, lokalAbi, 'invitationModule'),
  remainingInviteQuota: Number(await read(ECONOMY.autoInviteBot, lokalAbi, 'quota')),
  invitationFeeCrc: crc(await read(ECONOMY.autoInviteBot, lokalAbi, 'INVITATION_FEE')),
  permitMaxTtlSeconds: Number(await read(ECONOMY.autoInviteBot, lokalAbi, 'MAX_TTL')),
  isCirclesHuman: await read(HUB, hubAbi, 'isHuman', [ECONOMY.autoInviteBot]),
};
const legacyBot = {
  address: LEGACY_INVITE_BOT,
  owner: await read(LEGACY_INVITE_BOT, lokalAbi, 'owner'),
  remainingInviteQuota: Number(await read(LEGACY_INVITE_BOT, lokalAbi, 'quota')),
};
const groupService = {
  address: ECONOMY.groupService,
  group: await read(ECONOMY.groupService, lokalAbi, 'group'),
  permitSigner: await read(ECONOMY.groupService, lokalAbi, 'signer'),
  permitMaxTtlSeconds: Number(await read(ECONOMY.groupService, lokalAbi, 'MAX_TTL')),
};

// 8. Shop tills: where redeemed Kreuzer go.
const offers = await (await fetch(`${LOKAL_API}/offers?kiezId=kreuzberg`)).json();
const tills = {};
for (const o of offers) if (o.shop?.orgAddress) tills[o.shop.orgAddress] = o.shop.name;
const tillRows = [];
for (const [address, shop] of Object.entries(tills)) {
  const [kiez0, human, org, code] = await Promise.all([
    read(HUB, hubAbi, 'balanceOf', [address, BigInt(ECONOMY.group)]),
    read(HUB, hubAbi, 'isHuman', [address]),
    read(HUB, hubAbi, 'isOrganization', [address]),
    client.getCode({ address }),
  ]);
  tillRows.push({ shop, address, kiez0: crc(kiez0), circlesHuman: human, circlesOrg: org, isContract: !!code });
}
const kiez0Supply = crc(await read(HUB, hubAbi, 'totalSupply', [BigInt(ECONOMY.group)]));

const block = await client.getBlock();
console.log(
  JSON.stringify(
    {
      takenAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      block: Number(block.number),
      group: { ...group, profile: groupProfile },
      groupsTrustedBy: trustingTheGroup.map((r) => r.truster),
      members: {
        count: members.length,
        nonSelfOutgoingTrusts: outgoingNonSelf.length,
        nonSelfOutgoingTrustsToOtherMembers: outgoingNonSelf.filter((r) => memberSet.has(r.trustee)).length,
        incomingTrustByTruster: incomingByTruster,
        distinctRegisterHumanInviters: distinctInviters.size,
        publiclyNamedProfiles: named,
      },
      safes: {
        count: safes.length,
        thresholdOne: safes.filter((s) => s.threshold === 1).length,
        ownedOnlyByDeadAddress: safes.filter(
          (s) => s.owners?.length === 1 && lc(s.owners[0]) === '0x000000000000000000000000000000000000dead',
        ).length,
        ownersAreEoasInFirst25: ownerCodeless.every(Boolean),
        moduleSets,
      },
      autoInviteBot: bot,
      legacyAutoInviteBot: legacyBot,
      groupService,
      invitationModule: INVITATION_MODULE,
      tills: tillRows,
      kiez0: {
        totalSupply: kiez0Supply,
        heldByTills: tillRows.reduce((a, t) => a + t.kiez0, 0),
      },
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
