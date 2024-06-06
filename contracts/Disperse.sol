// SPDX-License-Identifier: MIT
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

pragma solidity >=0.8.2 <0.9.0;

contract Disperse {
  function disperseEther(address payable[] calldata recipients, uint256[] calldata values) external payable {
    for (uint256 i = 0; i < recipients.length; i++) {
      (bool sent, ) = payable(recipients[i]).call{value: values[i]}("");
      require(sent == true);
    }
    uint256 balance = address(this).balance;
    if (balance > 0) payable(msg.sender).transfer(balance);
  }

  function disperseToken(IERC20 token, address payable[] calldata recipients, uint256[] calldata values) external {
    uint256 total = 0;
    for (uint256 i = 0; i < recipients.length; i++) total += values[i];
    require(token.transferFrom(msg.sender, address(this), total));
    for (uint256 i = 0; i < recipients.length; i++) require(token.transfer(recipients[i], values[i]));
  }

  function disperseTokenSimple(
    IERC20 token,
    address payable[] calldata recipients,
    uint256[] calldata values
  ) external {
    for (uint256 i = 0; i < recipients.length; i++) require(token.transferFrom(msg.sender, recipients[i], values[i]));
  }
}
