import { parseAbi } from "viem";

// Only the members the keeper uses. Sources: hydrex-conduit-executor (module),
// KlimaVeTokenConduit and Hydrex VoterV5 / BribeV2 / VotingEscrow on Base.
export const moduleAbi = parseAbi([
  "function CONDUIT() view returns (address)",
  "function KEEPER() view returns (address)",
  "function vote(address[] pools, uint256[] weights)",
  "error ZeroAddress()",
  "error NotAContract()",
  "error NotKeeper()",
  "error ExecutionFailed()",
]);

export const conduitAbi = parseAbi([
  "function voter() view returns (address)",
  "function veToken() view returns (address)",
]);

export const voterAbi = parseAbi([
  "function _epochTimestamp() view returns (uint256)",
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
  "function weights(address pool) view returns (uint256)",
  "function external_bribes(address gauge) view returns (address)",
  "function internal_bribes(address gauge) view returns (address)",
  "function votes(address voter, address pool) view returns (uint256)",
  "function poolVoteLength(address voter) view returns (uint256)",
  "function poolVote(address voter, uint256 index) view returns (address)",
  "function lastVoted(address voter) view returns (uint256)",
  "error EpochFlipInProgress()",
  "error VoteDelayNotMet()",
  "error EpochStale()",
  "error LengthMismatch()",
  "error VotedAlready()",
  "error InsufficientVotingPower()",
]);

export const veAbi = parseAbi(["function getPastVotes(address account, uint256 timestamp) view returns (uint256)"]);

export const bribeAbi = parseAbi([
  "function rewardsListLength() view returns (uint256)",
  "function rewardTokens(uint256 index) view returns (address)",
  "function rewardData(address token, uint256 epoch) view returns (uint256 periodFinish, uint256 rewardsPerEpoch, uint256 lastUpdateTime)",
]);

export const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);
