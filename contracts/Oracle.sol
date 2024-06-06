// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

// Oracle will be pushing data to the pool contract
interface Oracle {
  function verifyCollectiveExitRound(address pool, address collective, uint256 round) external;
  function verifySeasonWinnings(address pool, address collective) external;
}
