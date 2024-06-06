// SPDX-License-Identifier: MIT

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

pragma solidity >=0.8.2 <0.9.0;

error ArrayLengthMismatch();
error SeasonNotTradeable();
error CollectiveNotDistributed();
error ZeroAmount();
error InsufficientVotes();
error Slippage();

contract BG_Beta is OwnableUpgradeable, AccessControlUpgradeable {
  using SafeERC20 for IERC20;

  // This role transfers votes from one user to another, as a part of the votes claiming process.
  bytes32 public constant CLAIMER_ROLE = keccak256("CLAIMER_ROLE");
  // This role sets the verification result of collective exit rounds.
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
  // This role sets seasons, winning breakdowns for rounds, collective fanbases.
  bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

  struct Season {
    bool isDistributed;
    // Did Oracle verify the results (exit rounds) for all collectives?
    bool isVerified;
    uint256 startBlock;
    uint256 endBlock;
    uint256 prizePool;
    uint256 distributedPool;
    uint256 roundsN;
    // units: basis pts i.e. 250 = 2.5% or 0.025
    mapping(uint256 => uint256) roundToWinningPercent;
    mapping(address => uint256) collectiveToExitRound;
    // Is collective distributed their winnings?
    mapping(address => bool) isCollectiveDistributed;
  }

  struct SeasonView {
    bool isDistributed;
    bool isVerified;
    uint256 startBlock;
    uint256 endBlock;
    uint256 prizePool;
    uint256 distributedPool;
    uint256 roundsN;
    uint256[] winningBreakdown;
  }

  struct Collective {
    // fanbase name e.g. "North Carolina Tarheels Men’s Basketball"
    string name;
    uint256 supply;
    uint256 burnt;
    mapping(address => uint256) balances;
  }

  struct FullPrice {
    uint256 base;
    uint256 protocolFee;
    uint256 collectiveFee;
    uint256 poolFee;
    uint256 totalFee;
    uint256 total;
    uint256 perVote;
  }

  struct FeeStructure {
    // units: basis points, 300 = 3% or 0.03
    uint256 poolPct;
    uint256 collectivePct;
    uint256 protocolPct;
    address protocolDestination;
  }

  // Is trading (buy/sell) paused?
  bool public txPaused;
  // The accumulated winning pool used for teams payouts
  uint256 public prizePool;
  // The token used for paying for votes
  address public stableCoin;
  FeeStructure public feeStructure;

  mapping(uint256 => Season) public seasons;
  mapping(address => Collective) public collectives;

  uint8 private tokenDecimals;
  uint256 public currentSeason;
  uint256 public curveDenominator;
  // The claimer account for the claimer votes, not counted in supply
  address public claimerAccount;

  event Trade(
    address indexed fan,
    address indexed collective,
    bool isBuy,
    uint256 voteAmount,
    uint256 fanVotes,
    uint256 supply,
    FullPrice price
  );
  event TransferVotes(
    address indexed fan,
    address indexed collective,
    uint256 voteAmount,
    uint256 fanVotes,
    uint256 supply,
    address fanSender
  );
  event Redeem(
    address indexed fan,
    address indexed collective,
    uint256 voteAmount,
    uint256 fanVotes,
    uint256 supply,
    uint256 value
  );
  event DistributeCollectiveWinnings(address indexed collective, uint256 value, uint256 exitRound, uint256 winningPct);
  event SetFeeStructure(uint256 poolPct, uint256 collectivePct, uint256 protocolPct, address protocolDestination);
  event DistributeSeason(uint256 season, uint256 prizePool, uint256 distributedPool, uint256 endBlock);
  event SetCollectiveFanbase(address indexed collective, string fanbase);
  event Paused(bool buyAndSell);
  event OracleExitRoundVerified(address indexed collective, uint256 round, uint256 season);
  event OracleWinningsVerified(bool isVerified, uint256 season);
  event IncreasePrizePool(uint256 season, uint256 amount);

  function initialize(uint256 _curveDenominator, address _stableCoin) public initializer {
    __Ownable_init(msg.sender);
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(MANAGER_ROLE, msg.sender);

    curveDenominator = _curveDenominator;
    stableCoin = _stableCoin;
    tokenDecimals = ERC20Upgradeable(stableCoin).decimals();
    txPaused = true;
  }

  modifier activeSeason() {
    Season storage season = seasons[currentSeason];
    if (currentSeason == 0) revert SeasonNotTradeable();
    if (season.isDistributed || season.distributedPool > 0) revert SeasonNotTradeable();
    _;
  }

  /** ----------------- SETTERS ----------------- */

  function setFeeStructure(
    uint256 poolPct,
    uint256 collectivePct,
    uint256 protocolPct,
    address protocolDestination
  ) public onlyOwner {
    require(poolPct + collectivePct + protocolPct < 10000);
    feeStructure.poolPct = poolPct;
    feeStructure.collectivePct = collectivePct;
    feeStructure.protocolPct = protocolPct;
    feeStructure.protocolDestination = protocolDestination;
    emit SetFeeStructure(poolPct, collectivePct, protocolPct, protocolDestination);
  }

  // Increases total pool if funds have been donated/sent directly to contract
  function increasePrizePool(uint256 amount) public {
    prizePool += amount;
    IERC20(stableCoin).safeTransferFrom(msg.sender, address(this), amount);
    emit IncreasePrizePool(currentSeason, amount);
  }

  // TODO: candidate for removal
  function setCollectivesFanbases(
    address[] calldata _collectives,
    string[] calldata fanbases
  ) public onlyRole(MANAGER_ROLE) {
    if (_collectives.length != fanbases.length) revert ArrayLengthMismatch();
    for (uint256 i = 0; i < _collectives.length; i++) {
      address collective = _collectives[i];
      collectives[collective].name = fanbases[i];
      emit SetCollectiveFanbase(collective, fanbases[i]);
    }
  }

  function setTxPause(bool setPause) public onlyOwner {
    txPaused = setPause;
    emit Paused(txPaused);
  }

  // TODO: candidate for removal
  function setStableCoin(address _stableCoin) public onlyOwner {
    stableCoin = _stableCoin;
    tokenDecimals = ERC20Upgradeable(stableCoin).decimals();
  }

  // TODO: candidate for removal
  function setCurve(uint256 _denominator) public onlyOwner {
    curveDenominator = _denominator;
  }

  function setClaimerAccount(address _claimerAccount) public onlyOwner {
    _grantRole(CLAIMER_ROLE, _claimerAccount);
    claimerAccount = _claimerAccount;
  }

  function setSeason(
    uint256 _season,
    uint256 roundsN,
    uint256[] calldata winningBreakdown
  ) public onlyRole(MANAGER_ROLE) {
    require(_season != 0 && _season >= currentSeason, "Can't set zero/previous season");
    require(
      currentSeason == 0 ||
        (_season == currentSeason && !seasons[currentSeason].isDistributed) ||
        (_season > currentSeason && seasons[currentSeason].isDistributed),
      "Only un-distributed or next"
    );
    require(roundsN >= 2, "At least 2 round");
    require(winningBreakdown.length == roundsN + 1, "Winnings must be = roundsN+1");

    Season storage season = seasons[_season];
    currentSeason = _season;
    season.roundsN = roundsN;
    for (uint256 i = 0; i <= roundsN; i++) {
      season.roundToWinningPercent[i] = winningBreakdown[i];
    }

    if (season.startBlock == 0) {
      season.startBlock = block.number;
    }
  }

  function withdrawToken(address token, uint256 amount) public onlyOwner {
    require(feeStructure.protocolDestination != address(0), "Token address is zero");
    IERC20(token).safeTransfer(feeStructure.protocolDestination, amount);
  }

  /** ----------------- GETTERS ----------------- */

  function balanceOf(address fan, address collective) public view returns (uint256) {
    return collectives[collective].balances[fan];
  }

  function seasonNow() public view returns (SeasonView memory) {
    Season storage season = seasons[currentSeason];

    uint256[] memory winningBreakdown = new uint256[](season.roundsN + 1);
    for (uint256 i = 0; i <= season.roundsN; i++) {
      winningBreakdown[i] = season.roundToWinningPercent[i];
    }
    return
      SeasonView({
        isDistributed: season.isDistributed,
        isVerified: season.isVerified,
        startBlock: season.startBlock,
        endBlock: season.endBlock,
        // Until the season is finalized, return the current total pool
        prizePool: season.prizePool == 0 ? prizePool : season.prizePool,
        distributedPool: season.distributedPool,
        roundsN: season.roundsN,
        winningBreakdown: winningBreakdown
      });
  }

  function getBuyPrice(address collective, uint256 amount) public view returns (FullPrice memory) {
    return getTradeFullPrice(collective, amount, true);
  }

  function getSellPrice(address collective, uint256 amount) public view returns (FullPrice memory) {
    return getTradeFullPrice(collective, amount, false);
  }

  function getRedeemPrice(address collective, uint256 amount) public view returns (uint256) {
    Collective storage c = collectives[collective];
    uint256 safeBalance = IERC20(stableCoin).balanceOf(collective);

    uint256 votingPower = (amount * 1e18) / (c.supply - c.burnt - balanceOf(claimerAccount, collective));
    uint256 total = (safeBalance * votingPower) / 1e18;

    return total;
  }

  /** ----------------- ORACLE ----------------- */

  function receiveVerifiedCollectiveExitRound(
    address collective,
    uint256 round
  ) public activeSeason onlyRole(ORACLE_ROLE) {
    seasons[currentSeason].collectiveToExitRound[collective] = round;
    emit OracleExitRoundVerified(collective, round, currentSeason);
  }

  function receiveVerifiedTotalWinnings(bool isVerified) public activeSeason onlyRole(ORACLE_ROLE) {
    seasons[currentSeason].isVerified = isVerified;
    emit OracleWinningsVerified(isVerified, currentSeason);
  }

  /** ----------------- TRADING ----------------- */

  /**
   * @param maxValue: if 0, ignored, otherwise the maximum amount the user is willing to pay for the votes, i.e. the max slippage
   */
  function buyVotes(address collective, uint256 amount, uint256 maxValue) public activeSeason {
    Collective storage c = collectives[collective];
    FullPrice memory fullPrice = getTradeFullPrice(collective, amount, true);
    address fan = msg.sender;

    // Cannot buy while trading is paused, unless the collective is buying their first vote
    if (txPaused && !(fan == collective && c.balances[collective] == 0) && !(fan == claimerAccount))
      revert SeasonNotTradeable();
    if (amount == 0) revert ZeroAmount();
    require(c.supply > 0 || collective == fan, "Collective first buy");
    // Slippage check
    if (maxValue > 0 && fullPrice.total > maxValue) revert Slippage();

    c.supply += amount;
    c.balances[fan] += amount;
    prizePool += fullPrice.poolFee;

    transferToken(fan, address(this), fullPrice.base);
    transferToken(fan, address(this), fullPrice.poolFee);
    transferToken(fan, feeStructure.protocolDestination, fullPrice.protocolFee);
    transferToken(fan, collective, fullPrice.collectiveFee);

    fullPrice.perVote = getPrice(c.supply, 1);
    emit Trade(fan, collective, true, amount, c.balances[fan], c.supply, fullPrice);
  }

  /**
   * @param minValue: the min amount the user is willing to receive for the votes, slippage check
   */
  function sellVotes(address collective, uint256 amount, uint256 minValue) public activeSeason {
    Collective storage c = collectives[collective];
    FullPrice memory fullPrice = getTradeFullPrice(collective, amount, false);
    address fan = msg.sender;

    uint256 activeSupply = c.supply - c.burnt;
    if (txPaused && !(fan == claimerAccount))
      revert SeasonNotTradeable();
    if (amount == 0) revert ZeroAmount();
    // Cannot sell the last vote -- must be held by the collective
    if (amount >= activeSupply) revert InsufficientVotes();
    if (fan == collective && amount >= c.balances[fan]) revert InsufficientVotes();
    if (fan != collective && amount > c.balances[fan]) revert InsufficientVotes();
    if (fullPrice.total < minValue) revert Slippage();

    c.supply -= amount;
    c.balances[fan] -= amount;
    prizePool += fullPrice.poolFee;

    // Send the total value (not base), since it includes the deducted fees
    transferOut(fan, fullPrice.total);
    transferOut(feeStructure.protocolDestination, fullPrice.protocolFee);
    transferOut(collective, fullPrice.collectiveFee);

    fullPrice.perVote = getPrice(c.supply - 1, 1);
    emit Trade(fan, collective, false, amount, c.balances[fan], c.supply, fullPrice);
  }

  function transferVotes(
    address[] calldata _collectives,
    address[] calldata _receivers,
    uint256[] calldata _amounts
  ) public onlyRole(CLAIMER_ROLE) {
    address sender = msg.sender;

    if (_collectives.length != _receivers.length || _collectives.length != _receivers.length)
      revert ArrayLengthMismatch();

    for (uint256 i = 0; i < _collectives.length; i++) {
      _transferVote(sender, _collectives[i], _receivers[i], _amounts[i]);
    }
  }

  function _transferVote(address sender, address collective, address receiver, uint256 amount) internal {
    Collective storage c = collectives[collective];
    if (amount == 0) revert ZeroAmount();
    // If the sender is the collective, they can't transfer their last vote
    if (sender == collective ? amount >= c.balances[sender] : amount > c.balances[sender]) revert InsufficientVotes();

    c.balances[sender] -= amount;
    c.balances[receiver] += amount;

    emit TransferVotes(receiver, collective, amount, c.balances[receiver], c.supply, sender);
  }

  function redeemVotes(address collective, uint256 amount) public {
    Collective storage c = collectives[collective];
    address fan = msg.sender;

    if (currentSeason == 0) revert SeasonNotTradeable();
    if (!seasons[currentSeason].isCollectiveDistributed[collective]) revert CollectiveNotDistributed();
    if (amount == 0) revert ZeroAmount();
    // Cannot redeem ALL votes, always 1 vote must remain (owned by fansCollective)
    if (amount >= c.supply - c.burnt || (fan == collective ? amount >= c.balances[fan] : amount > c.balances[fan]))
      revert InsufficientVotes();

    uint256 value = getRedeemPrice(collective, amount);
    c.balances[fan] -= amount;
    c.burnt += amount;

    // Assuming that the Pool contract is approved to send funds from the Safe, transfer the redeem value
    transferToken(collective, fan, value);

    emit Redeem(fan, collective, amount, c.balances[fan], c.supply - c.burnt, value);
  }

  /** ----------------- WINNINGS ----------------- */

  /**
   * Distribute the winnings to collectives based on their exitRound and round's winning percentage.
   * On the first call for an season, will fixate the Season's prizePool and reset the general pool for the next year.
   */
  function distributeSeasonWinnings(address[] calldata _collectives) public onlyRole(MANAGER_ROLE) {
    Season storage season = seasons[currentSeason];

    if (currentSeason == 0) revert SeasonNotTradeable();
    require(season.isVerified, "Not verified by Oracle");
    require(!season.isDistributed, "Already distributed");

    // At the time of the first distribution, we fixate the prizePool for the season and reset the pool for the next year.
    // The fixed prizePool will be used for the winning distribution calculation.
    if (season.prizePool == 0) {
      season.prizePool = prizePool;
      prizePool = 0;
    }

    // Distribute the share of the total pool to each collective eligible for winnings
    for (uint256 i = 0; i < _collectives.length; i++) {
      address collective = _collectives[i];

      if (season.isCollectiveDistributed[collective]) {
        continue;
      }

      uint256 exitRound = season.collectiveToExitRound[collective];
      uint256 winPercent = season.roundToWinningPercent[exitRound];
      uint256 winPool = getPercent(season.prizePool, winPercent);
      if (winPool == 0) {
        continue;
      }

      season.isCollectiveDistributed[collective] = true;
      season.distributedPool += winPool;
      transferOut(collective, winPool);

      emit DistributeCollectiveWinnings(collective, winPool, exitRound, winPercent);
    }

    // Once we empty the prizePool, the season is distributed
    uint256 diff = season.prizePool > season.distributedPool
      ? season.prizePool - season.distributedPool
      : season.distributedPool - season.prizePool;
    if (season.prizePool == season.distributedPool || diff < 10) {
      season.isDistributed = true;
      season.endBlock = block.number;
      emit DistributeSeason(currentSeason, season.prizePool, season.distributedPool, season.endBlock);
    }
  }

  function getPercent(uint256 total, uint256 percent) internal pure returns (uint256) {
    return (total * percent) / 10000;
  }

  function transferToken(address sender, address receiver, uint256 amount) internal {
    IERC20(stableCoin).safeTransferFrom(sender, receiver, amount);
  }

  function transferOut(address receiver, uint256 amount) internal {
    IERC20(stableCoin).safeTransfer(receiver, amount);
  }

  // Get the curve price for the amount based on the supply
  function getPrice(uint256 supply, uint256 amount) internal view returns (uint256) {
    // Calculate the price of the first and last tokens in the new range
    uint256 firstTerm = ((supply + 1) * 10 ** tokenDecimals) / curveDenominator;
    uint256 lastTerm = ((supply + amount) * 10 ** tokenDecimals) / curveDenominator;

    // Calculate the sum of the arithmetic series
    uint256 sum = (amount * (firstTerm + lastTerm)) / 2;

    return sum;
  }

  function getTradeFullPrice(address collective, uint256 amount, bool isBuy) internal view returns (FullPrice memory) {
    Collective storage c = collectives[collective];
    uint256 perVote = getPrice(c.supply, 1);

    if (amount == 0 || (!isBuy && amount > c.supply)) return FullPrice(0, 0, 0, 0, 0, 0, perVote);

    uint256 price = getPrice(isBuy ? c.supply : c.supply - amount, amount);
    FullPrice memory fullPrice = FullPrice(
      price,
      getPercent(price, feeStructure.protocolPct),
      getPercent(price, feeStructure.collectivePct),
      getPercent(price, feeStructure.poolPct),
      0,
      0,
      perVote
    );
    fullPrice.totalFee = fullPrice.protocolFee + fullPrice.collectiveFee + fullPrice.poolFee;
    fullPrice.total = isBuy ? fullPrice.base + fullPrice.totalFee : fullPrice.base - fullPrice.totalFee;

    return fullPrice;
  }
}
