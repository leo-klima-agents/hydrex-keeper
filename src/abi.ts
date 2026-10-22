import { parseAbi } from "viem";

export const moduleAbi = parseAbi([
  "function CONDUIT() view returns (address)",
  "function KEEPER() view returns (address)",
  "function vote(address[] pools, uint256[] weights)",
  "function claimSwapAndDistribute(uint256 veTokenId, address[] targets, bytes[] swaps, address[] feeAddresses, address[] bribeAddresses, address[] claimTokens, uint256 retireTonnes, uint256 maxKvcmIn)",
  "error NotKeeper()",
  "error ExecutionFailed()",
  // Errors from the conduit and the Voter, which the module passes on.
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EpochFlipInProgress()",
  "error VoteDelayNotMet()",
  "error EpochStale()",
  "error InsufficientVotingPower()",
]);

export const conduitAbi = parseAbi([
  "function voter() view returns (address)",
  "function veToken() view returns (address)",
  "function kvcm() view returns (address)",
  "function distributionTokens(uint256 index) view returns (address)",
  "function isApprovedRouter(address router) view returns (bool)",
  "function retireBps() view returns (uint256)",
  "function retirementAggregator() view returns (address)",
  "function creditToken() view returns (address)",
  "function creditTokenId() view returns (uint256)",
  "function carbonClass() view returns (address)",
  "event ClaimSwapAndDistributeCompleted(uint256 indexed tokenId, address indexed owner, address indexed recipient, address[] claimedTokens, uint256[] claimedAmounts, address[] distributedTokens, uint256[] distributedAmounts, uint256[] treasuryFees)",
  "event CarbonRetired(address indexed creditToken_, uint256 retireTonnes, uint256 kvcmSpent)",
]);

// ImmutableVeTokenConduit, version 2.
export const immutableAbi = parseAbi([
  "function voter() view returns (address)",
  "function veToken() view returns (address)",
  "function vote(address[] pools, uint256[] weights) returns (uint256 oldScore, uint256 newScore)",
  "function currentScore() view returns (uint256)",
  "function poolValue(address pool) view returns (uint256 usd)",
  "function pricedTokens(uint256 index) view returns (address token, address feed, uint256 maxAge, uint256 mul, uint256 div)",
  "function claim(uint256 tokenId, address[] feeAddresses, address[] bribeAddresses, address[] tokens) returns (uint256[] amounts)",
  "function TREASURY() view returns (address)",
  "event VoteAccepted(uint256 indexed epoch, address indexed proposer, address[] pools, uint256[] weights, uint256 oldScore, uint256 newScore)",
  "event Claimed(uint256 indexed tokenId, address indexed owner, address indexed caller, address[] tokens, uint256[] amounts, uint256[] fees, uint256 previousClaimBlock)",
  "error SequencerDown()",
  "error EpochStale()",
  "error NoVotingPower()",
  "error BadPoolCount()",
  "error LengthMismatch()",
  "error ZeroWeight()",
  "error Duplicate(address account)",
  "error ZeroVotes(address pool)",
  "error DeadGauge(address pool)",
  "error NotBetter(uint256 oldScore, uint256 newScore)",
  "error NoRewardContracts()",
  "error TokenCallFailed(address token)",
  "error Reentrancy()",
  // Errors from the Voter, which the conduit passes on.
  "error EpochFlipInProgress()",
  "error VoteDelayNotMet()",
  "error InsufficientVotingPower()",
]);

export const voterAbi = parseAbi([
  "function _epochTimestamp() view returns (uint256)",
  "function length() view returns (uint256)",
  "function pools(uint256 index) view returns (address)",
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
  "function weights(address pool) view returns (uint256)",
  "function external_bribes(address gauge) view returns (address)",
  "function internal_bribes(address gauge) view returns (address)",
  "function votes(address voter, address pool) view returns (uint256)",
  "function poolVote(address voter, uint256 index) view returns (address)",
  "function lastVoted(address voter) view returns (uint256)",
]);

export const veAbi = parseAbi([
  "function getPastVotes(address account, uint256 timestamp) view returns (uint256)",
  "function totalNftsMinted() view returns (uint256)",
  "function delegates(uint256 tokenId, uint48 timestamp) view returns (address)",
  "function balanceOfNFTAt(uint256 tokenId, uint256 timestamp) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedClaimRedirectOrOwner(address operator, uint256 tokenId) view returns (bool)",
  "struct Point { int128 bias; int128 slope; int128 permanent; }",
  "function getFirstEscrowPoint(uint256 tokenId) view returns (Point point, uint48 timestamp)",
]);

export const bribeAbi = parseAbi([
  "function rewardsListLength() view returns (uint256)",
  "function rewardTokens(uint256 index) view returns (address)",
  "function rewardData(address token, uint256 epoch) view returns (uint256 periodFinish, uint256 rewardsPerEpoch, uint256 lastUpdateTime)",
  "function balanceOfOwnerAt(address owner, uint256 epoch) view returns (uint256)",
  "function earned(uint256 tokenId, address token) view returns (uint256)",
  "function earnedTokenId(uint256 tokenId, address token, uint48 timestamp) view returns (uint256)",
  "function tokenTimestamp(uint256 tokenId, address token) view returns (uint256)",
  "function firstBribeTimestamp() view returns (uint256)",
]);

// Safe's AllowanceModule, version 1.0.0.
export const allowanceAbi = parseAbi([
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
  "function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
]);

export const safeAbi = parseAbi(["function isModuleEnabled(address module) view returns (bool)"]);

export const uniswapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

export const uniswapQuoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const aeroRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

export const aeroQuoterAbi = parseAbi([
  "function quoteExactInputSingleV3(address pool, address tokenIn, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)",
]);

export const retirementAbi = parseAbi([
  "function quoteRetireCreditViaKlima(address creditToken, uint256 tokenId, uint256 amount, address inputToken, address carbonClass, uint256 couponTonnes) view returns (uint256 tonnes, uint256 price, uint256, uint256)",
]);

export const kyberAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
]);
